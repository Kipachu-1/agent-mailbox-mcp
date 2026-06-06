import { defaultDbPath, readAgentConfig, type AgentConfig } from "./config";
import {
  buildNextActions,
  buildSessionSummary,
  coordinationConventions,
  recommendedSessionSteps,
  type NextAction,
  type SessionSummary,
} from "./session";
import {
  LocalCommsStore,
  type AgentRecord,
  type LockRecord,
  type MessageRecord,
  type NoteRecord,
  type TaskRecord,
  type TaskStatus,
} from "./store";

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

const args = parseArgs(Bun.argv.slice(2));
const dbPath = defaultDbPath();

if (args.command === "doctor") {
  doctor(dbPath);
} else {
  const store = new LocalCommsStore(dbPath);
  try {
    const agent = readAgentConfig();
    store.registerAgent(agent);
    const workspace = stringFlag(args, "workspace") ?? agent.workspace;

    switch (args.command) {
      case "session":
        session(store, agent, workspace);
        break;
      case "agents":
        print({ agents: store.listAgents(workspace) });
        break;
      case "online":
        print({
          agents: store.whoIsOnline(workspace, numberFlag(args, "active-within-seconds") ?? 300),
        });
        break;
      case "inbox":
        print({
          messages: store.inbox(agent.id, {
            workspace,
            channel: stringFlag(args, "channel"),
            unreadOnly: Boolean(args.flags.unread),
            includeSent: args.flags["no-sent"] ? false : undefined,
            limit: numberFlag(args, "limit"),
          }),
        });
        break;
      case "send":
        send(store, agent, workspace);
        break;
      case "reply":
        reply(store, agent, workspace);
        break;
      case "tasks":
        print({
          tasks: store.listTasks(agent.id, {
            workspace,
            status: optionalTaskStatus(args, "status"),
            channel: stringFlag(args, "channel"),
            staleAfterSeconds: numberFlag(args, "stale-after-seconds"),
            limit: numberFlag(args, "limit"),
          }),
        });
        break;
      case "create-task":
        print({
          task: store.createTask({
            creatorId: agent.id,
            workspace,
            title: requireText(args, "title or positional title"),
            description: stringFlag(args, "description"),
            assigneeId: stringFlag(args, "assignee"),
            channel: stringFlag(args, "channel"),
            priority: numberFlag(args, "priority"),
          }),
        });
        break;
      case "claim-task":
        print({
          task: store.claimTask(agent.id, requireText(args, "task id"), stringFlag(args, "note"), workspace),
        });
        break;
      case "update-task":
        print({
          task: store.updateTask({
            agentId: agent.id,
            workspace,
            taskId: requireText(args, "task id"),
            status: optionalTaskStatus(args, "status") ?? "done",
            note: stringFlag(args, "note"),
          }),
        });
        break;
      case "notes":
        print({
          notes: store.readNotes({
            workspace,
            channel: stringFlag(args, "channel"),
            pinnedOnly: Boolean(args.flags.pinned),
            query: stringFlag(args, "query"),
            limit: numberFlag(args, "limit"),
          }),
        });
        break;
      case "write-note":
        print({
          note: store.writeNote({
            agentId: agent.id,
            workspace,
            noteId: stringFlag(args, "id"),
            channel: stringFlag(args, "channel"),
            title: stringFlag(args, "title") ?? "Note",
            body: requireText(args, "note body"),
            pinned: Boolean(args.flags.pinned),
          }),
        });
        break;
      case "locks":
        print({
          locks: store.listLocks({
            workspace,
            includeExpired: Boolean(args.flags["include-expired"]),
            resource: stringFlag(args, "resource"),
          }),
        });
        break;
      case "acquire-lock":
        print({
          lock: store.acquireLock({
            agentId: agent.id,
            workspace,
            resource: requireText(args, "resource"),
            purpose: stringFlag(args, "purpose"),
            ttlSeconds: numberFlag(args, "ttl-seconds"),
          }),
        });
        break;
      case "release-lock":
        print({ lock: store.releaseLock(agent.id, requireText(args, "resource"), workspace) });
        break;
      case "help":
      case "":
        usage();
        break;
      default:
        throw new Error(`Unknown command '${args.command}'. Run 'bun run cli help'.`);
    }
  } finally {
    store.close();
  }
}

