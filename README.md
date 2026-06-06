# Agent Mailbox MCP

Coordinate local AI coding agents without a cloud service.

Agent Mailbox MCP is a small, local-first MCP server for teams that run Codex, Claude Code, Cursor, or other AI tools against the same repo. Each agent gets its own identity, but everyone shares one SQLite mailbox for messages, tasks, notes, artifacts, and cooperative advisory locks.

It is built for the practical problems that show up when multiple agents work nearby:

- unread handoffs that get missed
- two agents editing the same file at once
- tasks marked done without notifying the requester
- stale claimed tasks after an agent crashes or stops polling
- project conventions scattered across ad-hoc direct messages
- one global mailbox getting noisy across multiple repos

The server is intentionally simple: stdio MCP, Bun, BeeAI Framework tools, and SQLite WAL mode. No daemon, no external database, no account system.

## Features

- **Session startup digest** with `session_start`: refresh presence and return unread messages, open tasks, stale claimed tasks, active locks, pinned notes, online agents, and recommended next steps.
- **Direct and channel messaging** with threads, read state, metadata, and structured artifacts.
- **Claimable tasks** with priorities, due dates, dependencies, blocked reasons, audit events, and file/URL/log/diff attachments.
- **Automatic task notifications**: when another agent marks your task `done`, `blocked`, or `cancelled`, you get a direct inbox message.
- **Cooperative advisory locks** for files, modules, tasks, or any shared resource. They guide agents; they do not lock files at the operating-system level.
- **Pinned shared notes** for durable conventions and project context.
- **Workspace scoping** so each repo or project can keep its own clean coordination state.
- **Pull-based watching** through `watch_updates` for near-live polling while a client is active.

## Quick Start

Install dependencies:

```bash
bun install
```

Run the MCP server directly for a smoke test:

```bash
LOCAL_AI_COMMS_AGENT_ID=codex bun run mcp
```

Most of the time you do not run it manually. Configure your MCP client and let the client spawn the server over stdio.

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `LOCAL_AI_COMMS_AGENT_ID` | Yes | Stable id for this local AI tool, for example `codex` or `claude-code`. |
| `LOCAL_AI_COMMS_AGENT_NAME` | No | Display name. Defaults to the agent id. |
| `LOCAL_AI_COMMS_DB` | No | Shared SQLite path. Defaults to `$HOME/.local/share/local-ai-comms.sqlite`. |
| `LOCAL_AI_COMMS_WORKSPACE` | No | Project scope. Defaults to `default`. Use one workspace per repo. |

Use the same database path for every local tool, but give each tool a different agent id. The `LOCAL_AI_COMMS_*` variables and `local-ai-comms.sqlite` default path are retained for compatibility with existing installations.

## MCP Client Config

Claude Code example:

```json
{
  "mcpServers": {
    "agent-mailbox": {
      "command": "bun",
      "args": ["run", "/Users/arsenkipachu/Desktop/mcp/index.ts"],
      "env": {
        "LOCAL_AI_COMMS_AGENT_ID": "claude-code",
        "LOCAL_AI_COMMS_AGENT_NAME": "Claude Code",
        "LOCAL_AI_COMMS_WORKSPACE": "mcp",
        "LOCAL_AI_COMMS_DB": "/Users/arsenkipachu/.local/share/local-ai-comms.sqlite"
      }
    }
  }
}
```

Codex example:

```json
{
  "mcpServers": {
    "agent-mailbox": {
      "command": "bun",
      "args": ["run", "/Users/arsenkipachu/Desktop/mcp/index.ts"],
      "env": {
        "LOCAL_AI_COMMS_AGENT_ID": "codex",
        "LOCAL_AI_COMMS_AGENT_NAME": "Codex",
        "LOCAL_AI_COMMS_WORKSPACE": "mcp",
        "LOCAL_AI_COMMS_DB": "/Users/arsenkipachu/.local/share/local-ai-comms.sqlite"
      }
    }
  }
}
```

## Recommended Agent Workflow

Use this as the shared convention for every agent in a workspace:

1. Start with `session_start`.
2. Read unread messages and call `read_message` after each handled item.
3. Review pinned notes before changing behavior or ownership assumptions.
4. Claim only tasks you intend to start now.
5. Check `active_locks`, then call `acquire_lock` before editing shared files or modules. Locks are advisory coordination records, not filesystem locks.
6. Attach artifacts to tasks and handoff messages whenever files, URLs, diffs, screenshots, logs, or commands matter.
7. Call `heartbeat` during long work.
8. Finish with `update_task` and a specific note. Creator notifications are sent automatically for `done`, `blocked`, and `cancelled`.
9. Release every lock you own.

Stale claimed tasks are cooperative, not magical. If `session_start` or `list_tasks` with `stale_after_seconds` shows a stale claim, check `who_is_online` and recent message context before reclaiming or asking the user.

## Tools

### Orientation

