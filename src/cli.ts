import { defaultDbPath, readAgentConfig } from "./config";
import { LocalCommsStore, type TaskStatus } from "./store";

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

const args = parseArgs(Bun.argv.slice(2));
const store = new LocalCommsStore(defaultDbPath());
const agent = readAgentConfig();

try {
  store.registerAgent(agent);
  const workspace = stringFlag(args, "workspace") ?? agent.workspace;

  switch (args.command) {
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
      send(workspace);
      break;
    case "reply":
      reply(workspace);
      break;
    case "tasks":
      print({
        tasks: store.listTasks(agent.id, {
          workspace,
          status: stringFlag(args, "status") as TaskStatus | undefined,
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
      print({ task: store.claimTask(agent.id, requireText(args, "task id"), stringFlag(args, "note")) });
      break;
    case "update-task":
      print({
        task: store.updateTask({
          agentId: agent.id,
          workspace,
          taskId: requireText(args, "task id"),
          status: (stringFlag(args, "status") ?? "done") as TaskStatus,
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

function send(workspace: string | undefined): void {
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

function reply(workspace: string | undefined): void {
  print({
    message: store.replyMessage({
      senderId: agent.id,
      workspace,
      messageId: stringFlag(args, "message") ?? args.positional[0] ?? "",
      body: args.positional.slice(1).join(" ") || stringFlag(args, "body") || "",
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
  return value ? Number(value) : undefined;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): void {
  console.log(`Agent Mailbox CLI

Required env:
  LOCAL_AI_COMMS_AGENT_ID=<agent-id>

Common commands:
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
