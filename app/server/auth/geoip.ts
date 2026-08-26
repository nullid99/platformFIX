import { isIP } from "node:net";
import type { AuthRequestContext } from "./types";

type GeoLocation = Pick<AuthRequestContext, "countryCode" | "city">;

type GeoLookupResponse = Record<string, unknown>;

type CacheEntry = {
  value: GeoLocation;
  expiresAt: number;
};

const DEFAULT_LOOKUP_URL = "https://ipwho.is/{ip}";
const LOOKUP_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const locationCache = new Map<string, CacheEntry>();

function optionalText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximumLength) : undefined;
}

export function normalizeAuthIp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const withoutZone = value.trim().replace(/^\[|\]$/g, "").split("%")[0];
  const normalized = withoutZone.toLowerCase().startsWith("::ffff:")
    ? withoutZone.slice(7)
    : withoutZone;

  return isIP(normalized) === 0 ? undefined : normalized;
}

function normalizeIp(value: string): string {
  return normalizeAuthIp(value) ?? "";
}

function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }

  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function isPublicIp(value: string): boolean {
  const ip = normalizeIp(value);
  const version = isIP(ip);
  if (version === 4) return !isPrivateIpv4(ip);
  if (version !== 6) return false;

  const normalized = ip.toLowerCase();
  return normalized !== "::1"
    && !normalized.startsWith("fc")
    && !normalized.startsWith("fd")
    && !normalized.startsWith("fe8")
    && !normalized.startsWith("fe9")
    && !normalized.startsWith("fea")
    && !normalized.startsWith("feb")
    && normalized !== "::";
}

function getLookupUrl(ip: string): string {
  const template = process.env.GEOIP_LOOKUP_URL?.trim() || DEFAULT_LOOKUP_URL;
  return template.includes("{ip}")
    ? template.replaceAll("{ip}", encodeURIComponent(ip))
    : `${template.replace(/\/$/, "")}/${encodeURIComponent(ip)}`;
}

function parseResponse(value: unknown): GeoLocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const response = value as GeoLookupResponse;
  if (response.success === false) return {};

  const countryCode = optionalText(response.country_code ?? response.countryCode, 10)?.toUpperCase();
  const city = optionalText(response.city, 100);
  return { countryCode, city };
}

async function lookup(ip: string): Promise<GeoLocation> {
  const cached = locationCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) locationCache.delete(ip);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const response = await fetch(getLookupUrl(ip), {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return {};

    const location = parseResponse(await response.json() as unknown);
    if (location.countryCode || location.city) {
      locationCache.set(ip, { value: location, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    return location;
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

/** Enriches a trusted server-side request context without blocking authentication on GeoIP. */
export async function enrichAuthRequestContext(input: AuthRequestContext): Promise<AuthRequestContext> {
  const normalizedInput = normalizeAuthRequestContext(input);
  if (!normalizedInput.ipAddress || (normalizedInput.countryCode && normalizedInput.city) || !isPublicIp(normalizedInput.ipAddress)) return normalizedInput;
  if (process.env.GEOIP_ENABLED === "false") return normalizedInput;

  const location = await lookup(normalizeIp(normalizedInput.ipAddress));
  return {
    ...normalizedInput,
    countryCode: normalizedInput.countryCode ?? location.countryCode,
    city: normalizedInput.city ?? location.city,
  };
}

/** Normalizes request metadata before it can be persisted to an audit record. */
export function normalizeAuthRequestContext(input: AuthRequestContext): AuthRequestContext {
  const ipAddress = normalizeAuthIp(input.ipAddress);
  return ipAddress === input.ipAddress ? input : { ...input, ipAddress };
}

export function isGeoIpLookupCandidate(value: string): boolean {
  return isPublicIp(value);
}
