# Agent Mailbox MCP

Agent Mailbox MCP is a deployable Streamable HTTP MCP server for coordinating AI coding agents across repos, machines, and runtimes. It provides one shared mailbox for messages, threads, tasks, notes, artifacts, presence, and cooperative advisory locks. SQLite is the local default; Postgres is supported for deployments through Bun's native SQL client.

The server runs as one long-lived Bun process. Agents connect to `/mcp` with bearer tokens. Each token maps to one agent identity and workspace. Access keys are managed through the admin API or optional bootstrap config.

## Features

- **Streamable HTTP MCP** with stateful sessions at `/mcp`.
- **Admin API** protected by `AGENT_MAILBOX_ADMIN_TOKEN`.
- **Access keys** stored as hashed tokens; plaintext tokens are shown once on creation.
- **Actionable session startup digest** with `session_start` for unread handoffs, open tasks, stale claims, advisory locks, pinned notes, online agents, summary counts, and ranked next actions.
- **Direct and channel messaging** with threads, read state, metadata, and structured artifacts.
- **Claimable tasks** with priorities, due dates, dependencies, blocked reasons, audit events, and file/URL/log/diff attachments.
- **Automatic task notifications** when another agent marks your task `done`, `blocked`, or `cancelled`.
- **Cooperative advisory locks** for files, modules, tasks, or other shared resources. They guide agents; they do not lock files at the operating-system level.
- **Workspace scoping** so frontend, backend, and other repo agents can share one server without mixing unrelated coordination.

## Quick Start

Install dependencies:

```bash
bun install
```

Start the HTTP MCP server:

```bash
AGENT_MAILBOX_ADMIN_TOKEN="change-me" bun run http
```

Use `AGENT_MAILBOX_ADMIN_TOKEN` as a bearer token for admin API calls that create and revoke agent access keys.

## First Successful Handoff

Use this path to prove the mailbox is useful before wiring it into every agent.

1. Start the server:

```bash
AGENT_MAILBOX_ADMIN_TOKEN="change-me" bun run http
```

2. Create an access key for each agent. The plaintext token is returned only once:

```bash
curl -sS -X POST http://127.0.0.1:8137/api/access-keys \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"name":"Codex local","agent_id":"codex","agent_name":"Codex","workspace":"mcp"}'
```

3. Add the returned token to an MCP client:

```json
{
  "mcpServers": {
    "agent-mailbox": {
      "url": "http://127.0.0.1:8137/mcp",
      "headers": {
        "Authorization": "Bearer <agent-access-token>"
      }
    }
  }
}
```

4. Have the agent call `session_start` first. The response includes `session_summary` counts and ranked `next_actions` so the agent can handle unread messages, stale claims, locks, or open tasks in priority order.
5. Create a complete handoff with `create_handoff`, including acceptance criteria and artifacts. Use `notification_recipient_id`, `notification_channel`, or the task assignee/channel to notify another agent.
6. The receiving agent calls `session_start`, handles unread messages, claims work, checks `active_locks`, then calls `acquire_lock` for files or resources it will edit.
7. Finish with `finish_work`: set the task status, attach completion artifacts, optionally send a handoff note, and release owned locks.

For local inspection without an MCP client, use:

```bash
LOCAL_AI_COMMS_AGENT_ID=codex LOCAL_AI_COMMS_WORKSPACE=mcp bun run cli doctor --format text
LOCAL_AI_COMMS_AGENT_ID=codex LOCAL_AI_COMMS_WORKSPACE=mcp bun run cli session --format text
```

## Scripts

| Script | Description |
| --- | --- |
| `bun run http` | Start the long-running Streamable HTTP MCP server. |
| `bun run cli` | Inspect or mutate the same mailbox from a local terminal identity. |
| `bun test` | Run the test suite. |
| `bun run typecheck` | Run TypeScript checks. |

## HTTP Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `AGENT_MAILBOX_ADMIN_TOKEN` | Yes | Admin API bearer token. |
| `AGENT_MAILBOX_HTTP_HOST` | No | Bind host. Defaults to `127.0.0.1`. |
| `AGENT_MAILBOX_HTTP_PORT` | No | Bind port. Falls back to `PORT`, then `8137`. |
| `AGENT_MAILBOX_HTTP_PATH` | No | MCP endpoint path. Defaults to `/mcp`. |
| `DATABASE_URL` | No | Postgres connection URL. When set, HTTP and CLI use Postgres instead of SQLite. |
| `AGENT_MAILBOX_DB` | No | SQLite path for HTTP mode when `DATABASE_URL` is not set. Falls back to `LOCAL_AI_COMMS_DB`, then `$HOME/.local/share/local-ai-comms.sqlite`. |
| `AGENT_MAILBOX_HTTP_TOKENS` | No | Optional JSON array for bootstrapping agent access keys at process start. |

The `LOCAL_AI_COMMS_DB` fallback and `local-ai-comms.sqlite` default path are retained intentionally so existing local data keeps working. MCP tool names and `local-comms://...` resource URIs are also retained.

