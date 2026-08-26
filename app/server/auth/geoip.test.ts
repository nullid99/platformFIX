import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichAuthRequestContext, isGeoIpLookupCandidate, normalizeAuthIp } from "./geoip";

describe("geoip request enrichment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("normalizes and validates the IP before persistence", () => {
    expect(normalizeAuthIp("::ffff:203.0.113.10")).toBe("203.0.113.10");
    expect(normalizeAuthIp("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeAuthIp("not-an-ip")).toBeUndefined();
  });

  it("does not look up loopback or private addresses", async () => {
    expect(isGeoIpLookupCandidate("::1")).toBe(false);
    expect(isGeoIpLookupCandidate("192.168.1.10")).toBe(false);
    await expect(enrichAuthRequestContext({ ipAddress: "::1" })).resolves.toEqual({ ipAddress: "::1" });
  });

  it("maps provider country and city without exposing the raw response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, country_code: "ua", city: "Kyiv", ip: "8.8.8.8" })),
    ));

    await expect(enrichAuthRequestContext({ ipAddress: "8.8.8.8" })).resolves.toEqual({
      ipAddress: "8.8.8.8",
      countryCode: "UA",
      city: "Kyiv",
    });
  });

  it("does not fail authentication when GeoIP provider is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));

    await expect(enrichAuthRequestContext({ ipAddress: "1.1.1.1" })).resolves.toEqual({
      ipAddress: "1.1.1.1",
    });
  });
});
