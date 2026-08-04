import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  decryptWhoopSecret,
  getWhoopAppConfig,
  WHOOP_API_BASE_URL,
  WHOOP_TOKEN_URL,
} from "./config";

const REVOKE_TIMEOUT_MS = 10_000;
const REVOKE_MAX_ATTEMPTS = 3;
const REVOKE_BASE_BACKOFF_MS = 250;
const REVOKE_MAX_BACKOFF_MS = 5_000;

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type Sleeper = (delayMs: number) => Promise<void>;
type Revoker = (refreshToken: string) => Promise<boolean>;

interface RevokeRetryOptions {
  fetcher?: Fetcher;
  random?: () => number;
  sleep?: Sleeper;
}

function revokeRetryDelayMs(attempt: number, random: () => number): number {
  const exponential = Math.min(REVOKE_MAX_BACKOFF_MS, REVOKE_BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Revoke a Whoop OAuth grant given its refresh token. Whoop's revoke endpoint
 * (`DELETE /v2/user/access`) authenticates with a bearer access token, so the
 * refresh token is exchanged first; an `invalid_grant` on that exchange means
 * the grant is already dead and counts as success.
 */
export async function revokeWhoopGrantWithRetry(
  refreshToken: string,
  options: RevokeRetryOptions = {},
): Promise<boolean> {
  const { fetcher = fetch, random = Math.random, sleep: wait = sleep } = options;
  const config = getWhoopAppConfig();
  for (let attempt = 1; attempt <= REVOKE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const tokenResponse = await fetcher(WHOOP_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
          scope: "offline",
        }),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
      if (tokenResponse.status === 400 || tokenResponse.status === 401) return true;
      if (!tokenResponse.ok) {
        if (!isRetryableStatus(tokenResponse.status)) return false;
      } else {
        const raw: unknown = await tokenResponse.json();
        const accessToken =
          typeof raw === "object" && raw !== null && "access_token" in raw
            ? String((raw as { access_token: unknown }).access_token)
            : "";
        if (!accessToken) return false;
        const revokeResponse = await fetcher(`${WHOOP_API_BASE_URL}/v2/user/access`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
        });
        if (revokeResponse.ok || revokeResponse.status === 401 || revokeResponse.status === 404) {
          return true;
        }
        if (!isRetryableStatus(revokeResponse.status)) return false;
      }
    } catch {
      // Retry transient network failures without logging credentials or bodies.
    }
    if (attempt < REVOKE_MAX_ATTEMPTS) {
      await wait(revokeRetryDelayMs(attempt, random));
    }
  }
  return false;
}

export async function revokeEncryptedWhoopToken(refreshTokenEncrypted: string): Promise<boolean> {
  try {
    return await revokeWhoopGrantWithRetry(await decryptWhoopSecret(refreshTokenEncrypted));
  } catch {
    return false;
  }
}

/**
 * A token refresh rotated the refresh token but the new pair could not be
 * persisted (connection changed mid-flight). Revoke the orphaned grant unless
 * a newer connection generation now owns it.
 */
export async function resolveLostWhoopTokenRefresh(
  ctx: Pick<ActionCtx, "runQuery">,
  {
    userId,
    generation,
    discardedRefreshToken,
    revoke = revokeWhoopGrantWithRetry,
  }: {
    userId: Id<"users">;
    generation: string;
    discardedRefreshToken: string;
    revoke?: Revoker;
  },
): Promise<string> {
  const latest = await ctx.runQuery(internal.whoop.connections.getConnectionByUserId, { userId });
  if (latest?.status === "active" && latest.generation === generation) {
    return decryptWhoopSecret(latest.accessTokenEncrypted);
  }
  if (!latest || latest.generation === generation) {
    const revoked = await revoke(discardedRefreshToken);
    if (!revoked) {
      console.error("[whoopSync] failed to revoke a discarded rotated token", {
        userId,
        generation,
      });
    }
  }
  throw new Error("Whoop connection changed during sync");
}