interface SessionPayload {
  agent: AgentRecord;
  workspace: string;
  checked_at: string;
  session_summary: SessionSummary;
  next_actions: NextAction[];
  unread_messages: MessageRecord[];
  open_tasks: TaskRecord[];
  claimed_tasks: TaskRecord[];
  stale_claimed_tasks: TaskRecord[];
  active_locks: LockRecord[];
  pinned_notes: NoteRecord[];
  online_agents: AgentRecord[];
  conventions: string[];
  recommended_next_steps: string[];
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface DoctorPayload {
  ok: boolean;
  database: {
    path: string;
  };
  agent: AgentConfig | null;
  workspace: string;
  checks: DoctorCheck[];
}

function session(
  store: LocalCommsStore,
  agent: AgentConfig,
  workspace: string | undefined,
): void {
  const channel = stringFlag(args, "channel");
  const limit = numberFlag(args, "limit");
  const currentAgent = store.registerAgent({
    id: agent.id,
    name: agent.name,
    workspace,
    status: stringFlag(args, "status"),
    currentTaskId: stringFlag(args, "current-task"),
  });
  const unreadMessages = store.inbox(agent.id, {
    workspace,
    channel,
    unreadOnly: true,
    includeSent: false,
    limit,
  });
  const openTasks = store.listTasks(agent.id, {
    workspace,
    channel,
    status: "open",
    limit,
  });
  const claimedTasks = store.listTasks(agent.id, {
    workspace,
    channel,
    status: "claimed",
    assigneeId: agent.id,
    limit,
  });
  const staleClaimedTasks = store.listTasks(agent.id, {
    workspace,
    channel,
    staleAfterSeconds: numberFlag(args, "stale-after-seconds") ?? 3_600,
    limit,
  });
  const activeLocks = store.listLocks({ workspace });
  const pinnedNotes = store.readNotes({
    workspace,
    channel,
    pinnedOnly: true,
    limit,
  });
  const onlineAgents = store.whoIsOnline(
    workspace,
    numberFlag(args, "active-within-seconds"),
  );
  const collections = {
    unreadMessages,
    openTasks,
    claimedTasks,
    staleClaimedTasks,
    activeLocks,
    pinnedNotes,
    onlineAgents,
  };
  const normalizedWorkspace = workspaceName(workspace);
  const payload: SessionPayload = {
    agent: currentAgent,
    workspace: normalizedWorkspace,
    checked_at: new Date().toISOString(),
    session_summary: buildSessionSummary(collections),
    next_actions: buildNextActions({
      agentId: agent.id,
      workspace: normalizedWorkspace,
      channel,
      collections,
    }),
    unread_messages: unreadMessages,
    open_tasks: openTasks,
    claimed_tasks: claimedTasks,
    stale_claimed_tasks: staleClaimedTasks,
    active_locks: activeLocks,
    pinned_notes: pinnedNotes,
    online_agents: onlineAgents,
    conventions: coordinationConventions,
    recommended_next_steps: recommendedSessionSteps,
  };
  print(payload, formatSession(payload));
}

function doctor(dbPath: string): void {
  const checks: DoctorCheck[] = [];
  let agent: AgentConfig | null = null;
  try {
    agent = readAgentConfig();
    checks.push({
      name: "identity",
      ok: true,
      detail: `LOCAL_AI_COMMS_AGENT_ID=${agent.id}`,
    });
  } catch (error) {
    checks.push({
      name: "identity",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const workspace = stringFlag(args, "workspace") ?? agent?.workspace;
  try {
    const store = new LocalCommsStore(dbPath);
    try {
      if (agent) {
        store.registerAgent({ ...agent, workspace });
      }
      const agents = store.listAgents(workspace);
      checks.push({
        name: "store",
        ok: true,
        detail: `${agents.length} agent record(s) visible in workspace '${workspaceName(workspace)}'.`,
      });
    } finally {
      store.close();
    }
  } catch (error) {
    checks.push({
      name: "store",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const payload: DoctorPayload = {
    ok: checks.every((check) => check.ok),
    database: { path: dbPath },
    agent,
    workspace: workspaceName(workspace),
    checks,
  };
  print(payload, formatDoctor(payload));
  if (!payload.ok) {
    process.exitCode = 1;
  }
}

function send(store: LocalCommsStore, agent: AgentConfig, workspace: string | undefined): void {
  const recipientId = stringFlag(args, "to");
  const channel = stringFlag(args, "channel");
  print({
    message: store.sendMessage({
      senderId: agent.id,
      workspace,
      recipientId,
      channel,
      body: requireText(args, "message body"),
      threadId: stringFlag(args, "thread"),
    }),
  });
}

function reply(store: LocalCommsStore, agent: AgentConfig, workspace: string | undefined): void {
  const body = args.positional.slice(1).join(" ") || stringFlag(args, "body") || "";
  if (!body.trim()) {
    throw new Error("Missing reply body.");
  }
  print({
    message: store.replyMessage({
      senderId: agent.id,
      workspace,
      messageId: stringFlag(args, "message") ?? args.positional[0] ?? "",
      body,
    }),
  });
}

function parseArgs(raw: string[]): ParsedArgs {
  const [command = "", ...rest] = raw;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index] ?? "";
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }

    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }

  return { command, flags, positional };
}

function requireText(parsed: ParsedArgs, label: string): string {
  const value = stringFlag(parsed, "body") ?? stringFlag(parsed, "title") ?? parsed.positional.join(" ");
  if (!value.trim()) {
    throw new Error(`Missing ${label}.`);
  }
  return value;
}

function stringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberFlag(parsed: ParsedArgs, key: string): number | undefined {
  const value = stringFlag(parsed, key);
  if (!value) {
    return undefined;
  }
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || !Number.isInteger(parsedValue)) {
    throw new Error(`--${key} must be an integer.`);
  }
  return parsedValue;
}

function optionalTaskStatus(parsed: ParsedArgs, key: string): TaskStatus | undefined {
  const value = stringFlag(parsed, key);
  if (!value) {
    return undefined;
  }
  if (isTaskStatus(value)) {
    return value;
  }
  throw new Error(`--${key} must be one of: open, claimed, done, blocked, cancelled.`);
}

function isTaskStatus(value: string): value is TaskStatus {
  return ["open", "claimed", "done", "blocked", "cancelled"].includes(value);
}

function print(value: unknown, text?: string): void {
  const format = formatFlag();
  if (format === "text" && text) {
    console.log(text);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function formatFlag(): "json" | "text" {
  const format = stringFlag(args, "format") ?? "json";
  if (format === "json" || format === "text") {
    return format;
  }
  throw new Error("--format must be one of: json, text.");
}

function formatSession(payload: SessionPayload): string {
  const summary = payload.session_summary;
  const lines = [
    `Agent ${payload.agent.id} in workspace '${payload.workspace}'`,
    `Unread ${summary.unread_messages} | Open ${summary.open_tasks} | Claimed ${summary.claimed_tasks} | Stale ${summary.stale_claimed_tasks} | Locks ${summary.active_locks} | Pinned ${summary.pinned_notes} | Online ${summary.online_agents}`,
    "Next actions:",
    ...payload.next_actions.slice(0, 5).map((action) =>
      `${action.priority}. ${action.action} - ${action.tool}: ${action.reason}`,
    ),
  ];
  return lines.join("\n");
}

function formatDoctor(payload: DoctorPayload): string {
  const lines = [
    `Agent Mailbox doctor: ${payload.ok ? "ok" : "failed"}`,
    `Database: ${payload.database.path}`,
    `Workspace: ${payload.workspace}`,
    ...payload.checks.map((check) =>
      `${check.ok ? "ok" : "error"} ${check.name}: ${check.detail}`,
    ),
  ];
  return lines.join("\n");
}

function workspaceName(workspace: string | undefined): string {
  return workspace?.trim() || "default";
}

function usage(): void {
  console.log(`Agent Mailbox CLI

Required env:
  LOCAL_AI_COMMS_AGENT_ID=<agent-id>

Common commands:
  bun run cli session [--channel handoffs] [--format text]
  bun run cli doctor [--format text]
  bun run cli agents
  bun run cli online
  bun run cli inbox [--channel handoffs] [--unread]
  bun run cli send --to claude-code "please review this"
  bun run cli send --channel handoffs "status update"
  bun run cli tasks [--status open] [--stale-after-seconds 3600]
  bun run cli create-task --channel docs --title "Review README"
  bun run cli claim-task <task-id>
  bun run cli update-task <task-id> --status done --note "finished"
  bun run cli notes [--channel docs] [--pinned]
  bun run cli write-note --channel docs --title "Context" "Useful shared note"
  bun run cli locks
  bun run cli acquire-lock src/store.ts --purpose "editing"
  bun run cli release-lock src/store.ts
`);
}
