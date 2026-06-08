import { S3Client } from "bun";
import type { S3StorageConfig } from "./config";
import type { ArtifactInput, ArtifactRecord } from "./store";

export const MAX_ARTIFACT_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_ARTIFACT_READ_BYTES = 1024 * 1024;

export interface UploadArtifactContentInput {
  artifactId: string;
  contentBase64?: string;
  contentText?: string;
  contentType?: string;
  filename?: string;
  label?: string;
  metadata?: Record<string, unknown>;
  ownerId: string;
  ownerType: string;
  permanentUrl?: string;
  type: ArtifactInput["type"];
  workspace: string;
}

export interface ReadArtifactContentOutput {
  artifact: ArtifactRecord;
  content: string;
  content_type: string;
  encoding: "base64" | "text";
  size: number;
}

export interface ArtifactStorage {
  readonly enabled: boolean;
  artifactInputForUpload(input: UploadArtifactContentInput): Promise<ArtifactInput>;
  presign(artifact: ArtifactRecord, expiresIn: number): string;
  read(
    artifact: ArtifactRecord,
    options?: {
      encoding?: "base64" | "text";
      maxBytes?: number;
    },
  ): Promise<ReadArtifactContentOutput>;
}

export class DisabledArtifactStorage implements ArtifactStorage {
  readonly enabled = false;

  artifactInputForUpload(): Promise<ArtifactInput> {
    throw new Error("S3 artifact storage is not configured.");
  }

  presign(): string {
    throw new Error("S3 artifact storage is not configured.");
  }

  read(): Promise<ReadArtifactContentOutput> {
    throw new Error("S3 artifact storage is not configured.");
  }
}

export class S3ArtifactStorage implements ArtifactStorage {
  readonly enabled = true;
  private readonly client: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    this.client = new S3Client(config);
  }

  async artifactInputForUpload(input: UploadArtifactContentInput): Promise<ArtifactInput> {
    const bytes = artifactBytes(input);
    if (bytes.byteLength > MAX_ARTIFACT_UPLOAD_BYTES) {
      throw new Error(
        `Artifact content is ${bytes.byteLength} bytes; maximum upload size is ${MAX_ARTIFACT_UPLOAD_BYTES} bytes.`,
      );
    }

    const filename = safeFilename(input.filename ?? `${input.artifactId}.bin`);
    const key = [
      "workspaces",
      pathSegment(input.workspace),
      pathSegment(input.ownerType),
      pathSegment(input.ownerId),
      pathSegment(input.artifactId),
      filename,
    ].join("/");
    const contentType = input.contentType?.trim() || "application/octet-stream";
    await this.client.write(key, bytes, { type: contentType });

    return {
      type: input.type,
      label: input.label,
      path: `s3://${this.config.bucket}/${key}`,
      url: input.permanentUrl,
      metadata: {
        ...(input.metadata ?? {}),
        s3: {
          bucket: this.config.bucket,
          content_type: contentType,
          filename,
          key,
          size: bytes.byteLength,
        },
      },
    };
  }

  presign(artifact: ArtifactRecord, expiresIn: number): string {
    const s3 = s3Location(artifact, this.config.bucket);
    return this.client.presign(s3.key, {
      expiresIn,
      method: "GET",
    });
  }

  async read(
    artifact: ArtifactRecord,
    options: {
      encoding?: "base64" | "text";
      maxBytes?: number;
    } = {},
  ): Promise<ReadArtifactContentOutput> {
    const s3 = s3Location(artifact, this.config.bucket);
    const maxBytes = Math.min(options.maxBytes ?? MAX_ARTIFACT_READ_BYTES, MAX_ARTIFACT_READ_BYTES);
    const stat = await this.client.stat(s3.key);
    if (stat.size > maxBytes) {
      throw new Error(
        `Artifact '${artifact.id}' is ${stat.size} bytes; maximum read size is ${maxBytes} bytes.`,
      );
    }

    const file = this.client.file(s3.key);
    const encoding = options.encoding ?? "text";
    const bytes = await file.bytes();
    const content =
      encoding === "base64"
        ? Buffer.from(bytes).toString("base64")
        : new TextDecoder().decode(bytes);
    return {
      artifact,
      content,
      content_type: s3.contentType,
      encoding,
      size: bytes.byteLength,
    };
  }
}

export function createArtifactStorage(config: S3StorageConfig | null): ArtifactStorage {
  return config ? new S3ArtifactStorage(config) : new DisabledArtifactStorage();
}

function artifactBytes(input: UploadArtifactContentInput): Uint8Array {
  const hasText = input.contentText !== undefined;
  const hasBase64 = input.contentBase64 !== undefined;
  if (hasText === hasBase64) {
    throw new Error("upload_artifact requires exactly one of content_text or content_base64.");
  }
  if (hasText) {
    return new TextEncoder().encode(input.contentText);
  }
  return new Uint8Array(Buffer.from(input.contentBase64 ?? "", "base64"));
}

function s3Location(
  artifact: ArtifactRecord,
  expectedBucket: string,
): {
  bucket: string;
  contentType: string;
  key: string;
} {
  const metadata = isRecord(artifact.metadata) ? artifact.metadata : {};
  const s3 = isRecord(metadata.s3) ? metadata.s3 : {};
  const bucket = stringValue(s3.bucket) || bucketFromPath(artifact.path);
  const key = stringValue(s3.key) || keyFromPath(artifact.path);
  if (!bucket || !key) {
    throw new Error(`Artifact '${artifact.id}' is not backed by S3 content.`);
  }
  if (bucket !== expectedBucket) {
    throw new Error(`Artifact '${artifact.id}' belongs to S3 bucket '${bucket}', not '${expectedBucket}'.`);
  }
  return {
    bucket,
    contentType: stringValue(s3.content_type) || "application/octet-stream",
    key,
  };
}

function bucketFromPath(path: string | null): string {
  const match = path?.match(/^s3:\/\/([^/]+)\/.+$/);
  return match?.[1] ?? "";
}

function keyFromPath(path: string | null): string {
  const match = path?.match(/^s3:\/\/[^/]+\/(.+)$/);
  return match?.[1] ?? "";
}

function safeFilename(value: string): string {
  const trimmed = value.trim();
  const basename = trimmed.split(/[\\/]/).pop() || "artifact.bin";
  return basename.replaceAll(/[^A-Za-z0-9._-]/g, "_") || "artifact.bin";
}

function pathSegment(value: string): string {
  return value.trim().replaceAll(/[^A-Za-z0-9._-]/g, "_") || "default";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
