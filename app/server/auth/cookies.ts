import type { SessionCredentials } from "./types";

const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const DEVICE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const SECURE_COOKIES = process.env.AUTH_COOKIE_SECURE === "true"
  || (process.env.AUTH_COOKIE_SECURE !== "false" && process.env.NODE_ENV === "production");
const HOST_COOKIE_PREFIX = SECURE_COOKIES ? "__Host-" : "";

export const AUTH_COOKIE_NAMES = {
  session: `${HOST_COOKIE_PREFIX}fix_session`,
  device: `${HOST_COOKIE_PREFIX}fix_device`,
  discordState: `${HOST_COOKIE_PREFIX}fix_discord_state`,
} as const;

export type AuthCookie = {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    secure: boolean;
    sameSite: "lax";
    path: "/";
    maxAge: number;
  };
};

function getCookieOptions(maxAgeSeconds: number): AuthCookie["options"] {
  return {
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: "lax",
    path: "/",
    // Express serializes `maxAge` in milliseconds, while our policy constants use seconds.
    maxAge: maxAgeSeconds * 1000,
  };
}

export function getAuthCookies(credentials: SessionCredentials): AuthCookie[] {
  return [
    {
      name: AUTH_COOKIE_NAMES.session,
      value: credentials.sessionToken,
      options: getCookieOptions(SESSION_COOKIE_MAX_AGE_SECONDS),
    },
    {
      name: AUTH_COOKIE_NAMES.device,
      value: credentials.deviceKey,
      options: getCookieOptions(DEVICE_COOKIE_MAX_AGE_SECONDS),
    },
  ];
}

export function getExpiredAuthCookies(): AuthCookie[] {
  return [
    {
      name: AUTH_COOKIE_NAMES.session,
      value: "",
      options: getCookieOptions(0),
    },
    {
      name: AUTH_COOKIE_NAMES.device,
      value: "",
      options: getCookieOptions(0),
    },
  ];
}

export function getDiscordStateCookie(state: string): AuthCookie {
  return {
    name: AUTH_COOKIE_NAMES.discordState,
    value: state,
    options: getCookieOptions(10 * 60),
  };
}

export function getExpiredDiscordStateCookie(): AuthCookie {
  return {
    name: AUTH_COOKIE_NAMES.discordState,
    value: "",
    options: getCookieOptions(0),
  };
}