### S3 Artifact Storage

Without S3 config, artifacts remain structured references (`path`, `url`, metadata). When S3 config is present, the MCP server also exposes tools for uploaded artifact content.

| Variable | Required for S3 | Description |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | Yes | S3-compatible access key. `S3_ACCESS_KEY_ID` also works. |
| `AWS_SECRET_ACCESS_KEY` | Yes | S3-compatible secret key. `S3_SECRET_ACCESS_KEY` also works. |
| `AWS_DEFAULT_REGION` | Yes | Region passed to Bun S3. `AWS_REGION` or `S3_REGION` also works. |
| `AWS_ENDPOINT_URL` | No | S3-compatible endpoint, such as R2, MinIO, or custom object storage. `AWS_ENDPOINT` or `S3_ENDPOINT` also works. |
| `AWS_S3_BUCKET_NAME` | Yes | Artifact bucket. `AWS_BUCKET` or `S3_BUCKET` also works. |

### Bootstrap Keys

For deployments that need initial keys without calling the admin API first, set `AGENT_MAILBOX_HTTP_TOKENS`:

```bash
AGENT_MAILBOX_ADMIN_TOKEN="admin-secret" \
AGENT_MAILBOX_HTTP_TOKENS='[
  {"token":"frontend-secret","agent_id":"frontend-agent","agent_name":"Frontend Agent","workspace":"fullstack"},
  {"token":"backend-secret","agent_id":"backend-agent","agent_name":"Backend Agent","workspace":"fullstack"}
]' \
bun run http
```

Bootstrap tokens are written into the access-key table as hashed tokens. If the same token appears again on restart, its mapped agent fields are refreshed.

## MCP Client Config

Use Streamable HTTP support in your MCP client and pass a bearer token created through the admin API or bootstrap config.

Frontend agent:

```json
{
  "mcpServers": {
    "agent-mailbox": {
      "url": "https://mailbox.example.com/mcp",
      "headers": {
        "Authorization": "Bearer frontend-secret"
      }
    }
  }
}
```

Backend agent:

```json
{
  "mcpServers": {
    "agent-mailbox": {
      "url": "https://mailbox.example.com/mcp",
      "headers": {
        "Authorization": "Bearer backend-secret"
      }
    }
  }
}
```

HTTP identity comes from the bearer token mapping stored by the server, not from client-supplied agent headers.

## Session Behavior

Every `/mcp` request requires:

```http
Authorization: Bearer <agent-access-token>
```

On initialize, the server creates a stateful MCP session with a random `mcp-session-id`. Later POST, GET, and DELETE requests must include both that `mcp-session-id` and the same bearer token used to initialize the session.

Responses:

- `401` for missing or unknown bearer tokens.
- `403` for a valid token used against another token's MCP session.
- `404` for unknown or closed MCP sessions.

TLS is expected to be provided by your deployment platform or reverse proxy.

## Admin API

Admin routes require:

```http
Authorization: Bearer <AGENT_MAILBOX_ADMIN_TOKEN>
```

Available routes:

- `GET /health`: unauthenticated server name/version/status.
- `GET /api/overview`: summary, keys, agents, tasks, locks, notes, and workspaces.
- `GET /api/access-keys`: all access keys without token hashes or plaintext tokens.
- `POST /api/access-keys`: create a key with `name`, `agent_id`, optional `agent_name`, and optional `workspace`.
- `POST /api/access-keys/:id/revoke`: disable a key.

Plaintext access tokens are returned only by `POST /api/access-keys`.

## Recommended Agent Workflow

Use this convention for every agent in a workspace:

1. Start with `session_start`.
2. Read unread messages and call `read_message` after each handled item.
3. Review pinned notes before changing behavior or ownership assumptions.
4. Claim only tasks you intend to start now.
5. Check `active_locks`, then call `acquire_lock` before editing shared files or modules. Locks are advisory coordination records, not filesystem locks.
6. Attach artifacts to tasks and handoff messages whenever files, URLs, diffs, screenshots, logs, or commands matter.
7. Call `heartbeat` during long work.
8. Finish with `update_task` and a specific note. Creator notifications are sent automatically for `done`, `blocked`, and `cancelled`.
9. Release every lock you own.

Stale claimed tasks are reclaim candidates only after checking recent presence and message context with `who_is_online`, `inbox`, `get_thread`, or `list_tasks`.

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
- `inbox`: list unread or recent visible messages. Pass `since`/`until` (ISO-8601) to limit results to a date range.
- `read_message`: fetch one message and mark it read.
- `search_messages`: search visible message bodies.
- `list_threads`: list visible threads. Pass `since`/`until` (ISO-8601) to limit threads to those with messages in a date range.
- `get_thread`: read a thread chronologically.
- `watch_updates`: poll for new messages, tasks, task events, notes, or locks since a timestamp.

### Tasks

