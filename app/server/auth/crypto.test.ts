import { describe, expect, it } from "vitest";
import { createOpaqueToken, hashOpaqueToken, isOpaqueToken } from "./crypto";

describe("opaque auth tokens", () => {
  it("creates a token that can be validated by its purpose", () => {
    const token = createOpaqueToken("invite");

    expect(isOpaqueToken(token, "invite")).toBe(true);
    expect(isOpaqueToken(token, "session")).toBe(false);
  });

  it("stores only a deterministic hash, never the original token", () => {
    const token = createOpaqueToken("session");
    const hash = hashOpaqueToken(token);

    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
    expect(hashOpaqueToken(token)).toBe(hash);
  });

  it("rejects short or malformed tokens", () => {
    expect(isOpaqueToken("invite_short", "invite")).toBe(false);
    expect(isOpaqueToken("session_", "session")).toBe(false);
    expect(isOpaqueToken("device_not-a-session", "session")).toBe(false);
  });
});
