import { mkdirSync } from "node:fs";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { dbDirectory, defaultDbPath } from "./config";
import * as accessKeysStore from "./store/access-keys";
import * as agentsStore from "./store/agents";
import * as artifactsStore from "./store/artifacts";
import type { StoreContext, StoreRunResult } from "./store/context";
import * as locksStore from "./store/locks";
import * as messagesStore from "./store/messages";
import * as notesStore from "./store/notes";
import { configureDatabase, migrateDatabase } from "./store/schema";
import * as tasksStore from "./store/tasks";
import type {
  AccessKeyRecord,
  AcquireLockInput,
  AgentRecord,
  ArtifactOwnerType,
  ArtifactRecord,
  CreateAccessKeyInput,
  CreatedAccessKeyRecord,
  CreateTaskInput,
  InboxOptions,
  ListLocksOptions,
  ListTasksOptions,
  LockRecord,
  MessageRecord,
  NoteRecord,
  ReadNotesOptions,
  RegisterAgentInput,
  ReplyMessageInput,
  SearchMessagesOptions,
  SendMessageInput,
  TaskEventRecord,
  TaskRecord,
  ThreadRecord,
  UpdatesRecord,
  UpdateTaskInput,
  WriteNoteInput,
} from "./store/types";
import * as updatesStore from "./store/updates";

export type {
  AccessKeyRecord,
  AcquireLockInput,
  AgentRecord,
  ArtifactInput,
  ArtifactOwnerType,
  ArtifactRecord,
  ArtifactType,
  CreateAccessKeyInput,
  CreatedAccessKeyRecord,
  CreateTaskInput,
  InboxOptions,
  ListLocksOptions,
  ListTasksOptions,
  LockRecord,
  MessageKind,
  MessageRecord,
  NoteRecord,
  ReadNotesOptions,
  RegisterAgentInput,
  ReplyMessageInput,
  SearchMessagesOptions,
  SendMessageInput,
  TaskEventRecord,
  TaskRecord,
  TaskStatus,
  ThreadRecord,
  UpdatesRecord,
  UpdateTaskInput,
  WriteNoteInput,
} from "./store/types";

export class LocalCommsStore {
  private readonly db: Database;

