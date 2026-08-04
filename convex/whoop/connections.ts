import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalMutation, internalQuery, query } from "../_generated/server";
import { getEffectiveUserId, isDeletionInProgress } from "../lib/auth";
import { isWhoopConfigured } from "./config";

const CLAIM_INTERVAL_MS = 30 * 60 * 1000;
const MAX_DUE_BATCH_SIZE = 25;
const disconnectReasonValidator = v.union(
  v.literal("user_disconnected"),
  v.literal("permission_revoked"),
  v.literal("token_invalid"),
);

export type WhoopConnectionStatus =
  | { state: "none" }
  | {
      state: "active";
      connectedAt: number;
      lastSyncedAt?: number;
      lastSyncError?: string;
      scopes: readonly string[];
    }
  | {
      state: "disconnected";
      connectedAt: number;
      disconnectedAt: number;
      reason: "user_disconnected" | "permission_revoked" | "token_invalid";
      scopes: readonly string[];
    };

export const hasConnectionByUserId = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const connection = await ctx.db
      .query("whoopConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    return connection !== null;
  },
});

export const getWhoopFeatureStatus = action({
  args: {},
  handler: async (ctx): Promise<{ enabled: boolean; hasConnection: boolean }> => {
    const userId = await ctx.runQuery(internal.lib.auth.resolveEffectiveUserId, {});
    if (!userId) return { enabled: false, hasConnection: false };
    const hasConnection = await ctx.runQuery(internal.whoop.connections.hasConnectionByUserId, {
      userId,
    });
    return { enabled: isWhoopConfigured(), hasConnection };
  },
});

export const getMyWhoopStatus = query({
  args: {},
  handler: async (ctx): Promise<WhoopConnectionStatus> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return { state: "none" };
    const row = await ctx.db
      .query("whoopConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!row) return { state: "none" };
    if (row.status === "active") {
      return {
        state: "active",
        connectedAt: row.connectedAt,
        lastSyncedAt: row.lastSyncedAt,
        lastSyncError: row.lastSyncError,
        scopes: row.scopes,
      };
    }
    return {
      state: "disconnected",
      connectedAt: row.connectedAt,
      disconnectedAt: row.disconnectedAt,
      reason: row.disconnectReason,
      scopes: row.scopes,
    };
  },
});

export const getActiveConnectionByUserId = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const row = await ctx.db
      .query("whoopConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    return row?.status === "active" ? row : null;
  },
});

export const getConnectionByUserId = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) =>
    ctx.db
      .query("whoopConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique(),
});

/** Resolve the active connection owning a Whoop member id (webhook routing). */
export const getActiveConnectionByWhoopUserId = internalQuery({
  args: { whoopUserId: v.string() },
  handler: async (ctx, { whoopUserId }) => {
    const row = await ctx.db
      .query("whoopConnections")
      .withIndex("by_whoopUserId_and_status", (q) =>
        q.eq("whoopUserId", whoopUserId).eq("status", "active"),
      )
      .unique();
    return row ? { userId: row.userId, generation: row.generation } : null;
  },
});

export const upsertActiveConnection = internalMutation({
  args: {
    userId: v.id("users"),
    whoopUserId: v.string(),
    generation: v.string(),
    accessTokenEncrypted: v.string(),
    refreshTokenEncrypted: v.string(),
    tokenExpiresAt: v.number(),
    scopes: v.array(v.string()),
    refreshDueAt: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    if (await isDeletionInProgress(ctx, args.userId)) {
      throw new Error("Account deletion is in progress");
    }
    const activeForWhoopUser = await ctx.db
      .query("whoopConnections")
      .withIndex("by_whoopUserId_and_status", (q) =>
        q.eq("whoopUserId", args.whoopUserId).eq("status", "active"),
      )
      .take(2);
    if (activeForWhoopUser.some((row) => row.userId !== args.userId)) {
      throw new Error("This Whoop account is already connected to another Roni account");
    }

    const existing = await ctx.db
      .query("whoopConnections")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    const active = {
      userId: args.userId,
      whoopUserId: args.whoopUserId,
      generation: args.generation,
      status: "active" as const,
      accessTokenEncrypted: args.accessTokenEncrypted,
      refreshTokenEncrypted: args.refreshTokenEncrypted,
      tokenExpiresAt: args.tokenExpiresAt,
      scopes: args.scopes,
      connectedAt: args.now,
      refreshDueAt: args.refreshDueAt,
    };
    if (existing) {
      await ctx.db.replace(existing._id, active);
      await ctx.scheduler.runAfter(0, internal.whoop.persistence.cleanupWhoopData, {
        userId: args.userId,
        generation: existing.generation,
      });
      return { connectionId: existing._id, replacedGeneration: existing.generation };
    }
    const connectionId = await ctx.db.insert("whoopConnections", active);
    return { connectionId };
  },
});

