import { isRateLimitError } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx, internalAction } from "../_generated/server";
import { rateLimiter } from "../rateLimits";
import {
  createWhoopListBudget,
  listWhoopRecords,
  type WhoopCollection,
  whoopCollectionsForScopes,
} from "./client";
import { isWhoopConfigured } from "./config";
import {
  normalizeWhoopCycles,
  normalizeWhoopRecoveries,
  normalizeWhoopSleeps,
  type WhoopCycleRow,
  type WhoopSleepRow,
} from "./normalizers";
import { revokeEncryptedWhoopToken } from "./tokenRevocation";

const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const DUE_BATCH_SIZE = 25;
const MIN_SYNC_DAYS = 1;
const MAX_SYNC_DAYS = 30;
export const DEFAULT_BACKFILL_DAYS = 7;

export type WhoopSyncResult =
  | { success: true; recoveries: number; sleeps: number; cycles: number }
  | { success: false; error: string };

export function whoopSyncWindow(now: number, days: number): { start: string; end: string } {
  return {
    start: new Date(now - (days - 1) * DAY_MS).toISOString(),
    end: new Date(now).toISOString(),
  };
}

function publicSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("authorization expired")) return "Whoop authorization expired.";
  if (message.includes("permission is not granted")) return "A Whoop permission is unavailable.";
  if (message.includes("not connected") || message.includes("connection changed")) {
    return "Whoop is not connected.";
  }
  if (message.includes("pagination")) return "Whoop returned too much data for one sync window.";
  if (message.includes("Malformed")) return "Whoop returned malformed data.";
  const status = message.match(/HTTP ([0-9]{3})/)?.[1];
  return status ? `Whoop sync failed with HTTP ${status}.` : "Whoop sync failed.";
}

export async function runWhoopSync(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  userId: Id<"users">,
  generation: string,
  days: number,
): Promise<WhoopSyncResult> {
  if (!isWhoopConfigured()) {
    return { success: false, error: "Whoop integration is not available on this deployment." };
  }
  if (!Number.isInteger(days) || days < MIN_SYNC_DAYS || days > MAX_SYNC_DAYS) {
    return { success: false, error: `days must be between ${MIN_SYNC_DAYS} and ${MAX_SYNC_DAYS}` };
  }
  const deletionInProgress: boolean = await ctx.runQuery(internal.lib.auth.getDeletionInProgress, {
    userId,
  });
  if (deletionInProgress) {
    return { success: false, error: "Account deletion is in progress." };
  }
  const connection = await ctx.runQuery(internal.whoop.connections.getActiveConnectionByUserId, {
    userId,
  });
  if (!connection || connection.generation !== generation) {
    return { success: false, error: "Whoop is not connected." };
  }

  const now = Date.now();
  const { start, end } = whoopSyncWindow(now, days);
  const records: Record<WhoopCollection, unknown[]> = { recovery: [], sleep: [], cycle: [] };
  const collections = whoopCollectionsForScopes(connection.scopes);
  const budget = createWhoopListBudget(now);
  try {
    // Sequential reads avoid racing refresh-token rotation.
    for (const collection of collections) {
      records[collection] = await listWhoopRecords(ctx, {
        userId,
        generation,
        collection,
        start,
        end,
        budget,
      });
    }
    const sleeps = normalizeWhoopSleeps(records.sleep);
    const cycles = normalizeWhoopCycles(records.cycle);
    const sleepsById = new Map<string, WhoopSleepRow>(sleeps.map((row) => [row.sleepId, row]));
    const cyclesById = new Map<number, WhoopCycleRow>(cycles.map((row) => [row.cycleId, row]));
    const recoveries = normalizeWhoopRecoveries(records.recovery, cyclesById, sleepsById);

    const persisted = await ctx.runMutation(internal.whoop.persistence.upsertWhoopData, {
      userId,
      generation,
      recoveries,
      sleeps,
      cycles,
      now,
    });
    if (!persisted) throw new Error("Whoop connection changed during sync");

    const recorded = await ctx.runMutation(internal.whoop.connections.recordSyncResult, {
      userId,
      generation,
      now,
      nextRefreshDueAt: now + SYNC_INTERVAL_MS,
    });
    if (!recorded) return { success: false, error: "Whoop is not connected." };
    return {
      success: true,
      recoveries: recoveries.length,
      sleeps: sleeps.length,
      cycles: cycles.length,
    };
  } catch (error) {
    const safeError = publicSyncError(error);
    let recorded: boolean;
    try {
      recorded = await ctx.runMutation(internal.whoop.connections.recordSyncResult, {
        userId,
        generation,
        now,
        nextRefreshDueAt: now + SYNC_INTERVAL_MS,
        error: safeError,
      });
    } catch {
      return { success: false, error: safeError };
    }
    return recorded
      ? { success: false, error: safeError }
      : { success: false, error: "Whoop is not connected." };
  }
}

