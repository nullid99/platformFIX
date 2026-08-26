import type { Request } from "express";
import { isIP } from "node:net";
import type { AuthRequestContext } from "@/app/server/auth";

function getOptionalString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximumLength) : undefined;
}

/**
 * Keep only an address parsed by Node/Express. This prevents malformed values
 * from entering the audit trail and normalizes Docker's IPv4-mapped form.
 */
export function normalizeRequestIp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const withoutZone = value.trim().replace(/^\[|\]$/g, "").split("%", 1)[0];
  const normalized = withoutZone.toLowerCase().startsWith("::ffff:")
    ? withoutZone.slice(7)
    : withoutZone;
  return isIP(normalized) === 0 ? undefined : normalized;
}

export function getRequestContext(request: Request): AuthRequestContext {
  // Express resolves request.ip using the configured trusted-proxy hop count.
  // Never trust a forwarded header directly: clients can send it themselves.
  const ipAddress = normalizeRequestIp(request.ip ?? request.socket.remoteAddress);

  return {
    ipAddress,
    userAgent: getOptionalString(request.headers["user-agent"], 500),
    deviceName: getOptionalString(request.headers["x-device-name"], 100),
  };
}