  constructor(readonly path: string = defaultDbPath()) {
    mkdirSync(dbDirectory(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    const context = this.context();
    configureDatabase(context);
    migrateDatabase(context);
  }

  close(): void {
    this.db.close();
  }

  registerAgent(input: RegisterAgentInput): AgentRecord {
    return agentsStore.registerAgent(this.context(), input);
  }

  heartbeat(input: RegisterAgentInput): AgentRecord {
    return this.registerAgent(input);
  }

  listAgents(workspace?: string): AgentRecord[] {
    return agentsStore.listAgents(this.context(), workspace);
  }

  whoIsOnline(workspace?: string, activeWithinSeconds = 300): AgentRecord[] {
    return agentsStore.whoIsOnline(this.context(), workspace, activeWithinSeconds);
  }

  getAgent(id: string, workspace?: string): AgentRecord | null {
    return agentsStore.getAgent(this.context(), id, workspace);
  }

  sendMessage(input: SendMessageInput): MessageRecord {
    return messagesStore.sendMessage(this.context(), input);
  }

  replyMessage(input: ReplyMessageInput): MessageRecord {
    return messagesStore.replyMessage(this.context(), input);
  }

  inbox(agentId: string, options: InboxOptions = {}): MessageRecord[] {
    return messagesStore.inbox(this.context(), agentId, options);
  }

  readMessage(agentId: string, messageId: string, workspace?: string): MessageRecord {
    return messagesStore.readMessage(this.context(), agentId, messageId, workspace);
  }

  searchMessages(agentId: string, options: SearchMessagesOptions): MessageRecord[] {
    return messagesStore.searchMessages(this.context(), agentId, options);
  }

  listThreads(agentId: string, workspace?: string, limitValue?: number): ThreadRecord[] {
    return messagesStore.listThreads(this.context(), agentId, workspace, limitValue);
  }

  getThread(
    agentId: string,
    threadId: string,
    workspace?: string,
    limitValue?: number,
  ): MessageRecord[] {
    return messagesStore.getThread(this.context(), agentId, threadId, workspace, limitValue);
  }

  createTask(input: CreateTaskInput): TaskRecord {
    return tasksStore.createTask(this.context(), input);
  }

  listTasks(agentId: string, options: ListTasksOptions = {}): TaskRecord[] {
    return tasksStore.listTasks(this.context(), agentId, options);
  }

  listAllTasks(options: Omit<ListTasksOptions, "assigneeId" | "creatorId"> = {}): TaskRecord[] {
    return tasksStore.listAllTasks(this.context(), options);
  }

  claimTask(agentId: string, taskId: string, note?: string, workspace?: string): TaskRecord {
    return tasksStore.claimTask(this.context(), agentId, taskId, note, workspace);
  }

  updateTask(input: UpdateTaskInput): TaskRecord {
    return tasksStore.updateTask(this.context(), input);
  }

  listVisibleTaskEvents(agentId: string, taskId: string, workspace?: string): TaskEventRecord[] {
    return tasksStore.listVisibleTaskEvents(this.context(), agentId, taskId, workspace);
  }

  writeNote(input: WriteNoteInput): NoteRecord {
    return notesStore.writeNote(this.context(), input);
  }

  readNotes(options: ReadNotesOptions = {}): NoteRecord[] {
    return notesStore.readNotes(this.context(), options);
  }

  listAllNotes(options: Omit<ReadNotesOptions, "workspace" | "channel" | "query"> = {}): NoteRecord[] {
    return notesStore.listAllNotes(this.context(), options);
  }

  pinNote(noteId: string, pinned: boolean, workspace?: string): NoteRecord {
    return notesStore.pinNote(this.context(), noteId, pinned, workspace);
  }

  summarizeChannel(agentId: string, workspace?: string, channel?: string): Record<string, unknown> {
    return notesStore.summarizeChannel(this.context(), agentId, workspace, channel);
  }

  acquireLock(input: AcquireLockInput): LockRecord {
    return locksStore.acquireLock(this.context(), input);
  }

  releaseLock(agentId: string, resource: string, workspace?: string): LockRecord {
    return locksStore.releaseLock(this.context(), agentId, resource, workspace);
  }

  listLocks(options: ListLocksOptions = {}): LockRecord[] {
    return locksStore.listLocks(this.context(), options);
  }

  listAllLocks(options: Pick<ListLocksOptions, "includeExpired"> = {}): LockRecord[] {
    return locksStore.listAllLocks(this.context(), options);
  }

  createAccessKey(input: CreateAccessKeyInput): CreatedAccessKeyRecord {
    return accessKeysStore.createAccessKey(this.context(), input);
  }

  listAccessKeys(): AccessKeyRecord[] {
    return accessKeysStore.listAccessKeys(this.context());
  }

  authenticateAccessToken(token: string): AccessKeyRecord | null {
    return accessKeysStore.authenticateAccessToken(this.context(), token);
  }

  revokeAccessKey(id: string): AccessKeyRecord {
    return accessKeysStore.revokeAccessKey(this.context(), id);
  }

  updatesSince(agentId: string, workspace?: string, since?: string): UpdatesRecord {
    return updatesStore.updatesSince(this.context(), agentId, workspace, since);
  }

  listVisibleArtifacts(
    agentId: string,
    workspace: string | undefined,
    ownerType: ArtifactOwnerType,
    ownerId: string,
  ): ArtifactRecord[] {
    return artifactsStore.listVisibleArtifacts(
      this.context(),
      agentId,
      workspace,
      ownerType,
      ownerId,
    );
  }

  private context(): StoreContext {
    return {
      all: <T>(sql: string, params: SQLQueryBindings[]) => this.all<T>(sql, params),
      exec: (sql: string) => this.exec(sql),
      get: <T>(sql: string, params: SQLQueryBindings[]) => this.get<T>(sql, params),
      run: (sql: string, params: SQLQueryBindings[]) => this.run(sql, params),
    };
  }

  private exec(sql: string): void {
    this.db.exec(sql);
  }

  private run(sql: string, params: SQLQueryBindings[]): StoreRunResult {
    return this.db.query(sql).run(...params);
  }

  private get<T>(sql: string, params: SQLQueryBindings[]): T | null {
    return this.db.query<T, SQLQueryBindings[]>(sql).get(...params);
  }

  private all<T>(sql: string, params: SQLQueryBindings[]): T[] {
    return this.db.query<T, SQLQueryBindings[]>(sql).all(...params);
  }
}