- `session_start`: first call at the start of each work session; returns unread messages, open tasks, stale claimed tasks, active locks, pinned notes, online agents, conventions, and next steps.
- `register_agent`: register or refresh the current agent identity. Prefer `session_start` at session start.
- `heartbeat`: refresh presence during long work.
- `agent_status`: read this agent's registered status.
- `list_agents`: list known agents.
- `who_is_online`: list agents with a recent heartbeat.

### Messages and Threads

- `send_message`: send a direct or channel message with optional metadata and artifacts.
- `reply_message`: reply while preserving a thread.
- `inbox`: list unread or recent visible messages.
- `read_message`: fetch one message and mark it read.
- `search_messages`: search visible message bodies.
- `list_threads`: list visible threads.
- `get_thread`: read a thread chronologically.
- `watch_updates`: poll for new messages, tasks, task events, notes, or locks since a timestamp.

### Tasks

- `create_task`: create a claimable handoff task. Clear criteria and artifacts make handoffs much easier.
- `list_tasks`: list visible tasks. Use `stale_after_seconds` to find claimed tasks that have not changed recently.
- `claim_task`: atomically claim an open task in the current workspace.
- `update_task`: update status and workflow fields. `done`, `blocked`, and `cancelled` updates from another agent automatically notify the creator.

### Notes, Artifacts, and Locks

- `write_note`: create or update a scratchpad note. Pin durable conventions.
- `read_notes`: read notes by channel, pinned state, or search query.
- `pin_note`: pin or unpin a note.
- `summarize_channel`: return a compact channel digest.
- `list_artifacts`: list references attached to a message, task, or note.
- `acquire_lock`: acquire or renew a cooperative advisory lease for a resource before editing. This does not prevent file writes by the OS, Git, editors, or shell commands.
- `release_lock`: release a lock you own.
- `list_locks`: list active or expired locks.

## Example Calls

Start a session:

```json
{
  "workspace": "mcp",
  "status": "working",
  "stale_after_seconds": 3600
}
```

Direct message with a file artifact:

```json
{
  "recipient_id": "claude-code",
  "body": "Please inspect this store method.",
  "artifacts": [
    {
      "type": "file",
      "path": "/Users/arsenkipachu/Desktop/mcp/src/store.ts",
      "line": 120,
      "label": "store method"
    }
  ]
}
```

Create a task:

```json
{
  "title": "Review README examples",
  "description": "Check the Codex and Claude Code config snippets and update stale wording.",
  "channel": "docs",
  "priority": 10,
  "due_at": "2026-06-07T00:00:00.000Z",
  "artifacts": [
    {
      "type": "file",
      "path": "/Users/arsenkipachu/Desktop/mcp/README.md",
      "label": "README"
    }
  ]
}
```

Acquire a file lock:

```json
{
  "resource": "/Users/arsenkipachu/Desktop/mcp/src/store.ts",
  "purpose": "editing task notification behavior",
  "ttl_seconds": 1800
}
```

Find stale claimed tasks:

```json
{
  "status": "claimed",
  "stale_after_seconds": 3600
}
```

## CLI

The CLI uses the same environment variables and database as the MCP server:

```bash
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli agents
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli inbox --channel handoffs --unread
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli send --to claude-code "please review"
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli send --channel handoffs "status update"
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli tasks --status open
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli tasks --stale-after-seconds 3600
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli create-task --channel docs --title "Review README"
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli claim-task <task-id>
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli update-task <task-id> --status done --note "finished"
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli write-note --channel docs --title "Conventions" --pinned "Check inbox at session start."
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli acquire-lock src/store.ts --purpose "editing"
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli release-lock src/store.ts
```

## MCP Resources

Read-only resources are exposed for quick context:

- `local-comms://agents`
- `local-comms://tasks/open`
- `local-comms://locks/active`
- `local-comms://notes/pinned`
- `local-comms://channels/{channel}`

These `local-comms://` resource URIs are intentionally kept stable for existing MCP clients.

## Limits

This is a local polling mailbox, not a push notification daemon. `watch_updates` can hold a tool call open for bounded near-live behavior, but it cannot wake a sleeping agent.

Locks are cooperative advisory records in SQLite, not filesystem locks. They work when agents call `acquire_lock` before editing, respect locks owned by others, and call `release_lock` after finishing.

Presence is heartbeat-based. An agent that crashes may look claimed or recently online until its timestamps age out, which is why stale claimed task checks are exposed explicitly.

## Development

Run tests:

```bash
bun test
```

Run TypeScript checks:

```bash
bun run typecheck
```

SQLite uses WAL mode and `busy_timeout` so multiple local MCP processes can share the same database safely.

## Contributing

Issues, experiments, and small PRs are welcome if you are using local AI agents against the same repo and hit a coordination gap. Good contributions keep Agent Mailbox local-first, dependency-light, and easy for MCP clients to understand from tool names, descriptions, and structured outputs.

If you publish a fork publicly, add a `LICENSE` file so downstream users know how they can use it.
