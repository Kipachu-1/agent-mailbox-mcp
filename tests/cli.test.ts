import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCommsStore } from "../src/store";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI claim-task respects the configured workspace", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const task = await store.createTask({
    creatorId: "codex",
    workspace: "repo-a",
    title: "Repo A task",
  });
  await store.close();

  const wrongWorkspace = await runCli(path, "claude", "repo-b", ["claim-task", task.id]);
  expect(wrongWorkspace.exitCode).toBe(1);
  expect(wrongWorkspace.stderr).toContain("not in workspace 'repo-b'");

  const rightWorkspace = await runCli(path, "claude", "repo-a", ["claim-task", task.id]);
  expect(rightWorkspace.exitCode).toBe(0);
  expect(JSON.parse(rightWorkspace.stdout).task.assignee_id).toBe("claude");
});

test("CLI rejects invalid task statuses and numeric flags", async () => {
  const { path } = tempDb();

  const invalidStatus = await runCli(path, "codex", "repo-a", ["tasks", "--status", "stuck"]);
  expect(invalidStatus.exitCode).toBe(1);
  expect(invalidStatus.stderr).toContain("--status must be one of");

  const invalidLimit = await runCli(path, "codex", "repo-a", ["tasks", "--limit", "nan"]);
  expect(invalidLimit.exitCode).toBe(1);
  expect(invalidLimit.stderr).toContain("--limit must be an integer");
});

test("CLI reply requires a non-empty body", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const message = await store.sendMessage({
    senderId: "codex",
    workspace: "repo-a",
    recipientId: "claude",
    body: "Please reply.",
  });
  await store.close();

  const result = await runCli(path, "claude", "repo-a", ["reply", message.id]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Missing reply body");
});

test("CLI session mirrors startup digest as JSON and text", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const message = await store.sendMessage({
    senderId: "codex",
    workspace: "repo-a",
    recipientId: "claude",
    body: "Please handle this handoff.",
  });
  const task = await store.createTask({
    creatorId: "codex",
    workspace: "repo-a",
    title: "Open handoff task",
  });
  await store.writeNote({
    agentId: "codex",
    workspace: "repo-a",
    title: "Convention",
    body: "Use locks before edits.",
    pinned: true,
  });
  await store.acquireLock({
    agentId: "codex",
    workspace: "repo-a",
    resource: "src/cli.ts",
  });
  await store.close();

  const jsonResult = await runCli(path, "claude", "repo-a", ["session"]);
  expect(jsonResult.exitCode).toBe(0);
  const parsed = JSON.parse(jsonResult.stdout);
  expect(parsed.session_summary.unread_messages).toBe(1);
  expect(parsed.session_summary.open_tasks).toBe(1);
  expect(parsed.session_summary.active_locks).toBe(1);
  expect(parsed.next_actions[0].tool).toBe("inbox");
  expect(parsed.next_actions.map((action: { tool: string }) => action.tool)).toContain("claim_task");
  expect(parsed.unread_messages.map((item: { id: string }) => item.id)).toContain(message.id);
  expect(parsed.open_tasks.map((item: { id: string }) => item.id)).toContain(task.id);

  const textResult = await runCli(path, "claude", "repo-a", ["session", "--format", "text"]);
  expect(textResult.exitCode).toBe(0);
  expect(textResult.stdout).toContain("Agent claude in workspace 'repo-a'");
  expect(textResult.stdout).toContain("Next actions:");
  expect(textResult.stdout).toContain("Handle unread messages");
});

test("CLI doctor reports identity and store readiness", async () => {
  const { path } = tempDb();

  const jsonResult = await runCli(path, "claude", "repo-a", ["doctor"]);
  expect(jsonResult.exitCode).toBe(0);
  const parsed = JSON.parse(jsonResult.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.database.kind).toBe("sqlite");
  expect(parsed.database.label).toBe(path);
  expect(parsed.agent.id).toBe("claude");
  expect(parsed.checks.map((check: { name: string }) => check.name)).toEqual([
    "identity",
    "store",
  ]);

  const textResult = await runCli(path, "claude", "repo-a", ["doctor", "--format", "text"]);
  expect(textResult.exitCode).toBe(0);
  expect(textResult.stdout).toContain("Agent Mailbox doctor: ok");
  expect(textResult.stdout).toContain("ok identity:");
  expect(textResult.stdout).toContain("ok store:");
});

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-cli-"));
  tempDirs.push(dir);
  return { dir, path: join(dir, "mailbox.sqlite") };
}

async function runCli(
  dbPath: string,
  agentId: string,
  workspace: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    stderr: "pipe",
    stdout: "pipe",
    env: {
      ...process.env,
      LOCAL_AI_COMMS_AGENT_ID: agentId,
      LOCAL_AI_COMMS_WORKSPACE: workspace,
      LOCAL_AI_COMMS_DB: dbPath,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