export const syncConnection = internalAction({
  args: { userId: v.id("users"), generation: v.string(), days: v.number() },
  handler: async (ctx, args): Promise<WhoopSyncResult> =>
    runWhoopSync(ctx, args.userId, args.generation, args.days),
});

export const refreshWhoopData = action({
  args: {},
  handler: async (ctx): Promise<WhoopSyncResult> => {
    const userId: Id<"users"> | null = await ctx.runQuery(
      internal.lib.auth.resolveEffectiveUserId,
      {},
    );
    if (!userId) return { success: false, error: "Not authenticated" };
    if (!isWhoopConfigured()) {
      return { success: false, error: "Whoop integration is not available on this deployment." };
    }
    try {
      await rateLimiter.limit(ctx, "refreshWhoopData", { key: userId, throws: true });
    } catch (error) {
      if (isRateLimitError(error)) {
        return {
          success: false,
          error: "Whoop refresh is limited. Please wait before trying again.",
        };
      }
      console.error("[whoopSync] failed to acquire manual refresh slot", { userId });
      return { success: false, error: "Unable to refresh Whoop right now." };
    }
    const connection = await ctx.runQuery(internal.whoop.connections.getActiveConnectionByUserId, {
      userId,
    });
    if (!connection) return { success: false, error: "Whoop is not connected." };
    return runWhoopSync(ctx, userId, connection.generation, MAX_SYNC_DAYS);
  },
});

/**
 * Runs on the 30-minute cron. Whoop access tokens expire hourly, so each
 * claimed sync doubles as the token-refresh cadence; webhooks stay the primary
 * freshness signal and this window backfills anything they missed.
 */
export const scheduleDueSyncs = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    if (!isWhoopConfigured()) return 0;
    const claimed: Array<{ userId: Id<"users">; generation: string }> = await ctx.runMutation(
      internal.whoop.connections.claimDueConnections,
      { now: Date.now(), limit: DUE_BATCH_SIZE },
    );
    for (const connection of claimed) {
      await ctx.scheduler.runAfter(0, internal.whoop.sync.syncConnection, {
        ...connection,
        days: DEFAULT_BACKFILL_DAYS,
      });
    }
    if (claimed.length === DUE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.whoop.sync.scheduleDueSyncs, {});
    }
    return claimed.length;
  },
});

export const sweepExpiredOauthArtifacts = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    const result: { deleted: number; hasMore: boolean } = await ctx.runMutation(
      internal.whoop.oauthArtifacts.sweepExpired,
      { now: Date.now() },
    );
    if (result.hasMore) {
      await ctx.scheduler.runAfter(0, internal.whoop.sync.sweepExpiredOauthArtifacts, {});
    }
    return result.deleted;
  },
});

export const revokeForAccountDeletion = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<boolean> => {
    const connection = await ctx.runQuery(internal.whoop.connections.getActiveConnectionByUserId, {
      userId,
    });
    return connection ? revokeEncryptedWhoopToken(connection.refreshTokenEncrypted) : true;
  },
});

export type DisconnectWhoopResult =
  { success: true; warning?: string } | { success: false; error: string };

export const disconnectMyWhoop = action({
  args: {},
  handler: async (ctx): Promise<DisconnectWhoopResult> => {
    const userId: Id<"users"> | null = await ctx.runQuery(
      internal.lib.auth.resolveEffectiveUserId,
      {},
    );
    if (!userId) return { success: false, error: "Not authenticated" };
    try {
      await rateLimiter.limit(ctx, "disconnectMyWhoop", { key: userId, throws: true });
    } catch (error) {
      if (isRateLimitError(error)) {
        return { success: false, error: "Too many Whoop disconnect attempts. Try again later." };
      }
      return { success: false, error: "Unable to disconnect Whoop right now." };
    }

    const claimed = await ctx.runMutation(internal.whoop.connections.claimDisconnect, {
      userId,
      reason: "user_disconnected",
      now: Date.now(),
    });
    if (!claimed) return { success: true };
    const revoked = await revokeEncryptedWhoopToken(claimed.refreshTokenEncrypted);
    if (!revoked) {
      console.error("[whoopSync] Whoop token revocation failed", { userId });
    }
    return revoked
      ? { success: true }
      : {
          success: true,
          warning: "Whoop token revocation failed; local Whoop data was disconnected.",
        };
  },
});
