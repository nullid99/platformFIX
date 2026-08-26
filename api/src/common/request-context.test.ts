import { describe, expect, it } from "vitest";
import { normalizeRequestIp } from "./request-context";

describe("normalizeRequestIp", () => {
  it("normalizes an IPv4-mapped address from a container proxy", () => {
    expect(normalizeRequestIp("::ffff:203.0.113.10")).toBe("203.0.113.10");
  });

  it("accepts bracketed IPv6 and removes a zone identifier", () => {
    expect(normalizeRequestIp("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeRequestIp("fe80::1%lo0")).toBe("fe80::1");
  });

  it("rejects missing and malformed values", () => {
    expect(normalizeRequestIp(undefined)).toBeUndefined();
    expect(normalizeRequestIp("not-an-ip")).toBeUndefined();
    expect(normalizeRequestIp("203.0.113.999")).toBeUndefined();
  });
});
