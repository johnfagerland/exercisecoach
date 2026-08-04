import { isRateLimitError } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "../_generated/api";
import { action, internalAction } from "../_generated/server";
import { rateLimiter } from "../rateLimits";
import {
  decryptWhoopSecret,
  encryptWhoopSecret,
  getWhoopAppConfig,
  isWhoopConfigured,
  supportedWhoopScopes,
  WHOOP_API_BASE_URL,
  WHOOP_AUTHORIZE_URL,
  WHOOP_READ_SCOPES,
  WHOOP_TOKEN_URL,
  type WhoopAppConfig,
} from "./config";
import { whoopRefreshDueAt } from "./client";
import { revokeWhoopGrantWithRetry } from "./tokenRevocation";

const FETCH_TIMEOUT_MS = 15_000;
const INITIAL_SYNC_DAYS = 30;
const MIN_OAUTH_ARTIFACT_LENGTH = 16;
const MAX_OAUTH_CODE_LENGTH = 4096;
const MAX_OAUTH_STATE_LENGTH = 1024;
const MAX_OAUTH_TICKET_LENGTH = 256;
const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_in: z.number().finite().positive(),
    token_type: z.string().min(1),
    scope: z.string().min(1),
  })
  .passthrough();
const profileResponseSchema = z.object({ user_id: z.number().int() }).passthrough();
const refreshTokenCandidateSchema = z.object({ refresh_token: z.string().min(1) }).passthrough();

export interface ParsedWhoopTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string[];
}

export function parseWhoopTokenResponse(raw: unknown): ParsedWhoopTokenResponse {
  const parsed = tokenResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
    throw new Error("Malformed Whoop OAuth token response");
  }
  const scopes = supportedWhoopScopes(parsed.data.scope.split(/\s+/));
  if (!scopes.includes("read:recovery") || !scopes.includes("offline")) {
    throw new Error("Whoop OAuth did not grant the required recovery and offline scopes");
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresInSeconds: parsed.data.expires_in,
    scopes,
  };
}

