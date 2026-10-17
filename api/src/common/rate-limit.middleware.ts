import type { NextFunction, Request, Response } from "express";
import { AUTH_COOKIE_NAMES } from "@/app/server/auth";
import { hashOpaqueToken } from "@/app/server/auth/crypto";
import { FixedWindowLimiter, findRateLimitRule } from "@/app/server/rate-limit";
import { normalizeRequestIp } from "./request-context";

const limiter = new FixedWindowLimiter();

/** Express middleware for API_RATE_LIMIT_RULES (security review STG-5). Answers 429 when over. */
export function apiRateLimit(request: Request, response: Response, next: NextFunction): void {
  const rule = findRateLimitRule(request.method, request.path);
  if (!rule) return next();
  const cookies = request.cookies as Record<string, string | undefined> | undefined;
  const session = cookies?.[AUTH_COOKIE_NAMES.session];
  // Per person when signed in (several students behind one Wi-Fi share an IP), per IP otherwise.
  const who = session ? `s:${hashOpaqueToken(session)}` : `ip:${normalizeRequestIp(request.ip) ?? "unknown"}`;
  if (limiter.hit(`${rule.name}:${who}`, rule.limit, rule.windowMs)) return next();
  console.warn("Rate limit hit", JSON.stringify({ rule: rule.name, ip: normalizeRequestIp(request.ip) ?? null }));
  response.status(429).json({ statusCode: 429, message: "Слишком много запросов подряд. Подождите несколько минут и попробуйте снова." });
}
