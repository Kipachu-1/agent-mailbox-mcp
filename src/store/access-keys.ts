import type { StoreContext } from "./context";
import {
  generateAccessToken,
  isoNow,
  mapAccessKey,
  tokenHash,
  tokenPrefix,
  workspaceOf,
  type AccessKeyRow,
} from "./mappers";
import type { AccessKeyRecord, CreateAccessKeyInput, CreatedAccessKeyRecord } from "./types";

export async function createAccessKey(
  ctx: StoreContext,
  input: CreateAccessKeyInput,
): Promise<CreatedAccessKeyRecord> {
  const now = isoNow();
  const token = input.token?.trim() || generateAccessToken();
  const id = crypto.randomUUID();
  const keyName = input.name.trim();
  const agentId = input.agentId.trim();
  const agentName = input.agentName?.trim() || agentId;
  const workspace = workspaceOf(input.workspace);
  if (!keyName) {
    throw new Error("Access key name is required.");
  }
  if (!agentId) {
    throw new Error("Access key agent id is required.");
  }
  if (!token) {
    throw new Error("Access key token is required.");
  }
  const hash = tokenHash(token);

  await ctx.run(
    `INSERT INTO access_keys
       (id, token_hash, token_prefix, name, agent_id, agent_name, workspace, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(token_hash) DO UPDATE SET
       name = excluded.name,
       agent_id = excluded.agent_id,
       agent_name = excluded.agent_name,
       workspace = excluded.workspace,
       enabled = 1,
       updated_at = excluded.updated_at`,
    [
      id,
      hash,
      tokenPrefix(token),
      keyName,
      agentId,
      agentName,
      workspace,
      now,
      now,
    ],
  );

  const key = await getAccessKeyByHash(ctx, hash);
  if (!key) {
    throw new Error(`Failed to create access key '${id}'.`);
  }
  return { key, token };
}

export async function listAccessKeys(ctx: StoreContext): Promise<AccessKeyRecord[]> {
  return (await ctx.all<AccessKeyRow>(
    `SELECT * FROM access_keys ORDER BY updated_at DESC, created_at DESC`,
    [],
  )).map(mapAccessKey);
}

export async function authenticateAccessToken(
  ctx: StoreContext,
  token: string,
): Promise<AccessKeyRecord | null> {
  const row = await ctx.get<AccessKeyRow>(
    `SELECT * FROM access_keys WHERE token_hash = ? AND enabled = 1`,
    [tokenHash(token)],
  );
  if (!row) {
    return null;
  }

  const now = isoNow();
  await ctx.run(`UPDATE access_keys SET last_used_at = ?, updated_at = ? WHERE id = ?`, [
    now,
    now,
    row.id,
  ]);
  return getAccessKey(ctx, row.id);
}

export async function revokeAccessKey(ctx: StoreContext, id: string): Promise<AccessKeyRecord> {
  await ctx.run(`UPDATE access_keys SET enabled = 0, updated_at = ? WHERE id = ?`, [isoNow(), id]);
  const key = await getAccessKey(ctx, id);
  if (!key) {
    throw new Error(`Access key '${id}' does not exist.`);
  }
  return key;
}

async function getAccessKey(ctx: StoreContext, id: string): Promise<AccessKeyRecord | null> {
  const row = await ctx.get<AccessKeyRow>(`SELECT * FROM access_keys WHERE id = ?`, [id]);
  return row ? mapAccessKey(row) : null;
}

async function getAccessKeyByHash(ctx: StoreContext, hash: string): Promise<AccessKeyRecord | null> {
  const row = await ctx.get<AccessKeyRow>(`SELECT * FROM access_keys WHERE token_hash = ?`, [hash]);
  return row ? mapAccessKey(row) : null;
}