export function parseWhoopProfileResponse(raw: unknown): { whoopUserId: string } {
  const parsed = profileResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Malformed Whoop profile response");
  return { whoopUserId: String(parsed.data.user_id) };
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function hashOAuthArtifact(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function generateOpaqueValue(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function hasBoundedArtifactLength(value: string, maxLength: number): boolean {
  return value.length >= MIN_OAUTH_ARTIFACT_LENGTH && value.length <= maxLength;
}

export function buildWhoopAuthorizeUrl(config: WhoopAppConfig, state: string): string {
  const url = new URL(WHOOP_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", WHOOP_READ_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

async function responseJson(response: Response, errorMessage: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${errorMessage}: HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${errorMessage}: malformed JSON`);
  }
}

export type StartWhoopOAuthResult =
  { success: true; authorizeUrl: string } | { success: false; error: string };

export const startWhoopOAuth = action({
  args: {},
  handler: async (ctx): Promise<StartWhoopOAuthResult> => {
    if (!isWhoopConfigured()) {
      return { success: false, error: "Whoop integration is not available on this deployment." };
    }
    const userId = await ctx.runQuery(internal.lib.auth.resolveEffectiveUserId, {});
    if (!userId) return { success: false, error: "Not authenticated" };

    try {
      await rateLimiter.limit(ctx, "startWhoopOAuth", { key: userId, throws: true });
    } catch (error) {
      if (isRateLimitError(error)) {
        return {
          success: false,
          error: "Too many Whoop connection attempts. Please wait a minute and try again.",
        };
      }
      console.error("[whoopOAuth] failed to acquire start slot", { userId });
      return { success: false, error: "Unable to start Whoop connection right now." };
    }

    try {
      const state = generateOpaqueValue();
      await ctx.runMutation(internal.whoop.oauthArtifacts.saveOauthState, {
        userId,
        stateHash: await hashOAuthArtifact(state),
        now: Date.now(),
      });
      return {
        success: true,
        authorizeUrl: buildWhoopAuthorizeUrl(getWhoopAppConfig(), state),
      };
    } catch {
      console.error("[whoopOAuth] failed to start OAuth", { userId });
      return { success: false, error: "Failed to start Whoop OAuth. Please try again." };
    }
  },
});

export type IssueWhoopCallbackTicketResult = { success: true; ticket: string } | { success: false };

export const issueWhoopCallbackTicket = internalAction({
  args: { code: v.string(), state: v.string() },
  handler: async (ctx, { code, state }): Promise<IssueWhoopCallbackTicketResult> => {
    if (
      !isWhoopConfigured() ||
      !hasBoundedArtifactLength(code, MAX_OAUTH_CODE_LENGTH) ||
      !hasBoundedArtifactLength(state, MAX_OAUTH_STATE_LENGTH)
    ) {
      return { success: false };
    }
    try {
      const ticket = generateOpaqueValue();
      const stored: boolean = await ctx.runMutation(
        internal.whoop.oauthArtifacts.exchangeOauthStateForTicket,
        {
          stateHash: await hashOAuthArtifact(state),
          ticketHash: await hashOAuthArtifact(ticket),
          authorizationCodeEncrypted: await encryptWhoopSecret(code),
          now: Date.now(),
        },
      );
      return stored ? { success: true, ticket } : { success: false };
    } catch {
      console.error("[whoopOAuth] failed to issue callback ticket");
      return { success: false };
    }
  },
});

export type CompleteWhoopOAuthResult = { success: true } | { success: false; error: string };

export const completeWhoopOAuth = action({
  args: { ticket: v.string() },
  handler: async (ctx, { ticket }): Promise<CompleteWhoopOAuthResult> => {
    if (!isWhoopConfigured()) {
      return { success: false, error: "Whoop integration is not available on this deployment." };
    }
    if (!hasBoundedArtifactLength(ticket, MAX_OAUTH_TICKET_LENGTH)) {
      return { success: false, error: "Invalid or expired Whoop callback ticket" };
    }
    const userId = await ctx.runQuery(internal.lib.auth.resolveEffectiveUserId, {});
    if (!userId) return { success: false, error: "Not authenticated" };
    try {
      await rateLimiter.limit(ctx, "completeWhoopOAuth", { key: userId, throws: true });
    } catch (error) {
      if (isRateLimitError(error)) {
        return { success: false, error: "Too many Whoop completion attempts. Try again later." };
      }
      return { success: false, error: "Unable to complete Whoop connection right now." };
    }

    const now = Date.now();
    const encryptedCode = await ctx.runMutation(
      internal.whoop.oauthArtifacts.claimOauthCallbackTicket,
      { userId, ticketHash: await hashOAuthArtifact(ticket), now },
    );
    if (!encryptedCode) {
      return { success: false, error: "Invalid or expired Whoop callback ticket" };
    }

    let refreshTokenToRevoke: string | null = null;
    let connectionPersisted = false;
    try {
      const config = getWhoopAppConfig();
      const tokenResponse = await fetch(WHOOP_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: await decryptWhoopSecret(encryptedCode),
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: "authorization_code",
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const rawTokens = await responseJson(tokenResponse, "Whoop OAuth token exchange failed");
      const refreshTokenCandidate = refreshTokenCandidateSchema.safeParse(rawTokens);
      if (refreshTokenCandidate.success) {
        refreshTokenToRevoke = refreshTokenCandidate.data.refresh_token;
      }
      const tokens = parseWhoopTokenResponse(rawTokens);

      const profileResponse = await fetch(`${WHOOP_API_BASE_URL}/v2/user/profile/basic`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const profile = parseWhoopProfileResponse(
        await responseJson(profileResponse, "Whoop profile request failed"),
      );
      const generation = generateOpaqueValue();
      const tokenExpiresAt = now + tokens.expiresInSeconds * 1000;

      await ctx.runMutation(internal.whoop.connections.upsertActiveConnection, {
        userId,
        whoopUserId: profile.whoopUserId,
        generation,
        accessTokenEncrypted: await encryptWhoopSecret(tokens.accessToken),
        refreshTokenEncrypted: await encryptWhoopSecret(tokens.refreshToken),
        tokenExpiresAt,
        scopes: tokens.scopes,
        refreshDueAt: whoopRefreshDueAt(now, tokenExpiresAt),
        now,
      });
      connectionPersisted = true;
      await ctx.scheduler.runAfter(0, internal.whoop.sync.syncConnection, {
        userId,
        generation,
        days: INITIAL_SYNC_DAYS,
      });
      return { success: true };
    } catch (error) {
      if (refreshTokenToRevoke && !connectionPersisted) {
        try {
          const revoked = await revokeWhoopGrantWithRetry(refreshTokenToRevoke);
          if (!revoked) {
            console.error("[whoopOAuth] failed to revoke an unpersisted OAuth token", { userId });
          }
        } catch {
          console.error("[whoopOAuth] failed to revoke an unpersisted OAuth token", { userId });
        }
      }
      const message = error instanceof Error ? error.message : "";
      if (message === "This Whoop account is already connected to another Roni account") {
        return { success: false, error: message };
      }
      console.error("[whoopOAuth] failed to complete OAuth", { userId });
      return { success: false, error: "Failed to complete Whoop OAuth. Please try again." };
    }
  },
});
