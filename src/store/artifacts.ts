import { mapArtifact, type ArtifactRow } from "./mappers";
import { emptyToNull, encodeJson, isoNow, workspaceOf } from "./mappers";
import type { StoreContext } from "./context";
import { visibleMessageClause, visibleTaskClause } from "./context";
import type {
  ArtifactInput,
  ArtifactOwnerType,
  ArtifactRecord,
} from "./types";

export async function listVisibleArtifacts(
  ctx: StoreContext,
  agentId: string,
  workspace: string | undefined,
  ownerType: ArtifactOwnerType,
  ownerId: string,
): Promise<ArtifactRecord[]> {
  const scope = workspaceOf(workspace);
  if (!(await canReadArtifactOwner(ctx, agentId, scope, ownerType, ownerId))) {
    throw new Error(`${ownerType} '${ownerId}' is not visible to agent '${agentId}'.`);
  }
  return listArtifacts(ctx, ownerType, ownerId);
}

export async function getVisibleArtifact(
  ctx: StoreContext,
  agentId: string,
  workspace: string | undefined,
  ownerType: ArtifactOwnerType,
  ownerId: string,
  artifactId: string,
): Promise<ArtifactRecord> {
  const artifacts = await listVisibleArtifacts(ctx, agentId, workspace, ownerType, ownerId);
  const artifact = artifacts.find((item) => item.id === artifactId);
  if (!artifact) {
    throw new Error(`Artifact '${artifactId}' is not attached to ${ownerType} '${ownerId}'.`);
  }
  return artifact;
}

export async function addVisibleArtifact(
  ctx: StoreContext,
  agentId: string,
  workspace: string | undefined,
  ownerType: ArtifactOwnerType,
  ownerId: string,
  artifact: ArtifactInput,
  artifactId?: string,
): Promise<ArtifactRecord> {
  const scope = workspaceOf(workspace);
  if (!(await canReadArtifactOwner(ctx, agentId, scope, ownerType, ownerId))) {
    throw new Error(`${ownerType} '${ownerId}' is not visible to agent '${agentId}'.`);
  }
  return insertArtifact(ctx, ownerType, ownerId, artifact, artifactId);
}

export async function listArtifacts(
  ctx: Pick<StoreContext, "all">,
  ownerType: ArtifactOwnerType,
  ownerId: string,
): Promise<ArtifactRecord[]> {
  return (await ctx.all<ArtifactRow>(
    `SELECT * FROM artifacts
     WHERE owner_type = ? AND owner_id = ?
     ORDER BY created_at ASC`,
    [ownerType, ownerId],
  )).map(mapArtifact);
}

export async function replaceArtifacts(
  ctx: Pick<StoreContext, "get" | "run">,
  ownerType: ArtifactOwnerType,
  ownerId: string,
  artifacts: ArtifactInput[],
): Promise<void> {
  await ctx.run(`DELETE FROM artifacts WHERE owner_type = ? AND owner_id = ?`, [ownerType, ownerId]);
  await insertArtifacts(ctx, ownerType, ownerId, artifacts);
}

export async function insertArtifacts(
  ctx: Pick<StoreContext, "get" | "run">,
  ownerType: ArtifactOwnerType,
  ownerId: string,
  artifacts: ArtifactInput[],
): Promise<void> {
  for (const artifact of artifacts) {
    await insertArtifact(ctx, ownerType, ownerId, artifact);
  }
}

export async function insertArtifact(
  ctx: Pick<StoreContext, "run" | "get">,
  ownerType: ArtifactOwnerType,
  ownerId: string,
  artifact: ArtifactInput,
  id: string = crypto.randomUUID(),
): Promise<ArtifactRecord> {
  await ctx.run(
    `INSERT INTO artifacts
       (id, owner_type, owner_id, type, label, path, url, line, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
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
  const row = await ctx.get<ArtifactRow>(`SELECT * FROM artifacts WHERE id = ?`, [id]);
  if (!row) {
    throw new Error(`Failed to create artifact '${id}'.`);
  }
  return mapArtifact(row);
}

async function canReadArtifactOwner(
  ctx: StoreContext,
  agentId: string,
  workspace: string,
  ownerType: ArtifactOwnerType,
  ownerId: string,
): Promise<boolean> {
  if (ownerType === "message") {
    return Boolean(
      await ctx.get(
        `SELECT m.id
         FROM messages m
         WHERE m.id = ? AND ${visibleMessageClause(true)}`,
        [ownerId, workspace, agentId, agentId],
      ),
    );
  }
  if (ownerType === "task") {
    return Boolean(
      await ctx.get(
        `SELECT id
         FROM tasks
         WHERE id = ? AND workspace = ? AND ${visibleTaskClause()}`,
        [ownerId, workspace, agentId, agentId],
      ),
    );
  }
  return Boolean(
    await ctx.get(`SELECT id FROM notes WHERE id = ? AND workspace = ?`, [ownerId, workspace]),
  );
}
