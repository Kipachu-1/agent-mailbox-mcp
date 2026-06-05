# BeeAI Local Comms MCP

A local MCP server for coordination between Codex, Claude Code, and other AI tools. Each client runs this server over stdio with its own `LOCAL_AI_COMMS_AGENT_ID`, while all clients share one SQLite mailbox.

The tool layer is implemented with BeeAI Framework `DynamicTool`s. The stdio MCP bridge uses the TypeScript MCP SDK so common local MCP clients can spawn it directly.

## Install

```bash
bun install
```

## Run

For normal MCP usage, configure your client and let it spawn the server. Running it directly is mainly useful for smoke tests.

```bash
LOCAL_AI_COMMS_AGENT_ID=codex bun run mcp
```

Environment:

- `LOCAL_AI_COMMS_AGENT_ID`: required stable id for this local AI tool.
- `LOCAL_AI_COMMS_AGENT_NAME`: display name. Defaults to the agent id.
- `LOCAL_AI_COMMS_DB`: shared SQLite path. Defaults to `$HOME/.local/share/local-ai-comms.sqlite`.
- `LOCAL_AI_COMMS_WORKSPACE`: workspace/project scope. Defaults to `default`.

Use the same DB for every local tool, but give each tool a different agent id. Use the same workspace when tools should coordinate on the same project.

## MCP Client Config

Claude Code example:

```json
{
  "mcpServers": {
    "beeai-local-comms": {
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
    "beeai-local-comms": {
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

## Tools

Presence:
- `register_agent`: upsert identity, workspace, status, current task, and heartbeat.
- `heartbeat`: refresh presence and last-seen timestamp.
- `agent_status`: read this agent's registered status.
- `list_agents`: list known agents.
- `who_is_online`: list agents seen recently.

Messages and threads:
- `send_message`: send direct or channel messages, with optional `thread_id`, reply id, metadata, and artifacts.
- `reply_message`: reply to a message while preserving its thread.
- `inbox`: list unread or recent visible messages.
- `read_message`: fetch one message and mark it read.
- `search_messages`: search visible message bodies.
- `list_threads`: list visible message threads.
- `get_thread`: read one thread chronologically.
- `watch_updates`: poll for new messages, tasks, task events, notes, or locks since a timestamp.

Tasks:
- `create_task`: create a claimable task with priority, due date, parent, dependencies, blocked reason, metadata, and artifacts.
- `list_tasks`: list tasks by status, assignee, creator, channel, parent, or recency.
- `claim_task`: atomically claim an open task.
- `update_task`: update status and workflow fields with an audit note.

Shared memory:
- `write_note`: create or update a workspace/channel scratchpad note.
- `read_notes`: read notes by channel, pinned state, or search query.
- `pin_note`: pin or unpin a note.
- `summarize_channel`: return a compact structured digest of recent channel messages, tasks, and notes.

Artifacts and locks:
- `list_artifacts`: list structured file/URL/diff/log/etc. references attached to a message, task, or note.
- `acquire_lock`: acquire or renew a workspace-scoped lease for a file/task/resource.
- `release_lock`: release a lock owned by this agent.
- `list_locks`: list active or expired locks.

## MCP Resources

Read-only resources are also exposed:

- `local-comms://agents`
- `local-comms://tasks/open`
- `local-comms://locks/active`
- `local-comms://notes/pinned`
- `local-comms://channels/{channel}`

## Example Workflows

Direct message with artifact:

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

Reply in a thread:

```json
{
  "message_id": "message-id",
  "body": "I checked it and left a task."
}
```

Task with dependency:

```json
{
  "title": "Review README examples",
  "description": "Check Codex and Claude Code configs.",
  "channel": "docs",
  "priority": 10,
  "dependencies": ["parent-task-id"],
  "due_at": "2026-06-07T00:00:00.000Z"
}
```

Acquire a file lock:

```json
{
  "resource": "/Users/arsenkipachu/Desktop/mcp/src/store.ts",
  "purpose": "editing schema migration",
  "ttl_seconds": 1800
}
```

Watch for updates:

```json
{
  "since": "2026-06-05T00:00:00.000Z",
  "timeout_ms": 30000,
  "interval_ms": 500
}
```

## CLI

The CLI uses the same environment variables and database as the MCP server:

```bash
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli agents
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli inbox --channel handoffs
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli send --to claude-code "please review"
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli send --channel handoffs "status update"
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli tasks --status open
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli create-task --channel docs --title "Review README"
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli acquire-lock src/store.ts --purpose "editing"
```

## Notes

This is still a local polling mailbox, not a live notification daemon. `watch_updates` gives stdio clients near-live behavior by holding a tool call open for a bounded timeout.

SQLite uses WAL mode and `busy_timeout` for multiple locally spawned MCP processes.

## Verify

```bash
bun test
bun run typecheck
```
