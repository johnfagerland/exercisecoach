import { z } from "zod";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  decryptWhoopSecret,
  encryptWhoopSecret,
  getWhoopAppConfig,
  supportedWhoopScopes,
  WHOOP_API_BASE_URL,
  WHOOP_TOKEN_URL,
  type WhoopReadScope,
} from "./config";
import { resolveLostWhoopTokenRefresh } from "./tokenRevocation";

const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const MAX_COLLECTION_PAGES = 20;
const MAX_SYNC_LIST_PAGES = 24;
const MAX_SYNC_LIST_DURATION_MS = 4 * 60 * 1000;
const COLLECTION_PAGE_LIMIT = 25;

const collectionResponseSchema = z
  .object({
    records: z.array(z.unknown()).default([]),
    next_token: z.string().nullable().optional(),
  })
  .passthrough();
const refreshTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().finite().positive(),
    token_type: z.string().min(1),
    scope: z.string().min(1).optional(),
  })
  .passthrough();
const oauthErrorSchema = z.object({ error: z.string() }).passthrough();

export type WhoopCollection = "recovery" | "sleep" | "cycle";

const COLLECTION_PATHS: Readonly<Record<WhoopCollection, string>> = {
  recovery: "v2/recovery",
  sleep: "v2/activity/sleep",
  cycle: "v2/cycle",
};

export const WHOOP_SCOPE_BY_COLLECTION: Readonly<Record<WhoopCollection, WhoopReadScope>> = {
  recovery: "read:recovery",
  sleep: "read:sleep",
  cycle: "read:cycles",
};

export function whoopCollectionsForScopes(scopes: readonly string[]): WhoopCollection[] {
  const granted = new Set(supportedWhoopScopes(scopes));
  return (Object.keys(COLLECTION_PATHS) as WhoopCollection[]).filter((collection) =>
    granted.has(WHOOP_SCOPE_BY_COLLECTION[collection]),
  );
}

export interface WhoopListBudget {
  deadlineAt: number;
  remainingPages: number;
}

export function createWhoopListBudget(now = Date.now()): WhoopListBudget {
  return {
    deadlineAt: now + MAX_SYNC_LIST_DURATION_MS,
    remainingPages: MAX_SYNC_LIST_PAGES,
  };
}

export interface ParsedWhoopRefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string[];
}

export function parseWhoopRefreshResponse(
  raw: unknown,
  existingRefreshToken: string,
  existingScopes: readonly string[],
): ParsedWhoopRefreshResponse {
  const parsed = refreshTokenResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
    throw new Error("Malformed Whoop OAuth refresh response");
  }
  const scopes = supportedWhoopScopes(
    parsed.data.scope ? parsed.data.scope.split(/\s+/) : existingScopes,
  );
  if (scopes.length === 0) {
    throw new Error("Whoop OAuth refresh granted no supported read scopes");
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? existingRefreshToken,
    expiresInSeconds: parsed.data.expires_in,
    scopes,
  };
}

export function parseWhoopCollectionResponse(raw: unknown): {
  records: unknown[];
  nextToken?: string;
} {
  const parsed = collectionResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Malformed Whoop collection response");
  return { records: parsed.data.records, nextToken: parsed.data.next_token ?? undefined };
}

export function buildWhoopCollectionUrl({
  collection,
  start,
  end,
  nextToken,
}: {
  collection: WhoopCollection;
  start: string;
  end: string;
  nextToken?: string;
}): string {
  const url = new URL(`${WHOOP_API_BASE_URL}/${COLLECTION_PATHS[collection]}`);
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);
  url.searchParams.set("limit", String(COLLECTION_PAGE_LIMIT));
  if (nextToken) url.searchParams.set("nextToken", nextToken);
  return url.toString();
}

export function whoopRefreshDueAt(now: number, tokenExpiresAt: number): number {
  return Math.max(now, Math.min(now + SYNC_INTERVAL_MS, tokenExpiresAt - REFRESH_SKEW_MS));
}

async function parseJson(response: Response, errorMessage: string): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") throw new Error(errorMessage);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(errorMessage);
  }
}

function requestTimeoutMs(budget: WhoopListBudget): number {
  const remainingMs = budget.deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error("Whoop aggregate request time budget exceeded");
  }
  return Math.max(1, Math.min(FETCH_TIMEOUT_MS, remainingMs));
}

async function disconnectForAuthFailure(
  ctx: Pick<ActionCtx, "runMutation">,
  userId: Id<"users">,
  generation: string,
  reason: "permission_revoked" | "token_invalid",
  expectedTokenExpiresAt?: number,
): Promise<boolean> {
  return ctx.runMutation(internal.whoop.connections.markDisconnected, {
    userId,
    generation,
    reason,
    now: Date.now(),
    ...(expectedTokenExpiresAt === undefined ? {} : { expectedTokenExpiresAt }),
  });
}

