import { appendArtifacts, listArtifacts, replaceArtifacts } from "./artifacts";
import { caseInsensitiveLike, type StoreContext, type StoreValue } from "./context";
import {
  emptyToNull,
  encodeJson,
  isoNow,
  limit,
  mapNote,
  workspaceOf,
  type NoteRow,
} from "./mappers";
import { inbox } from "./messages";
import { listTasks } from "./tasks";
import type { NoteRecord, ReadNotesOptions, WriteNoteInput } from "./types";

export async function writeNote(ctx: StoreContext, input: WriteNoteInput): Promise<NoteRecord> {
  const workspace = workspaceOf(input.workspace);
  const now = isoNow();
  const id = input.noteId?.trim() || crypto.randomUUID();
  const existing = input.noteId ? await getNote(ctx, id) : null;
  if (existing && existing.workspace !== workspace) {
    throw new Error(`Note '${id}' is not in workspace '${workspace}'.`);
  }
  await ctx.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO notes
         (id, workspace, channel, title, body, pinned, creator_id, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workspace = excluded.workspace,
         channel = excluded.channel,
         title = excluded.title,
         body = excluded.body,
         pinned = excluded.pinned,
         metadata = excluded.metadata,
         updated_at = excluded.updated_at`,
      [
        id,
        workspace,
        emptyToNull(input.channel),
        input.title,
        input.body,
        input.pinned ? 1 : 0,
        input.agentId,
        encodeJson(input.metadata ?? {}),
        now,
        now,
      ],
    );
    const incoming = input.artifacts ?? [];
    if (existing && input.replaceArtifacts !== true) {
      // Update defaults to append: preserve existing artifacts and add new
      // ones, deduplicated by identity. Callers that want full replace must
      // opt in with replaceArtifacts: true.
      await appendArtifacts(tx, "note", id, incoming);
    } else {
      // Create, or explicit full-replace on update.
      await replaceArtifacts(tx, "note", id, incoming);
    }
  });

  const note = await getNote(ctx, id);
  if (!note) {
    throw new Error(`Failed to write note '${id}'.`);
  }
  return note;
}

export async function readNotes(
  ctx: StoreContext,
  options: ReadNotesOptions = {},
): Promise<NoteRecord[]> {
  const workspace = workspaceOf(options.workspace);
  const clauses = ["workspace = ?"];
  const params: StoreValue[] = [workspace];

  if (options.channel) {
    clauses.push("channel = ?");
    params.push(options.channel);
  }
  if (options.pinnedOnly) {
    clauses.push("pinned = 1");
  }
  if (options.query) {
    clauses.push(`(${caseInsensitiveLike(ctx, "title")} OR ${caseInsensitiveLike(ctx, "body")})`);
    params.push(`%${options.query}%`, `%${options.query}%`);
  }

  params.push(limit(options.limit));
  const rows = await ctx.all<NoteRow>(
    `SELECT * FROM notes
     WHERE ${clauses.join(" AND ")}
     ORDER BY pinned DESC, updated_at DESC
     LIMIT ?`,
    params,
  );
  return Promise.all(rows.map((row) => noteWithRelations(ctx, row)));
}

export async function listAllNotes(
  ctx: StoreContext,
  options: Omit<ReadNotesOptions, "workspace" | "channel" | "query"> = {},
): Promise<NoteRecord[]> {
  const clauses: string[] = [];
  const params: StoreValue[] = [];
  if (options.pinnedOnly) {
    clauses.push("pinned = 1");
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit(options.limit));
  const rows = await ctx.all<NoteRow>(
    `SELECT * FROM notes
     ${where}
     ORDER BY pinned DESC, updated_at DESC
     LIMIT ?`,
    params,
  );
  return Promise.all(rows.map((row) => noteWithRelations(ctx, row)));
}

export async function pinNote(
  ctx: StoreContext,
  noteId: string,
  pinned: boolean,
  workspace?: string,
): Promise<NoteRecord> {
  const scope = workspaceOf(workspace);
  const existing = await getNote(ctx, noteId);
  if (!existing) {
    throw new Error(`Note '${noteId}' does not exist.`);
  }
  if (existing.workspace !== scope) {
    throw new Error(`Note '${noteId}' is not in workspace '${scope}'.`);
  }
  await ctx.run(`UPDATE notes SET pinned = ?, updated_at = ? WHERE id = ?`, [
    pinned ? 1 : 0,
    isoNow(),
    noteId,
  ]);
  const note = await getNote(ctx, noteId);
  if (!note) {
    throw new Error(`Note '${noteId}' does not exist.`);
  }
  return note;
}

export async function summarizeChannel(
  ctx: StoreContext,
  agentId: string,
  workspace?: string,
  channel?: string,
): Promise<Record<string, unknown>> {
  const scope = workspaceOf(workspace);
  const [messages, tasks, notes] = await Promise.all([
    inbox(ctx, agentId, { workspace: scope, channel, includeSent: true, limit: 20 }),
    listTasks(ctx, agentId, { workspace: scope, channel, limit: 20 }),
    readNotes(ctx, { workspace: scope, channel, limit: 20 }),
  ]);
  return {
    workspace: scope,
    channel: channel ?? null,
    message_count: messages.length,
    task_count: tasks.length,
    note_count: notes.length,
    recent_messages: messages.slice(0, 5),
    open_tasks: tasks.filter((task) => task.status === "open" || task.status === "claimed"),
    pinned_notes: notes.filter((note) => note.pinned),
  };
}

export async function getNote(ctx: StoreContext, noteId: string): Promise<NoteRecord | null> {
  const row = await ctx.get<NoteRow>(`SELECT * FROM notes WHERE id = ?`, [noteId]);
  return row ? noteWithRelations(ctx, row) : null;
}

export async function noteWithRelations(
  ctx: Pick<StoreContext, "all">,
  row: NoteRow,
): Promise<NoteRecord> {
  return {
    ...mapNote(row),
    artifacts: await listArtifacts(ctx, "note", row.id),
  };
}
