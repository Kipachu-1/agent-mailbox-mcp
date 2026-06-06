# TODO: Refactoring Expert

## Context

- [x] **CTX-1.1 [Scope]**: Audit scope is the Bun TypeScript Agent Mailbox MCP server in `/Users/arsenkipachu/Desktop/mcp`.
  - **Primary source files**: `src/store.ts` (1663 lines), `src/tools.ts` (628), `src/http.ts` (328), `src/cli.ts` (235), `src/mcp.ts` (163), `src/config.ts` (150).
  - **Tests**: `tests/store.test.ts` and `tests/http.test.ts`.
  - **Prompt-library baseline**: AI Prompts Library had good matches. Best general fit was `Comprehensive Repository Bug Audit and Fixer`; best TypeScript-specific fit was `Comprehensive TypeScript Codebase Reviewer`. This plan uses their checklist areas: authorization, type safety, error handling, architecture, dependency/configuration, and test gaps.
  - **Verification baseline**: `bun test` originally passed 15 tests; `bun run typecheck` passed; `bun test --coverage` originally reported 49.36% function coverage and 67.75% line coverage overall.
  - **Current verification**: `bun test` passes 27 tests; `bun run typecheck` passes; `bun test --coverage` reports 92.30% function coverage and 94.24% line coverage overall.
  - **Git baseline**: worktree was clean at audit start.
- [x] **CTX-1.2 [Smells]**: Detected improvement targets.
  - **High**: Workspace and visibility checks are inconsistent on raw-ID operations for notes, artifacts, and task events.
  - **High**: `LocalCommsStore` is a 1663-line module mixing schema, migrations, SQL access, domain rules, mapping, validation, and token handling.
  - **Medium**: Agent identity is keyed globally by `agents.id`, while behavior and docs emphasize workspace isolation.
  - **Medium**: MCP tool adapters rely on repeated `input: any` handlers and a schema cast in the BeeAI-to-MCP bridge.
  - **Medium**: CLI validation is weaker than MCP validation and has at least one workspace scoping inconsistency.
  - **Low**: Schema integrity can be tightened for dependencies, owner references, and invalid JSON handling.
- [x] **CTX-1.3 [Priorities]**: Inferred priorities are security/isolation first, then test coverage around coordination boundaries, then maintainability refactors that reduce store/module size without behavior changes.

## Refactoring Plan

- [x] **RF-PLAN-1.1 [Visibility-Scoped Raw-ID Operations]**:
  - **Target**: `src/store.ts:833`, `src/store.ts:923`, `src/store.ts:1139`, `src/store.ts:1151`, `src/store.ts:1168`, `src/tools.ts:508`, `src/tools.ts:535`.
  - **Reason**: `writeNote` upserts by `noteId` without first checking the existing note's workspace, `pinNote` updates by raw ID, `updatesSince` returns all task events in a workspace rather than only visible task events, and `listArtifacts` returns artifacts by owner ID without validating whether the current agent can see the owner.
  - **Risk**: Medium. Tightening visibility can change behavior for clients relying on raw IDs, so regression tests were added before/with the change.
  - **Result**: Added visible task-event and artifact APIs, scoped note pinning/upserts, and regression tests for cross-workspace notes, private task events, private artifacts, and unauthorized task updates.
  - **Priority**: 1.
- [x] **RF-PLAN-1.2 [Workspace-Scoped Agent Identity]**:
  - **Target**: `src/store.ts:330`, `src/store.ts:403`, `src/store.ts:1338`.
  - **Reason**: `agents.id` is the primary key and `registerAgent` uses `ON CONFLICT(id)`, so the same agent ID in two workspaces overwrites its workspace, status, and presence. This weakens the documented workspace isolation model.
  - **Risk**: High. Requires a careful migration path, because changing the primary key to `(workspace, id)` affects queries, existing SQLite data, and access-key identity lookup.
  - **Result**: Added composite `(workspace, id)` agent primary key for new databases, a migration for legacy `agents(id PRIMARY KEY)`, and tests proving the same agent id keeps independent presence per workspace.
  - **Priority**: 2.
