import type { SQLQueryBindings } from "bun:sqlite";
import { mapArtifact, type ArtifactRow } from "./mappers";
import { emptyToNull, encodeJson, isoNow, workspaceOf } from "./mappers";
import type { StoreContext } from "./context";
import { visibleMessageClause, visibleTaskClause } from "./context";
import type {
  ArtifactInput,
  ArtifactOwnerType,
  ArtifactRecord,
} from "./types";

export function listVisibleArtifacts(
  ctx: StoreContext,
  agentId: string,
  workspace: string | undefined,
  ownerType: ArtifactOwnerType,
  ownerId: string,
): ArtifactRecord[] {
  const scope = workspaceOf(workspace);
  if (!canReadArtifactOwner(ctx, agentId, scope, ownerType, ownerId)) {
    throw new Error(`${ownerType} '${ownerId}' is not visible to agent '${agentId}'.`);
  }
  return listArtifacts(ctx, ownerType, ownerId);
}

export function listArtifacts(
  ctx: Pick<StoreContext, "all">,
  ownerType: ArtifactOwnerType,
  ownerId: string,
): ArtifactRecord[] {
  return ctx.all<ArtifactRow>(
    `SELECT * FROM artifacts
     WHERE owner_type = ? AND owner_id = ?
     ORDER BY created_at ASC`,
    [ownerType, ownerId],
  ).map(mapArtifact);
}

export function replaceArtifacts(
  ctx: Pick<StoreContext, "run">,
  ownerType: ArtifactOwnerType,
  ownerId: string,
  artifacts: ArtifactInput[],
): void {
  ctx.run(`DELETE FROM artifacts WHERE owner_type = ? AND owner_id = ?`, [ownerType, ownerId]);
  insertArtifacts(ctx, ownerType, ownerId, artifacts);
}

export function insertArtifacts(
  ctx: Pick<StoreContext, "run">,
  ownerType: ArtifactOwnerType,
  ownerId: string,
  artifacts: ArtifactInput[],
): void {
  for (const artifact of artifacts) {
    ctx.run(
      `INSERT INTO artifacts
         (id, owner_type, owner_id, type, label, path, url, line, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        ownerType,
        ownerId,
        artifact.type,
        emptyToNull(artifact.label),
        emptyToNull(artifact.path),
        emptyToNull(artifact.url),
        artifact.line ?? null,
        encodeJson(artifact.metadata ?? {}),
        isoNow(),
      ],
    );
  }
}

function canReadArtifactOwner(
  ctx: StoreContext,
  agentId: string,
  workspace: string,
  ownerType: ArtifactOwnerType,
  ownerId: string,
): boolean {
  if (ownerType === "message") {
    return Boolean(
      ctx.get(
        `SELECT m.id
         FROM messages m
         WHERE m.id = ? AND ${visibleMessageClause(true)}`,
        [ownerId, workspace, agentId, agentId] as SQLQueryBindings[],
      ),
    );
  }
  if (ownerType === "task") {
    return Boolean(
      ctx.get(
        `SELECT id
         FROM tasks
         WHERE id = ? AND workspace = ? AND ${visibleTaskClause()}`,
        [ownerId, workspace, agentId, agentId],
      ),
    );
  }
  return Boolean(
    ctx.get(`SELECT id FROM notes WHERE id = ? AND workspace = ?`, [ownerId, workspace]),
  );
}