async function refreshAccessToken(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  userId: Id<"users">,
  connection: Extract<Doc<"whoopConnections">, { status: "active" }>,
  budget: WhoopListBudget,
): Promise<string> {
  const refreshToken = await decryptWhoopSecret(connection.refreshTokenEncrypted);
  const config = getWhoopAppConfig();
  const response = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      // Whoop requires re-requesting `offline` on refresh to keep rotating
      // refresh tokens flowing.
      scope: "offline",
    }),
    signal: AbortSignal.timeout(requestTimeoutMs(budget)),
  });
  const raw = await parseJson(response, "Malformed Whoop OAuth refresh response");
  if (!response.ok) {
    const oauthError = oauthErrorSchema.safeParse(raw);
    if (oauthError.success && oauthError.data.error === "invalid_grant") {
      const disconnected = await disconnectForAuthFailure(
        ctx,
        userId,
        connection.generation,
        "token_invalid",
        connection.tokenExpiresAt,
      );
      if (disconnected) throw new Error("Whoop authorization expired. Reconnect Whoop.");

      const latest = await ctx.runQuery(internal.whoop.connections.getActiveConnectionByUserId, {
        userId,
      });
      if (!latest || latest.generation !== connection.generation) {
        throw new Error("Whoop connection changed during sync");
      }
      return decryptWhoopSecret(latest.accessTokenEncrypted);
    }
    throw new Error(`Whoop OAuth refresh failed with HTTP ${response.status}`);
  }

  const refreshed = parseWhoopRefreshResponse(raw, refreshToken, connection.scopes);
  const now = Date.now();
  const tokenExpiresAt = now + refreshed.expiresInSeconds * 1000;
  const saved = await ctx.runMutation(internal.whoop.connections.replaceTokens, {
    userId,
    generation: connection.generation,
    accessTokenEncrypted: await encryptWhoopSecret(refreshed.accessToken),
    refreshTokenEncrypted: await encryptWhoopSecret(refreshed.refreshToken),
    tokenExpiresAt,
    expectedTokenExpiresAt: connection.tokenExpiresAt,
    scopes: refreshed.scopes,
    refreshDueAt: whoopRefreshDueAt(now, tokenExpiresAt),
  });
  if (saved) return refreshed.accessToken;

  return resolveLostWhoopTokenRefresh(ctx, {
    userId,
    generation: connection.generation,
    discardedRefreshToken: refreshed.refreshToken,
  });
}

async function getAccessToken(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  userId: Id<"users">,
  generation: string,
  collection: WhoopCollection,
  forceRefresh: boolean,
  budget: WhoopListBudget,
): Promise<string> {
  const connection = await ctx.runQuery(internal.whoop.connections.getActiveConnectionByUserId, {
    userId,
  });
  if (!connection || connection.generation !== generation) {
    throw new Error("Whoop connection changed during sync");
  }
  if (!connection.scopes.includes(WHOOP_SCOPE_BY_COLLECTION[collection])) {
    throw new Error(`Whoop permission is not granted for ${collection}`);
  }
  if (forceRefresh || connection.tokenExpiresAt <= Date.now() + REFRESH_SKEW_MS) {
    return refreshAccessToken(ctx, userId, connection, budget);
  }
  return decryptWhoopSecret(connection.accessTokenEncrypted);
}

async function authorizedGet(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  userId: Id<"users">,
  generation: string,
  collection: WhoopCollection,
  url: string,
  budget: WhoopListBudget,
): Promise<Response> {
  const request = async (accessToken: string) =>
    fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(requestTimeoutMs(budget)),
    });

  let response = await request(
    await getAccessToken(ctx, userId, generation, collection, false, budget),
  );
  if (response.status === 401) {
    response = await request(
      await getAccessToken(ctx, userId, generation, collection, true, budget),
    );
    if (response.status === 401) {
      await disconnectForAuthFailure(ctx, userId, generation, "token_invalid");
      throw new Error("Whoop authorization expired. Reconnect Whoop.");
    }
  }
  return response;
}

export async function listWhoopRecords(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  {
    userId,
    generation,
    collection,
    start,
    end,
    budget,
  }: {
    userId: Id<"users">;
    generation: string;
    collection: WhoopCollection;
    start: string;
    end: string;
    budget: WhoopListBudget;
  },
): Promise<unknown[]> {
  return collectWhoopPages(
    async (nextToken) => {
      const response = await authorizedGet(
        ctx,
        userId,
        generation,
        collection,
        buildWhoopCollectionUrl({ collection, start, end, nextToken }),
        budget,
      );
      if (!response.ok) {
        throw new Error(`Whoop ${collection} request failed with HTTP ${response.status}`);
      }
      return parseWhoopCollectionResponse(
        await parseJson(response, "Malformed Whoop collection response"),
      );
    },
    MAX_COLLECTION_PAGES,
    budget,
  );
}

export async function collectWhoopPages(
  fetchPage: (nextToken?: string) => Promise<{
    records: readonly unknown[];
    nextToken?: string;
  }>,
  maxPages = MAX_COLLECTION_PAGES,
  budget?: WhoopListBudget,
): Promise<unknown[]> {
  const records: unknown[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    if (budget) {
      if (budget.remainingPages <= 0) {
        throw new Error("Whoop pagination exceeded the aggregate page budget");
      }
      requestTimeoutMs(budget);
      budget.remainingPages -= 1;
    }
    const parsed = await fetchPage(nextToken);
    if (budget) requestTimeoutMs(budget);
    records.push(...parsed.records);
    if (!parsed.nextToken) return records;
    if (seenTokens.has(parsed.nextToken)) {
      throw new Error("Whoop returned a repeated page token");
    }
    seenTokens.add(parsed.nextToken);
    nextToken = parsed.nextToken;
  }
  throw new Error("Whoop pagination exceeded the bounded page limit");
}