- [x] **RF-PLAN-1.3 [Store Module Decomposition]**:
  - **Target**: `src/store.ts`.
  - **Reason**: The module combines unrelated responsibilities: schema/migrations, message queries, task workflow, notes, locks, artifacts, access keys, mappers, and scalar helpers. This increases change risk and makes authorization invariants hard to centralize.
  - **Risk**: Medium. Keep public `LocalCommsStore` behavior stable and extract internal modules behind the existing class first.
  - **Result**: Extracted `src/store/types.ts`, `src/store/schema.ts`, `src/store/mappers.ts`, `src/store/context.ts`, `src/store/agents.ts`, `src/store/messages.ts`, `src/store/tasks.ts`, `src/store/task-support.ts`, `src/store/notes.ts`, `src/store/locks.ts`, `src/store/access-keys.ts`, `src/store/artifacts.ts`, and `src/store/updates.ts`. `src/store.ts` is now a 261-line facade.
  - **Priority**: 3.
- [x] **RF-PLAN-1.4 [Typed Tool Adapter Layer]**:
  - **Target**: `src/tools.ts:52`, repeated `handler: async (input: any)` occurrences, and `src/mcp.ts:42`.
  - **Reason**: The Zod schemas are useful but not connected to handler input types. Repeated `any` lowers type-safety value and allows refactors to drift between schemas and store calls.
  - **Risk**: Low to Medium. Adapter generics need to fit BeeAI's `DynamicTool` shape without fighting upstream types.
  - **Result**: Added `communicationTool` to couple Zod schemas to handler input types; removed repeated `input: any` handlers and replaced the MCP bridge `any` cast with a narrow Zod-schema adapter.
  - **Priority**: 3.
- [x] **RF-PLAN-1.5 [CLI Validation and Workspace Consistency]**:
  - **Target**: `src/cli.ts:68`, `src/cli.ts:155`, `src/cli.ts:204`.
  - **Reason**: `claim-task` does not pass the resolved workspace to `store.claimTask`, `reply` can pass an empty body to the store, and `numberFlag` returns `Number(value)` without validating finite integer/range expectations.
  - **Risk**: Low. Improvements should be additive validation and consistency checks.
  - **Result**: `claim-task` now passes workspace, task status flags are validated, integer flags reject invalid input, and empty reply bodies fail early; process-level CLI tests cover these paths.
  - **Priority**: 2.
- [x] **RF-PLAN-1.6 [Coverage on Boundaries and Errors]**:
  - **Target**: `tests/store.test.ts`, `tests/http.test.ts`, and new focused tests for `src/config.ts`, `src/tools.ts`, `src/mcp.ts`, and CLI behavior.
  - **Reason**: Coverage is strong for `src/store.ts` lines (97.94%) but thin for config (5.77% lines), tool function coverage (25.81%), and MCP resources/error paths.
  - **Risk**: Low. Test-only work should precede behavior changes.
  - **Result**: Added config tests, CLI process tests, store visibility/migration tests, and expanded HTTP MCP integration coverage across messages, tasks, notes, locks, artifacts, resources, and update watching.
  - **Priority**: 1.
- [x] **RF-PLAN-1.7 [Schema Integrity Pass]**:
  - **Target**: `src/store.ts:1393`, `src/store.ts:1409`, `src/store.ts:1598`.
  - **Reason**: `task_dependencies.depends_on_task_id` has no foreign key, artifacts are polymorphic without owner validation, and invalid JSON metadata is silently replaced with `{}`. These are manageable now but become harder after more clients depend on the data shape.
  - **Risk**: Medium. Existing databases may contain data that must be cleaned or tolerated during migration.
  - **Result**: Added task dependency foreign-key migration, artifact owner/type checks for new schemas, legacy migration coverage, and non-silent invalid JSON metadata mapping.
  - **Priority**: 4.

## Refactoring Items

