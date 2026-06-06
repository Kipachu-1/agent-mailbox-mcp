import { expect, test } from "bun:test";
import { defaultDbPath, readHttpServerConfig, readHttpTokens } from "../src/config";

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

test("readHttpServerConfig rejects missing admin token and invalid ports", () => {
  expect(() => readHttpServerConfig({})).toThrow(/ADMIN_TOKEN/);
  expect(() =>
    readHttpServerConfig({
      AGENT_MAILBOX_ADMIN_TOKEN: "admin",
      AGENT_MAILBOX_HTTP_PORT: "70000",
    }),
  ).toThrow(/Invalid HTTP port/);
});
