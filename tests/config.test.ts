import { expect, test } from "bun:test";
import {
  defaultDbPath,
  readHttpServerConfig,
  readHttpTokens,
  readS3StorageConfig,
  readStoreConfig,
} from "../src/config";

test("defaultDbPath honors local comms override before home fallback", () => {
  expect(defaultDbPath({ LOCAL_AI_COMMS_DB: "/tmp/mailbox.sqlite" })).toBe(
    "/tmp/mailbox.sqlite",
  );
  expect(defaultDbPath({ HOME: "/Users/example" })).toBe(
    "/Users/example/.local/share/local-ai-comms.sqlite",
  );
});

test("readHttpTokens validates bootstrap token shape", () => {
  expect(() => readHttpTokens({ AGENT_MAILBOX_HTTP_TOKENS: "not-json" })).toThrow(
    /must be valid JSON/,
  );
  expect(() => readHttpTokens({ AGENT_MAILBOX_HTTP_TOKENS: "{}" })).toThrow(
    /must be a JSON array/,
  );
  expect(() =>
    readHttpTokens({
      AGENT_MAILBOX_HTTP_TOKENS: JSON.stringify([
        { token: "same", agent_id: "agent-a" },
        { token: "same", agent_id: "agent-b" },
      ]),
    }),
  ).toThrow(/duplicated/);
});

test("readHttpServerConfig normalizes path, port, db path, and bootstrap tokens", () => {
  const config = readHttpServerConfig({
    AGENT_MAILBOX_ADMIN_TOKEN: "admin",
    AGENT_MAILBOX_HTTP_HOST: "0.0.0.0",
    AGENT_MAILBOX_HTTP_PORT: "9001",
    AGENT_MAILBOX_HTTP_PATH: "mailbox",
    AGENT_MAILBOX_DB: "/tmp/http.sqlite",
    AGENT_MAILBOX_HTTP_TOKENS: JSON.stringify([
      {
        token: "agent-token",
        agent_id: "agent-a",
        agent_name: "Agent A",
        workspace: "repo-a",
      },
    ]),
  });

  expect(config).toMatchObject({
    adminToken: "admin",
    host: "0.0.0.0",
    port: 9001,
    path: "/mailbox",
    dbPath: "/tmp/http.sqlite",
    database: {
      kind: "sqlite",
      path: "/tmp/http.sqlite",
    },
  });
  expect(config.tokens[0]).toEqual({
    token: "agent-token",
    agent: {
      id: "agent-a",
      name: "Agent A",
      workspace: "repo-a",
    },
  });
});

test("readStoreConfig selects Postgres when DATABASE_URL is set", () => {
  expect(
    readStoreConfig({
      DATABASE_URL: "postgres://user:pass@example.com:5432/mailbox",
      LOCAL_AI_COMMS_DB: "/tmp/ignored.sqlite",
    }),
  ).toEqual({
    kind: "postgres",
    url: "postgres://user:pass@example.com:5432/mailbox",
  });
});

test("readS3StorageConfig normalizes coordinated AWS variables", () => {
  expect(
    readS3StorageConfig({
      AWS_ACCESS_KEY_ID: "access",
      AWS_DEFAULT_REGION: "us-east-1",
      AWS_ENDPOINT_URL: "https://s3.example.com",
      AWS_S3_BUCKET_NAME: "mailbox-artifacts",
      AWS_SECRET_ACCESS_KEY: "secret",
    }),
  ).toEqual({
    accessKeyId: "access",
    bucket: "mailbox-artifacts",
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    secretAccessKey: "secret",
    sessionToken: undefined,
  });
  expect(readS3StorageConfig({})).toBeNull();
});

test("readS3StorageConfig rejects partial storage config", () => {
  expect(() =>
    readS3StorageConfig({
      AWS_ACCESS_KEY_ID: "access",
      AWS_S3_BUCKET_NAME: "mailbox-artifacts",
    }),
  ).toThrow(/S3 storage config is incomplete/);
});

test("readHttpServerConfig rejects missing admin token and invalid ports", () => {
  expect(() => readHttpServerConfig({})).toThrow(/ADMIN_TOKEN/);
  expect(() =>
    readHttpServerConfig({
      AGENT_MAILBOX_ADMIN_TOKEN: "admin",
      AGENT_MAILBOX_HTTP_PORT: "70000",
    }),
  ).toThrow(/Invalid HTTP port/);
});