- [x] **RF-ITEM-1.1 [Make Visibility a Store-Level Invariant]**:
  - **Pattern Applied**: Extract Method plus Guard Clauses.
  - **Before**: Visibility logic exists for messages and tasks in selected methods, while notes/artifacts/task events can be reached by raw IDs.
  - **After**: Add scoped helpers such as `getVisibleTask`, `getVisibleNote`, `listVisibleArtifacts`, and `listVisibleTaskEvents`, then make tool/CLI entry points use those helpers.
  - **Metrics**: Target zero public store methods that expose workspace-owned records by raw ID without an agent/workspace visibility check.
- [x] **RF-ITEM-1.2 [Guard Note Upserts]**:
  - **Pattern Applied**: Guard Clauses.
  - **Before**: `writeNote` can update an existing `noteId` and move it into the caller's workspace through `ON CONFLICT(id) DO UPDATE`.
  - **After**: If `noteId` already exists, require it to be in the resolved workspace before update; otherwise reject with a clear error.
  - **Metrics**: Add tests proving cross-workspace note overwrite and pin attempts fail.
- [x] **RF-ITEM-1.3 [Filter Watch Events by Task Visibility]**:
  - **Pattern Applied**: Extract Query.
  - **Before**: `updatesSince` returns all `task_events` for the workspace even when the task is not visible to the requesting agent.
  - **After**: Join `task_events` to `tasks` and apply the same task visibility predicate used by `listTasks`.
  - **Metrics**: Add a regression test with a private assigned task that is invisible to a third agent and verify its event does not appear in `watch_updates`.
- [x] **RF-ITEM-1.4 [Refactor Store by Domain Without API Breakage]**:
  - **Pattern Applied**: Extract Class / Extract Module.
  - **Before**: `LocalCommsStore` has 1663 lines and many responsibilities.
  - **After**: Keep `LocalCommsStore` as the public facade and move internals into modules such as `store/schema.ts`, `store/messages.ts`, `store/tasks.ts`, `store/notes.ts`, `store/locks.ts`, `store/access-keys.ts`, and `store/mappers.ts`.
  - **Metrics**: All extracted store modules are under 300 lines: `types.ts` 274, `schema.ts` 257, `messages.ts` 262, `tasks.ts` 254, `mappers.ts` 194, `notes.ts` 172, `locks.ts` 124, `task-support.ts` 118, `access-keys.ts` 111, `artifacts.ts` 106, `agents.ts` 93, `updates.ts` 42, `context.ts` 22. `src/store.ts` is 261 lines.
- [x] **RF-ITEM-1.5 [Share Tool Schema Types with Handlers]**:
  - **Pattern Applied**: Parameter Object plus typed helper function.
  - **Before**: Each tool handler accepts `input: any`.
  - **After**: Define schemas as constants and use a helper that couples `z.infer<typeof schema>` to the handler.
  - **Metrics**: Reduce `input: any` occurrences in `src/tools.ts` to zero or isolate them to one adapter boundary.
- [x] **RF-ITEM-1.6 [Harden CLI Inputs]**:
  - **Pattern Applied**: Guard Clauses.
  - **Before**: CLI casts arbitrary strings to `TaskStatus`, passes NaN-like numbers through, and omits workspace on `claim-task`.
  - **After**: Validate enum values, validate finite integer numeric flags with useful errors, require non-empty reply bodies, and pass workspace consistently.
  - **Metrics**: Add CLI unit tests or extract parsing/dispatch helpers so this can be tested without spawning a process.

## Proposed Code Changes

- [x] **RF-CODE-1.1 [Visibility Helpers]**: Added store-level helpers and switched tools to scoped variants.

```diff
diff --git a/src/store.ts b/src/store.ts
--- a/src/store.ts
+++ b/src/store.ts
@@
+  listVisibleArtifacts(agentId: string, workspace: string | undefined, ownerType: ArtifactOwnerType, ownerId: string): ArtifactRecord[] {
+    // Validate message/task/note visibility before returning artifact rows.
+  }
+
+  listVisibleTaskEvents(agentId: string, workspace: string | undefined, since: string): TaskEventRecord[] {
+    // Apply the same visibility predicate as listTasks.
+  }
```

- [x] **RF-CODE-1.2 [Scoped Note Writes]**: Reject cross-workspace note updates instead of allowing raw-ID upsert takeover.

