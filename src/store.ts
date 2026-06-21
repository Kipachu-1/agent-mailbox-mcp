import { mkdirSync } from "node:fs";
import { SQL } from "bun";
import { dbDirectory, defaultDbPath, readStoreConfig, type StoreConfig } from "./config";
import * as accessKeysStore from "./store/access-keys";
import * as agentsStore from "./store/agents";
import * as artifactsStore from "./store/artifacts";
import type {
  StoreContext,
  StoreDialect,
  StoreRunResult,
  StoreValue,
} from "./store/context";
import * as locksStore from "./store/locks";
import * as messagesStore from "./store/messages";
import * as notesStore from "./store/notes";
import { configureDatabase, migrateDatabase } from "./store/schema";
import * as tasksStore from "./store/tasks";
import type {
  AccessKeyRecord,
  AcquireLockInput,
  AgentRecord,
  ArtifactInput,
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
  Paginated,
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
  Paginated,
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

export interface StoreDatabaseInfo {
  kind: StoreDialect;
  label: string;
}

interface SqlClient {
  unsafe<T = unknown>(sql: string, values?: StoreValue[]): PromiseLike<T[]>;
  begin<T>(fn: (sql: SqlClient) => Promise<T>): Promise<T>;
  close?(options?: { timeout?: number }): Promise<void>;
}

export class LocalCommsStore {
  private constructor(
    private readonly db: BunSqlDatabase,
    readonly database: StoreDatabaseInfo,
  ) {}

  static async open(config: StoreConfig = readStoreConfig()): Promise<LocalCommsStore> {
    if (config.kind === "postgres") {
      return LocalCommsStore.openPostgres(config.url);
    }
    return LocalCommsStore.openSqlite(config.path);
  }

  static async openSqlite(path: string = defaultDbPath()): Promise<LocalCommsStore> {
    mkdirSync(dbDirectory(path), { recursive: true });
    const db = new BunSqlDatabase(
      new SQL({
        adapter: "sqlite",
        filename: path,
        create: true,
        strict: true,
      }) as unknown as SqlClient,
      "sqlite",
    );
    await configureDatabase(db.context());
    await migrateDatabase(db.context());
    return new LocalCommsStore(db, { kind: "sqlite", label: path });
  }

  static async openPostgres(url: string): Promise<LocalCommsStore> {
    const db = new BunSqlDatabase(new SQL(url) as unknown as SqlClient, "postgres");
    await configureDatabase(db.context());
    await migrateDatabase(db.context());
    return new LocalCommsStore(db, { kind: "postgres", label: url });
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async registerAgent(input: RegisterAgentInput): Promise<AgentRecord> {
    return agentsStore.registerAgent(this.context(), input);
  }

  async heartbeat(input: RegisterAgentInput): Promise<AgentRecord> {
    return this.registerAgent(input);
  }

  async listAgents(
    workspace?: string,
    limitValue?: number,
    offsetValue?: number,
  ): Promise<AgentRecord[]> {
    return agentsStore.listAgents(this.context(), workspace, limitValue, offsetValue);
  }

  async listAgentsPage(
    workspace?: string,
    limitValue?: number,
    offsetValue?: number,
  ): Promise<Paginated<AgentRecord>> {
    return agentsStore.listAgentsPaginated(this.context(), workspace, limitValue, offsetValue);
  }

  async whoIsOnline(workspace?: string, activeWithinSeconds = 300): Promise<AgentRecord[]> {
    return agentsStore.whoIsOnline(this.context(), workspace, activeWithinSeconds);
  }

  async getAgent(id: string, workspace?: string): Promise<AgentRecord | null> {
    return agentsStore.getAgent(this.context(), id, workspace);
  }

  async sendMessage(input: SendMessageInput): Promise<MessageRecord> {
    return messagesStore.sendMessage(this.context(), input);
  }

  async replyMessage(input: ReplyMessageInput): Promise<MessageRecord> {
    return messagesStore.replyMessage(this.context(), input);
  }

  async inbox(agentId: string, options: InboxOptions = {}): Promise<MessageRecord[]> {
    return messagesStore.inbox(this.context(), agentId, options);
  }

  async inboxPage(
    agentId: string,
    options: InboxOptions = {},
  ): Promise<Paginated<MessageRecord>> {
    return messagesStore.inboxPaginated(this.context(), agentId, options);
  }

  async readMessage(
    agentId: string,
    messageId: string,
    workspace?: string,
  ): Promise<MessageRecord> {
    return messagesStore.readMessage(this.context(), agentId, messageId, workspace);
  }

  async searchMessages(
    agentId: string,
    options: SearchMessagesOptions,
  ): Promise<MessageRecord[]> {
    return messagesStore.searchMessages(this.context(), agentId, options);
  }

  async searchMessagesPage(
    agentId: string,
    options: SearchMessagesOptions,
  ): Promise<Paginated<MessageRecord>> {
    return messagesStore.searchMessagesPaginated(this.context(), agentId, options);
  }

  async listThreads(
    agentId: string,
    workspace?: string,
    limitValue?: number,
    offsetValue?: number,
  ): Promise<ThreadRecord[]> {
    return messagesStore.listThreads(this.context(), agentId, workspace, limitValue, offsetValue);
  }

  async listThreadsPage(
    agentId: string,
    workspace?: string,
    limitValue?: number,
    offsetValue?: number,
  ): Promise<Paginated<ThreadRecord>> {
    return messagesStore.listThreadsPaginated(
      this.context(),
      agentId,
      workspace,
      limitValue,
      offsetValue,
    );
  }

  async getThread(
    agentId: string,
    threadId: string,
    workspace?: string,
    limitValue?: number,
    offsetValue?: number,
  ): Promise<MessageRecord[]> {
    return messagesStore.getThread(
      this.context(),
      agentId,
      threadId,
      workspace,
      limitValue,
      offsetValue,
    );
  }

  async getThreadPage(
    agentId: string,
    threadId: string,
    workspace?: string,
    limitValue?: number,
    offsetValue?: number,
  ): Promise<Paginated<MessageRecord>> {
    return messagesStore.getThreadPaginated(
      this.context(),
      agentId,
      threadId,
      workspace,
      limitValue,
      offsetValue,
    );
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    return tasksStore.createTask(this.context(), input);
  }

  async listTasks(agentId: string, options: ListTasksOptions = {}): Promise<TaskRecord[]> {
    return tasksStore.listTasks(this.context(), agentId, options);
  }

  async listTasksPage(
    agentId: string,
    options: ListTasksOptions = {},
  ): Promise<Paginated<TaskRecord>> {
    return tasksStore.listTasksPaginated(this.context(), agentId, options);
  }

  async listAllTasks(
    options: Omit<ListTasksOptions, "assigneeId" | "creatorId"> = {},
  ): Promise<TaskRecord[]> {
    return tasksStore.listAllTasks(this.context(), options);
  }

  async claimTask(
    agentId: string,
    taskId: string,
    note?: string,
    workspace?: string,
  ): Promise<TaskRecord> {
    return tasksStore.claimTask(this.context(), agentId, taskId, note, workspace);
  }

  async updateTask(input: UpdateTaskInput): Promise<TaskRecord> {
    return tasksStore.updateTask(this.context(), input);
  }

  async getVisibleTask(
    agentId: string,
    taskId: string,
    workspace?: string,
  ): Promise<TaskRecord | null> {
    return tasksStore.getVisibleTask(this.context(), agentId, taskId, workspace);
  }

  async listVisibleTaskEvents(
    agentId: string,
    taskId: string,
    workspace?: string,
  ): Promise<TaskEventRecord[]> {
    return tasksStore.listVisibleTaskEvents(this.context(), agentId, taskId, workspace);
  }

  async writeNote(input: WriteNoteInput): Promise<NoteRecord> {
    return notesStore.writeNote(this.context(), input);
  }

  async readNotes(options: ReadNotesOptions = {}): Promise<NoteRecord[]> {
    return notesStore.readNotes(this.context(), options);
  }

  async readNotesPage(options: ReadNotesOptions = {}): Promise<Paginated<NoteRecord>> {
    return notesStore.readNotesPaginated(this.context(), options);
  }

  async listAllNotes(
    options: Omit<ReadNotesOptions, "workspace" | "channel" | "query"> = {},
  ): Promise<NoteRecord[]> {
    return notesStore.listAllNotes(this.context(), options);
  }

  async pinNote(noteId: string, pinned: boolean, workspace?: string): Promise<NoteRecord> {
    return notesStore.pinNote(this.context(), noteId, pinned, workspace);
  }

  async summarizeChannel(
    agentId: string,
    workspace?: string,
    channel?: string,
  ): Promise<Record<string, unknown>> {
    return notesStore.summarizeChannel(this.context(), agentId, workspace, channel);
  }

  async acquireLock(input: AcquireLockInput): Promise<LockRecord> {
    return locksStore.acquireLock(this.context(), input);
  }

  async releaseLock(agentId: string, resource: string, workspace?: string): Promise<LockRecord> {
    return locksStore.releaseLock(this.context(), agentId, resource, workspace);
  }

  async listLocks(options: ListLocksOptions = {}): Promise<LockRecord[]> {
    return locksStore.listLocks(this.context(), options);
  }

  async listLocksPage(options: ListLocksOptions = {}): Promise<Paginated<LockRecord>> {
    return locksStore.listLocksPaginated(this.context(), options);
  }

  async listAllLocks(options: Pick<ListLocksOptions, "includeExpired"> = {}): Promise<LockRecord[]> {
    return locksStore.listAllLocks(this.context(), options);
  }

  async createAccessKey(input: CreateAccessKeyInput): Promise<CreatedAccessKeyRecord> {
    return accessKeysStore.createAccessKey(this.context(), input);
  }

  async listAccessKeys(): Promise<AccessKeyRecord[]> {
    return accessKeysStore.listAccessKeys(this.context());
  }

  async authenticateAccessToken(token: string): Promise<AccessKeyRecord | null> {
    return accessKeysStore.authenticateAccessToken(this.context(), token);
  }

  async revokeAccessKey(id: string): Promise<AccessKeyRecord> {
    return accessKeysStore.revokeAccessKey(this.context(), id);
  }

  async updatesSince(agentId: string, workspace?: string, since?: string): Promise<UpdatesRecord> {
    return updatesStore.updatesSince(this.context(), agentId, workspace, since);
  }

  async listVisibleArtifacts(
    agentId: string,
    workspace: string | undefined,
    ownerType: ArtifactOwnerType,
    ownerId: string,
  ): Promise<ArtifactRecord[]> {
    return artifactsStore.listVisibleArtifacts(
      this.context(),
      agentId,
      workspace,
      ownerType,
      ownerId,
    );
  }

  async addVisibleArtifact(
    agentId: string,
    workspace: string | undefined,
    ownerType: ArtifactOwnerType,
    ownerId: string,
    artifact: ArtifactInput,
    artifactId?: string,
  ): Promise<ArtifactRecord> {
    return artifactsStore.addVisibleArtifact(
      this.context(),
      agentId,
      workspace,
      ownerType,
      ownerId,
      artifact,
      artifactId,
    );
  }

  async getVisibleArtifact(
    agentId: string,
    workspace: string | undefined,
    ownerType: ArtifactOwnerType,
    ownerId: string,
    artifactId: string,
  ): Promise<ArtifactRecord> {
    return artifactsStore.getVisibleArtifact(
      this.context(),
      agentId,
      workspace,
      ownerType,
      ownerId,
      artifactId,
    );
  }

  private context(): StoreContext {
    return this.db.context();
  }
}

export function createCommsStore(config: StoreConfig = readStoreConfig()): Promise<LocalCommsStore> {
  return LocalCommsStore.open(config);
}

class BunSqlDatabase {
  constructor(
    private readonly sql: SqlClient,
    readonly dialect: StoreDialect,
  ) {}

  context(): StoreContext {
    return this.createContext(this.sql);
  }

  async close(): Promise<void> {
    await this.sql.close?.();
  }

  private createContext(client: SqlClient): StoreContext {
    return {
      dialect: this.dialect,
      all: async <T>(sql: string, params: StoreValue[]) => this.all<T>(client, sql, params),
      exec: async (sql: string) => {
        await this.exec(client, sql);
      },
      get: async <T>(sql: string, params: StoreValue[]) => this.get<T>(client, sql, params),
      run: async (sql: string, params: StoreValue[]) => this.run(client, sql, params),
      transaction: async <T>(fn: (ctx: StoreContext) => Promise<T>) =>
        client.begin((tx) => fn(this.createContext(tx))),
    };
  }

  private async all<T>(client: SqlClient, sql: string, params: StoreValue[]): Promise<T[]> {
    return client.unsafe<T>(this.prepare(sql), params);
  }

  private async get<T>(
    client: SqlClient,
    sql: string,
    params: StoreValue[],
  ): Promise<T | null> {
    const rows = await this.all<T>(client, sql, params);
    return rows[0] ?? null;
  }

  private async run(
    client: SqlClient,
    sql: string,
    params: StoreValue[],
  ): Promise<StoreRunResult> {
    const result = await client.unsafe(this.prepare(sql), params);
    const metadata = result as unknown as { affectedRows?: number; count?: number };
    return { changes: Number(metadata.affectedRows ?? metadata.count ?? 0) };
  }

  private async exec(client: SqlClient, sql: string): Promise<void> {
    if (this.dialect === "sqlite") {
      for (const statement of splitSqlStatements(sql)) {
        await client.unsafe(statement);
      }
      return;
    }
    await client.unsafe(this.prepare(sql));
  }

  private prepare(sql: string): string {
    if (this.dialect === "sqlite") {
      return sql;
    }
    return toPostgresPlaceholders(sql);
  }
}

function toPostgresPlaceholders(sql: string): string {
  let index = 0;
  return sql.replaceAll("?", () => `$${++index}`);
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}
