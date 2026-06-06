import type { SQLQueryBindings } from "bun:sqlite";
import { listArtifacts, replaceArtifacts } from "./artifacts";
import type { StoreContext } from "./context";
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

export function writeNote(ctx: StoreContext, input: WriteNoteInput): NoteRecord {
  const workspace = workspaceOf(input.workspace);
  const now = isoNow();
  const id = input.noteId?.trim() || crypto.randomUUID();
  const existing = input.noteId ? getNote(ctx, id) : null;
  if (existing && existing.workspace !== workspace) {
    throw new Error(`Note '${id}' is not in workspace '${workspace}'.`);
  }
  ctx.exec("BEGIN IMMEDIATE");
  try {
    ctx.run(
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
    replaceArtifacts(ctx, "note", id, input.artifacts ?? []);
    ctx.exec("COMMIT");
  } catch (error) {
    ctx.exec("ROLLBACK");
    throw error;
  }

  const note = getNote(ctx, id);
  if (!note) {
    throw new Error(`Failed to write note '${id}'.`);
  }
  return note;
}

export function readNotes(ctx: StoreContext, options: ReadNotesOptions = {}): NoteRecord[] {
  const workspace = workspaceOf(options.workspace);
  const clauses = ["workspace = ?"];
  const params: SQLQueryBindings[] = [workspace];

  if (options.channel) {
    clauses.push("channel = ?");
    params.push(options.channel);
  }
  if (options.pinnedOnly) {
    clauses.push("pinned = 1");
  }
  if (options.query) {
    clauses.push("(title LIKE ? COLLATE NOCASE OR body LIKE ? COLLATE NOCASE)");
    params.push(`%${options.query}%`, `%${options.query}%`);
  }

  params.push(limit(options.limit));
  return ctx.all<NoteRow>(
    `SELECT * FROM notes
     WHERE ${clauses.join(" AND ")}
     ORDER BY pinned DESC, updated_at DESC
     LIMIT ?`,
    params,
  ).map((row) => noteWithRelations(ctx, row));
}

export function listAllNotes(
  ctx: StoreContext,
  options: Omit<ReadNotesOptions, "workspace" | "channel" | "query"> = {},
): NoteRecord[] {
  const clauses: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (options.pinnedOnly) {
    clauses.push("pinned = 1");
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit(options.limit));
  return ctx.all<NoteRow>(
    `SELECT * FROM notes
     ${where}
     ORDER BY pinned DESC, updated_at DESC
     LIMIT ?`,
    params,
  ).map((row) => noteWithRelations(ctx, row));
}

export function pinNote(
  ctx: StoreContext,
  noteId: string,
  pinned: boolean,
  workspace?: string,
): NoteRecord {
  const scope = workspaceOf(workspace);
  const existing = getNote(ctx, noteId);
  if (!existing) {
    throw new Error(`Note '${noteId}' does not exist.`);
  }
  if (existing.workspace !== scope) {
    throw new Error(`Note '${noteId}' is not in workspace '${scope}'.`);
  }
  ctx.run(`UPDATE notes SET pinned = ?, updated_at = ? WHERE id = ?`, [
    pinned ? 1 : 0,
    isoNow(),
    noteId,
  ]);
  const note = getNote(ctx, noteId);
  if (!note) {
    throw new Error(`Note '${noteId}' does not exist.`);
  }
  return note;
}

export function summarizeChannel(
  ctx: StoreContext,
  agentId: string,
  workspace?: string,
  channel?: string,
): Record<string, unknown> {
  const scope = workspaceOf(workspace);
  const messages = inbox(ctx, agentId, { workspace: scope, channel, includeSent: true, limit: 20 });
  const tasks = listTasks(ctx, agentId, { workspace: scope, channel, limit: 20 });
  const notes = readNotes(ctx, { workspace: scope, channel, limit: 20 });
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

export function getNote(ctx: StoreContext, noteId: string): NoteRecord | null {
  const row = ctx.get<NoteRow>(`SELECT * FROM notes WHERE id = ?`, [noteId]);
  return row ? noteWithRelations(ctx, row) : null;
}

export function noteWithRelations(ctx: Pick<StoreContext, "all">, row: NoteRow): NoteRecord {
  return {
    ...mapNote(row),
    artifacts: listArtifacts(ctx, "note", row.id),
  };
}
