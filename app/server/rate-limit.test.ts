import { describe, expect, it } from "vitest";
import { FixedWindowLimiter, findRateLimitRule } from "./rate-limit";

describe("FixedWindowLimiter (STG-5)", () => {
  it("allows up to the limit, refuses the next, and opens again in the next window", () => {
    const limiter = new FixedWindowLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) expect(limiter.hit("k", 3, 60_000, now + i)).toBe(true);
    expect(limiter.hit("k", 3, 60_000, now + 10)).toBe(false);
    expect(limiter.hit("other", 3, 60_000, now + 10)).toBe(true);
    expect(limiter.hit("k", 3, 60_000, now + 60_000)).toBe(true);
  });

  it("matches only the limited routes", () => {
    expect(findRateLimitRule("POST", "/api/files")?.name).toBe("file-create");
    expect(findRateLimitRule("PUT", "/api/files/abc/content")?.name).toBe("file-upload");
    expect(findRateLimitRule("POST", "/api/discussions/abc/messages")?.name).toBe("discussion-reply");
    expect(findRateLimitRule("GET", "/api/files/abc/content")).toBeUndefined();
    expect(findRateLimitRule("GET", "/api/course")).toBeUndefined();
  });
});