export const replaceTokens = internalMutation({
  args: {
    userId: v.id("users"),
    generation: v.string(),
    accessTokenEncrypted: v.string(),
    refreshTokenEncrypted: v.string(),
    tokenExpiresAt: v.number(),
    expectedTokenExpiresAt: v.number(),
    scopes: v.array(v.string()),
    refreshDueAt: v.number(),
  },
  handler: async (ctx, args) => {
    if (await isDeletionInProgress(ctx, args.userId)) return false;
    const existing = await ctx.db
      .query("whoopConnections")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (
      !existing ||
      existing.status !== "active" ||
      existing.generation !== args.generation ||
      existing.tokenExpiresAt !== args.expectedTokenExpiresAt
    ) {
      return false;
    }
    await ctx.db.patch(existing._id, {
      accessTokenEncrypted: args.accessTokenEncrypted,
      refreshTokenEncrypted: args.refreshTokenEncrypted,
      tokenExpiresAt: args.tokenExpiresAt,
      scopes: args.scopes,
      refreshDueAt: args.refreshDueAt,
    });
    return true;
  },
});

export const markDisconnected = internalMutation({
  args: {
    userId: v.id("users"),
    generation: v.string(),
    reason: disconnectReasonValidator,
    now: v.number(),
    expectedTokenExpiresAt: v.optional(v.number()),
  },
  handler: async (ctx, { userId, generation, reason, now, expectedTokenExpiresAt }) => {
    const existing = await ctx.db
      .query("whoopConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (
      !existing ||
      existing.status !== "active" ||
      existing.generation !== generation ||
      (expectedTokenExpiresAt !== undefined && existing.tokenExpiresAt !== expectedTokenExpiresAt)
    ) {
      return false;
    }
    await ctx.db.replace(existing._id, {
      userId,
      whoopUserId: existing.whoopUserId,
      generation,
      status: "disconnected",
      scopes: existing.scopes,
      connectedAt: existing.connectedAt,
      disconnectedAt: now,
      disconnectReason: reason,
    });
    await ctx.scheduler.runAfter(0, internal.whoop.persistence.cleanupWhoopData, {
      userId,
      generation,
    });
    return true;
  },
});

export const claimDisconnect = internalMutation({
  args: {
    userId: v.id("users"),
    reason: disconnectReasonValidator,
    now: v.number(),
  },
  handler: async (ctx, { userId, reason, now }) => {
    const existing = await ctx.db
      .query("whoopConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!existing || existing.status !== "active") return null;

    const claimed = {
      generation: existing.generation,
      accessTokenEncrypted: existing.accessTokenEncrypted,
      refreshTokenEncrypted: existing.refreshTokenEncrypted,
      tokenExpiresAt: existing.tokenExpiresAt,
    };
    await ctx.db.replace(existing._id, {
      userId,
      whoopUserId: existing.whoopUserId,
      generation: existing.generation,
      status: "disconnected",
      scopes: existing.scopes,
      connectedAt: existing.connectedAt,
      disconnectedAt: now,
      disconnectReason: reason,
    });
    await ctx.scheduler.runAfter(0, internal.whoop.persistence.cleanupWhoopData, {
      userId,
      generation: existing.generation,
    });
    return claimed;
  },
});

export const claimDueConnections = internalMutation({
  args: { now: v.number(), limit: v.number() },
  handler: async (ctx, { now, limit }) => {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), MAX_DUE_BATCH_SIZE));
    const due = await ctx.db
      .query("whoopConnections")
      .withIndex("by_status_and_refreshDueAt", (q) =>
        q.eq("status", "active").lte("refreshDueAt", now),
      )
      .take(boundedLimit);
    for (const row of due) {
      await ctx.db.patch(row._id, { refreshDueAt: now + CLAIM_INTERVAL_MS });
    }
    return due.map((row) => ({ userId: row.userId, generation: row.generation }));
  },
});

export const recordSyncResult = internalMutation({
  args: {
    userId: v.id("users"),
    generation: v.string(),
    now: v.number(),
    nextRefreshDueAt: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { userId, generation, now, nextRefreshDueAt, error }) => {
    const row = await ctx.db
      .query("whoopConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!row || row.status !== "active" || row.generation !== generation) return false;
    if (row.lastSyncAttemptAt !== undefined && row.lastSyncAttemptAt > now) return true;
    await ctx.db.patch(row._id, {
      refreshDueAt: nextRefreshDueAt,
      lastSyncAttemptAt: now,
      lastSyncedAt: error ? row.lastSyncedAt : now,
      lastSyncError: error,
    });
    return true;
  },
});