```diff
diff --git a/src/store.ts b/src/store.ts
--- a/src/store.ts
+++ b/src/store.ts
@@
   writeNote(input: WriteNoteInput): NoteRecord {
     const workspace = workspaceOf(input.workspace);
     const now = isoNow();
     const id = input.noteId?.trim() || crypto.randomUUID();
+    const existing = input.noteId ? this.getNote(id) : null;
+    if (existing && existing.workspace !== workspace) {
+      throw new Error(`Note '${id}' is not in workspace '${workspace}'.`);
+    }
```

- [x] **RF-CODE-1.3 [CLI Workspace Consistency]**: Pass the resolved workspace into `claimTask` and validate reply body/status/numbers.

```diff
diff --git a/src/cli.ts b/src/cli.ts
--- a/src/cli.ts
+++ b/src/cli.ts
@@
-    case "claim-task":
-      print({ task: store.claimTask(agent.id, requireText(args, "task id"), stringFlag(args, "note")) });
+    case "claim-task":
+      print({ task: store.claimTask(agent.id, requireText(args, "task id"), stringFlag(args, "note"), workspace) });
```

- [x] **RF-CODE-1.4 [Store Split]**: After behavioral tests are in place, extract modules without changing `LocalCommsStore` callers.

```text
src/store.ts              public facade and transaction/db helpers
src/store/types.ts        public record/input option types
src/store/schema.ts       migrate/configure/ensureColumn
src/store/mappers.ts      row-to-record mapping, scalar helpers, token helpers
src/store/context.ts      shared DB context and visibility SQL clauses
src/store/agents.ts       agent registration, presence, workspace-scoped identity
src/store/messages.ts     message visibility, inbox, threads, reads
src/store/tasks.ts        task workflow and visibility
src/store/task-support.ts task filters, events, dependencies, notifications
src/store/notes.ts        notes, pinning, channel summaries
src/store/artifacts.ts    artifact owner visibility helpers
src/store/locks.ts        lock acquisition, release, listing
src/store/access-keys.ts  access-key creation/auth/revoke
src/store/updates.ts      cross-domain update polling
```

## Commands

- [x] **RF-CMD-1.1 [Local Baseline]**: `bun test` passes 27 tests.
- [x] **RF-CMD-1.2 [Typecheck]**: `bun run typecheck` passes.
- [x] **RF-CMD-1.3 [Coverage]**: `bun test --coverage` passes with 92.30% function coverage and 94.24% line coverage.
- [x] **RF-CMD-1.4 [Focused Static Scan]**: `rg -n "any|@ts-ignore|@ts-expect-error|TODO|FIXME|HACK|XXX" src tests` returns no matches.
- [x] **RF-CMD-1.5 [CI]**: Use the same Bun commands as local unless CI already has a stricter pipeline.

## Quality Assurance Task Checklist

- [x] **RF-QA-1.1 [Tests]**: Existing tests pass and regression tests were added for visibility, migration, CLI, config, and MCP tool/resource paths.
- [x] **RF-QA-1.2 [Verifiable Steps]**: Implemented visibility regression tests/fixes, CLI validation tests/fixes, typed tool adapter, schema/type/mapper decomposition, and schema migration.
- [x] **RF-QA-1.3 [Metrics]**: `src/store.ts` is 261 lines after extraction; every `src/store/*.ts` module is under 300 lines; coverage improved to 92.30% function and 94.24% line; `input: any` count in `src/tools.ts` is zero.
- [x] **RF-QA-1.4 [Behavior Preservation]**: Current MCP tool names, resource URIs, admin routes, README commands, and public response shapes were preserved except intentional unsafe access rejections.
- [x] **RF-QA-1.5 [SOLID]**: `LocalCommsStore` remains a facade and schema, mapping, types, message, task, note, lock, access-key, artifact, agent, and update responsibilities are split into cohesive modules.
- [x] **RF-QA-1.6 [Technical Debt]**: Workspace-scoped identity migration is implemented and tested; the deeper domain-method store split is implemented and tested.
- [x] **RF-QA-1.7 [Follow-ups]**: Optional future documentation work remains outside this refactor: document exact visibility rules and SQLite migration behavior in user-facing docs.