- `create_task`: create a claimable handoff task with clear acceptance criteria and artifacts.
- `create_handoff`: create a task and optional notification message in one workflow call.
- `list_tasks`: list visible tasks. Use `stale_after_seconds` to find claimed tasks that have not changed recently. Pass `since`/`until` (ISO-8601) to limit tasks to those last updated within a date range.
- `get_task`: fetch a single visible task by ID with its artifacts, dependencies, and recent events in one read-only call.
- `claim_task`: atomically claim an open task in the current workspace.
- `update_task`: update status and editable fields (title, description, assignee_id, channel, parent_task_id, dependencies, priority, due_at, blocked_reason, status, artifacts) with partial-update semantics. Omitted fields are left unchanged; `null` clears nullable fields. Use `assignee_id` to directly assign or reassign a task. `done`, `blocked`, and `cancelled` updates from another agent automatically notify the creator.
- `finish_work`: update a task, optionally send a final handoff note, and release selected locks in one cleanup call.
- `list_task_events`: read a task's audit event log (creation, claims, status changes, and field updates) without mutating the task. Ordered oldest-first; use `offset` and `limit` to page. Only visible tasks' events are returned.

### Notes, Artifacts, and Locks

- `write_note`: create or update a scratchpad note. Pin durable conventions.
- `read_notes`: read notes by channel, pinned state, or search query. Pass `since`/`until` (ISO-8601) to limit notes to those last updated within a date range.
- `pin_note`: pin or unpin a note.
- `summarize_channel`: return a compact channel digest.
- `list_artifacts`: list references attached to a message, task, or note.
- `upload_artifact`: upload artifact content to S3 and attach it to a visible message, task, or note.
- `read_artifact_content`: read S3-backed artifact content as text or base64.
- `presign_artifact`: create a short-lived download URL for S3-backed artifact content.
- `acquire_lock`: acquire or renew a cooperative advisory lease for a resource before editing. This does not prevent file writes by the OS, Git, editors, or shell commands.
- `release_lock`: release a lock you own.
- `list_locks`: list active or expired locks. Pass `since`/`until` (ISO-8601) to limit locks to those last updated within a date range.

## CLI

The CLI is not an MCP transport. It is a local terminal helper that uses the same store as HTTP mode. Set `DATABASE_URL` to point it at Postgres, or omit it to use the local SQLite database and legacy local identity variables:

```bash
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli doctor --format text
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli session --format text
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli agents
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli inbox --channel handoffs --unread
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli send --to claude-code "please review"
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli tasks --status open
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli create-task --channel docs --title "Review README"
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli acquire-lock src/store.ts --purpose "editing"
LOCAL_AI_COMMS_AGENT_ID=codex bun run cli release-lock src/store.ts
```

JSON is the default CLI output for agents and scripts. Use `--format text` on `session` and `doctor` for a compact human-readable summary.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `401` from `/mcp` or admin routes | Missing bearer token, wrong access token, or wrong admin token. | Use `Authorization: Bearer <token>`. Admin routes require `AGENT_MAILBOX_ADMIN_TOKEN`; MCP requires an agent access token. |
| `403` on an MCP request | A valid token is being used with another token's `mcp-session-id`. | Reinitialize the MCP client with the same bearer token used for the session. |
| `404` on an MCP request | The MCP session was closed or the session id is unknown. | Reconnect the MCP client and start a new session. |
| No tasks or messages appear | Agent tokens are mapped to different workspaces. | Check the key's `workspace` with `GET /api/access-keys` and use the same workspace for cooperating agents. |
| A task looks abandoned | The assignee has not updated the task recently. | Check `session_start.stale_claimed_tasks`, `who_is_online`, and message context before reclaiming. |
| Edits are blocked by an old lock | A lock expired or was left behind by an interrupted agent. | Use `list_locks` with `include_expired`, coordinate with the owner if active, then reacquire or release your own locks through normal tools. |

## MCP Resources

Read-only resources are exposed for quick context:

- `local-comms://agents`
- `local-comms://tasks/open`
- `local-comms://locks/active`
- `local-comms://notes/pinned`
- `local-comms://channels/{channel}`

These `local-comms://` resource URIs are intentionally kept stable for existing MCP clients.

## Limits

This is a polling mailbox, not a push notification daemon. `watch_updates` can hold a tool call open for bounded near-live behavior, but it cannot wake a sleeping agent.

Locks are cooperative advisory records in the mailbox database, not filesystem locks. They work when agents call `acquire_lock` before editing, respect locks owned by others, and call `release_lock` after finishing.

Presence is heartbeat-based. An agent that crashes may look claimed or recently online until timestamps age out, which is why stale claimed task checks are exposed explicitly.

Remote deployment security is token-based in this iteration. Use TLS at the platform or reverse proxy layer.

## Development

Run tests:

```bash
bun test
```

Run TypeScript checks:

```bash
bun run typecheck
```

SQLite uses WAL mode and `busy_timeout` so multiple MCP sessions and local CLI calls can share the same database safely. Postgres integration tests are gated by `AGENT_MAILBOX_TEST_DATABASE_URL`.

