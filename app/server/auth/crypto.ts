import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const OPAQUE_TOKEN_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

export function createOpaqueToken(prefix: "invite" | "session" | "device" | "email"): string {
  return `${prefix}_${randomBytes(OPAQUE_TOKEN_BYTES).toString("base64url")}`;
}

export function createRandomValue(): string {
  return randomBytes(OPAQUE_TOKEN_BYTES).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isOpaqueToken(token: string, prefix: "invite" | "session" | "device" | "email"): boolean {
  return token.startsWith(`${prefix}_`) && token.length >= prefix.length + 43;
}

function getEncryptionKey(): Buffer {
  const secret = process.env.AUTH_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_ENCRYPTION_KEY must contain at least 32 characters");
  }

  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function decryptSecret(value: string): string {
  const payload = Buffer.from(value, "base64url");
  if (payload.length <= AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES) {
    throw new Error("Encrypted value is invalid");
  }

  const iv = payload.subarray(0, AES_GCM_IV_BYTES);
  const tag = payload.subarray(AES_GCM_IV_BYTES, AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES);
  const ciphertext = payload.subarray(AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
