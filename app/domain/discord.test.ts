import { describe, expect, it } from "vitest";
import { isDiscordUserId } from "./discord";

describe("isDiscordUserId", () => {
  it("accepts a Discord snowflake", () => {
    expect(isDiscordUserId("1535254297472925738")).toBe(true);
  });

  it("rejects usernames, short values and malformed IDs", () => {
    expect(isDiscordUserId("zagadка.exe")).toBe(false);
    expect(isDiscordUserId("123456789")).toBe(false);
    expect(isDiscordUserId("1535254297472925738x")).toBe(false);
  });
});
