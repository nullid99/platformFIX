import { createHash } from "node:crypto";
import { IdentityProvider } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { AuthServiceError } from "./auth-service";
import {
  createRandomValue,
  decryptSecret,
  encryptSecret,
  hashOpaqueToken,
  isOpaqueToken,
} from "./crypto";

const DISCORD_AUTHORIZATION_URL = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN_URL = "https://discord.com/api/v10/oauth2/token";
const DISCORD_USER_URL = "https://discord.com/api/v10/users/@me";
const CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;

type DiscordConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type DiscordAuthChallenge = {
  state: string;
  authorizationUrl: string;
};

export type ConsumedDiscordAuthChallenge = {
  codeVerifier: string;
  invitationToken: string | undefined;
  redirectUri: string;
};

export type DiscordIdentity = {
  provider: typeof IdentityProvider.DISCORD;
  providerSubject: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
};

type JsonRecord = Record<string, unknown>;

function getConfig(): DiscordConfig {
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
  const redirectUri = process.env.DISCORD_REDIRECT_URI?.trim();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new AuthServiceError("DISCORD_AUTH_FAILED", "Discord authentication is not configured");
  }

  return { clientId, clientSecret, redirectUri };
}

function hashPkceValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function asJsonRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthServiceError("DISCORD_AUTH_FAILED", "Discord returned an invalid response");
  }

  return value as JsonRecord;
}

function requireString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AuthServiceError("DISCORD_AUTH_FAILED", "Discord response is incomplete");
  }

  return value;
}

function optionalString(record: JsonRecord, key: string, maximumLength: number): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximumLength) : undefined;
}

export class DiscordOAuthService {
  public async createChallenge(invitationToken?: string): Promise<DiscordAuthChallenge> {
    const config = getConfig();
    if (invitationToken && !isOpaqueToken(invitationToken, "invite")) {
      throw new AuthServiceError("INVALID_INVITATION", "Invitation is invalid");
    }

    const state = createRandomValue();
    const codeVerifier = createRandomValue();
    const expiresAt = new Date(Date.now() + CHALLENGE_LIFETIME_MS);

    await prisma.discordAuthChallenge.create({
      data: {
        stateHash: hashOpaqueToken(state),
        codeVerifierCiphertext: encryptSecret(codeVerifier),
        invitationTokenCiphertext: invitationToken ? encryptSecret(invitationToken) : undefined,
        redirectUri: config.redirectUri,
        expiresAt,
      },
    });

    const authorizationUrl = new URL(DISCORD_AUTHORIZATION_URL);
    authorizationUrl.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: "identify",
      state,
      code_challenge: hashPkceValue(codeVerifier),
      code_challenge_method: "S256",
    }).toString();

    return { state, authorizationUrl: authorizationUrl.toString() };
  }

  public async consumeChallenge(state: string): Promise<ConsumedDiscordAuthChallenge> {
    const normalizedState = state.trim();
    if (!normalizedState) {
      throw new AuthServiceError("DISCORD_AUTH_FAILED", "Discord authentication state is missing");
    }

    const now = new Date();
    const challenge = await prisma.discordAuthChallenge.findUnique({
      where: { stateHash: hashOpaqueToken(normalizedState) },
    });

    if (!challenge || challenge.expiresAt <= now || challenge.usedAt) {
      throw new AuthServiceError("DISCORD_AUTH_FAILED", "Discord authentication state is invalid");
    }

    const claimed = await prisma.discordAuthChallenge.updateMany({
      where: { id: challenge.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });

    if (claimed.count !== 1) {
      throw new AuthServiceError("DISCORD_AUTH_FAILED", "Discord authentication state was already used");
    }

    return {
      codeVerifier: decryptSecret(challenge.codeVerifierCiphertext),
      invitationToken: challenge.invitationTokenCiphertext
        ? decryptSecret(challenge.invitationTokenCiphertext)
        : undefined,
      redirectUri: challenge.redirectUri,
    };
  }

  public async exchangeCode(code: string, challenge: ConsumedDiscordAuthChallenge): Promise<DiscordIdentity> {
    const config = getConfig();
    const normalizedCode = code.trim();
    if (!normalizedCode) {
      throw new AuthServiceError("DISCORD_AUTH_FAILED", "Discord authorization code is missing");
    }

    const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const tokenResponse = await fetch(DISCORD_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: normalizedCode,
        redirect_uri: challenge.redirectUri,
        client_id: config.clientId,
        code_verifier: challenge.codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!tokenResponse.ok) {
      throw new AuthServiceError("DISCORD_AUTH_FAILED", "Discord token exchange failed");
    }

    const token = asJsonRecord(await tokenResponse.json());
    const accessToken = requireString(token, "access_token");
    const userResponse = await fetch(DISCORD_USER_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!userResponse.ok) {
      throw new AuthServiceError("DISCORD_AUTH_FAILED", "Discord user verification failed");
    }

    const user = asJsonRecord(await userResponse.json());
    const providerSubject = requireString(user, "id");
    const username = optionalString(user, "username", 100);
    const displayName = optionalString(user, "global_name", 200) ?? username;
    const avatarHash = optionalString(user, "avatar", 200);
    const avatarUrl = avatarHash
      ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(providerSubject)}/${encodeURIComponent(avatarHash)}.png?size=128`
      : "https://cdn.discordapp.com/embed/avatars/0.png";

    return {
      provider: IdentityProvider.DISCORD,
      providerSubject,
      username,
      displayName,
      avatarUrl,
    };
  }
}

export const discordOAuthService = new DiscordOAuthService();
