import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ArtifactStorage,
  ReadArtifactContentOutput,
  UploadArtifactContentInput,
} from "../src/artifact-storage";
import { LocalCommsStore, type ArtifactInput, type ArtifactRecord } from "../src/store";
import { createCommunicationTools } from "../src/tools";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3 artifact tools upload, read, and presign visible artifacts", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const storage = new FakeArtifactStorage();
  try {
    const message = await store.sendMessage({
      senderId: "codex",
      workspace: "repo-a",
      recipientId: "claude",
      body: "Please inspect this artifact.",
    });
    const tools = createCommunicationTools(
      store,
      { id: "claude", name: "Claude", workspace: "repo-a" },
      storage,
    );

    const upload = await runTool(tools, "upload_artifact", {
      owner_type: "message",
      owner_id: message.id,
      label: "log",
      filename: "output.log",
      content_type: "text/plain",
      content_text: "artifact body",
      metadata: { source: "test" },
    });
    const artifact = upload.artifact as ArtifactRecord;

    expect(artifact.id).toBeString();
    expect(artifact.path).toBe(`s3://fake-bucket/${storage.keyFor(artifact)}`);
    expect((artifact.metadata as Record<string, unknown>).source).toBe("test");
    expect((await store.listVisibleArtifacts("claude", "repo-a", "message", message.id))[0]?.id).toBe(
      artifact.id,
    );

    const read = await runTool(tools, "read_artifact_content", {
      owner_type: "message",
      owner_id: message.id,
      artifact_id: artifact.id,
    });
    expect(read.artifact_content).toMatchObject({
      content: "artifact body",
      content_type: "text/plain",
      encoding: "text",
      size: 13,
    });

    const presign = await runTool(tools, "presign_artifact", {
      owner_type: "message",
      owner_id: message.id,
      artifact_id: artifact.id,
      expires_in_seconds: 120,
    });
    expect(presign.url).toBe(`https://example.test/${storage.keyFor(artifact)}?expires=120`);
  } finally {
    await store.close();
  }
});

async function runTool(
  tools: ReturnType<typeof createCommunicationTools>,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = tools.find((item) => item.name === name);
  expect(tool).toBeDefined();
  const output = (await tool!.run(input)) as { result: Record<string, unknown> };
  return output.result;
}

class FakeArtifactStorage implements ArtifactStorage {
  readonly enabled = true;
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async artifactInputForUpload(input: UploadArtifactContentInput): Promise<ArtifactInput> {
    const bytes =
      input.contentText !== undefined
        ? new TextEncoder().encode(input.contentText)
        : new Uint8Array(Buffer.from(input.contentBase64 ?? "", "base64"));
    const key = [
      "workspaces",
      input.workspace,
      input.ownerType,
      input.ownerId,
      input.artifactId,
      input.filename ?? `${input.artifactId}.bin`,
    ].join("/");
    const contentType = input.contentType ?? "application/octet-stream";
    this.objects.set(key, { bytes, contentType });
    return {
      type: input.type,
      label: input.label,
      path: `s3://fake-bucket/${key}`,
      metadata: {
        ...(input.metadata ?? {}),
        s3: {
          bucket: "fake-bucket",
          content_type: contentType,
          filename: input.filename,
          key,
          size: bytes.byteLength,
        },
      },
    };
  }

  keyFor(artifact: ArtifactRecord): string {
    const metadata = artifact.metadata as { s3?: { key?: string } };
    return metadata.s3?.key ?? "";
  }

  presign(artifact: ArtifactRecord, expiresIn: number): string {
    return `https://example.test/${this.keyFor(artifact)}?expires=${expiresIn}`;
  }

  async read(
    artifact: ArtifactRecord,
    options: { encoding?: "base64" | "text"; maxBytes?: number } = {},
  ): Promise<ReadArtifactContentOutput> {
    const key = this.keyFor(artifact);
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`Missing fake object '${key}'.`);
    }
    if (options.maxBytes !== undefined && object.bytes.byteLength > options.maxBytes) {
      throw new Error("Too large.");
    }
    const encoding = options.encoding ?? "text";
    return {
      artifact,
      content:
        encoding === "base64"
          ? Buffer.from(object.bytes).toString("base64")
          : new TextDecoder().decode(object.bytes),
      content_type: object.contentType,
      encoding,
      size: object.bytes.byteLength,
    };
  }
}

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-artifacts-"));
  tempDirs.push(dir);
  return { dir, path: join(dir, "mailbox.sqlite") };
}
