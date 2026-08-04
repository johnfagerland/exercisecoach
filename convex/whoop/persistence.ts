import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { isDeletionInProgress } from "../lib/auth";

const MAX_UPSERT_BATCH = 200;
const CLEANUP_BATCH_SIZE = 50;

const recoveryRowValidator = v.object({
  calendarDate: v.string(),
  sleepId: v.string(),
  cycleId: v.number(),
  timezoneOffset: v.optional(v.string()),
  scoreState: v.string(),
  userCalibrating: v.optional(v.boolean()),
  recoveryScore: v.optional(v.number()),
  hrvRmssdMilli: v.optional(v.number()),
  restingHeartRate: v.optional(v.number()),
  spo2Percentage: v.optional(v.number()),
  skinTempCelsius: v.optional(v.number()),
  rawJson: v.string(),
});

const sleepRowValidator = v.object({
  calendarDate: v.string(),
  sleepId: v.string(),
  start: v.string(),
  end: v.string(),
  timezoneOffset: v.optional(v.string()),
  nap: v.boolean(),
  scoreState: v.string(),
  sleepPerformancePercentage: v.optional(v.number()),
  sleepEfficiencyPercentage: v.optional(v.number()),
  sleepConsistencyPercentage: v.optional(v.number()),
  respiratoryRate: v.optional(v.number()),
  totalInBedTimeMilli: v.optional(v.number()),
  totalAwakeTimeMilli: v.optional(v.number()),
  totalLightSleepTimeMilli: v.optional(v.number()),
  totalSlowWaveSleepTimeMilli: v.optional(v.number()),
  totalRemSleepTimeMilli: v.optional(v.number()),
  sleepCycleCount: v.optional(v.number()),
  disturbanceCount: v.optional(v.number()),
  rawJson: v.string(),
});

const cycleRowValidator = v.object({
  calendarDate: v.string(),
  cycleId: v.number(),
  start: v.string(),
  end: v.optional(v.string()),
  timezoneOffset: v.optional(v.string()),
  scoreState: v.string(),
  strain: v.optional(v.number()),
  kilojoule: v.optional(v.number()),
  averageHeartRate: v.optional(v.number()),
  maxHeartRate: v.optional(v.number()),
  rawJson: v.string(),
});

/**
 * Upsert normalized Whoop records by their provider-stable ids. Re-ingesting a
 * row that predates a reconnect adopts the current generation, so duplicate
 * UUIDs never coexist across generations.
 */
export const upsertWhoopData = internalMutation({
  args: {
    userId: v.id("users"),
    generation: v.string(),
    recoveries: v.array(recoveryRowValidator),
    sleeps: v.array(sleepRowValidator),
    cycles: v.array(cycleRowValidator),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    if (
      args.recoveries.length > MAX_UPSERT_BATCH ||
      args.sleeps.length > MAX_UPSERT_BATCH ||
      args.cycles.length > MAX_UPSERT_BATCH
    ) {
      throw new Error(`Whoop upsert batch exceeds ${MAX_UPSERT_BATCH} rows`);
    }
    if (await isDeletionInProgress(ctx, args.userId)) return false;
    const connection = await ctx.db
      .query("whoopConnections")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (
      !connection ||
      connection.status !== "active" ||
      connection.generation !== args.generation
    ) {
      return false;
    }

    for (const sleep of args.sleeps) {
      const existing = await ctx.db
        .query("whoopSleep")
        .withIndex("by_userId_and_sleepId", (q) =>
          q.eq("userId", args.userId).eq("sleepId", sleep.sleepId),
        )
        .unique();
      const row = {
        userId: args.userId,
        generation: args.generation,
        ...sleep,
        lastIngestedAt: args.now,
      };
      if (existing) await ctx.db.replace(existing._id, row);
      else await ctx.db.insert("whoopSleep", row);
    }

    for (const cycle of args.cycles) {
      const existing = await ctx.db
        .query("whoopCycles")
        .withIndex("by_userId_and_cycleId", (q) =>
          q.eq("userId", args.userId).eq("cycleId", cycle.cycleId),
        )
        .unique();
      const row = {
        userId: args.userId,
        generation: args.generation,
        ...cycle,
        lastIngestedAt: args.now,
      };
      if (existing) await ctx.db.replace(existing._id, row);
      else await ctx.db.insert("whoopCycles", row);
    }

    for (const recovery of args.recoveries) {
      const existing = await ctx.db
        .query("whoopRecovery")
        .withIndex("by_userId_and_sleepId", (q) =>
          q.eq("userId", args.userId).eq("sleepId", recovery.sleepId),
        )
        .unique();
      const row = {
        userId: args.userId,
        generation: args.generation,
        ...recovery,
        lastIngestedAt: args.now,
      };
      if (existing) await ctx.db.replace(existing._id, row);
      else await ctx.db.insert("whoopRecovery", row);
    }
    return true;
  },
});

/** Remove records Whoop reports as deleted (retroactive sleep edits). */
export const deleteWhoopResource = internalMutation({
  args: {
    userId: v.id("users"),
    resource: v.union(
      v.object({ kind: v.literal("sleep"), sleepId: v.string() }),
      v.object({ kind: v.literal("recovery"), sleepId: v.string() }),
      v.object({ kind: v.literal("cycle"), cycleId: v.number() }),
    ),
  },
  handler: async (ctx, { userId, resource }) => {
    if (resource.kind === "cycle") {
      const cycle = await ctx.db
        .query("whoopCycles")
        .withIndex("by_userId_and_cycleId", (q) =>
          q.eq("userId", userId).eq("cycleId", resource.cycleId),
        )
        .unique();
      if (cycle) await ctx.db.delete(cycle._id);
      return null;
    }
    const recovery = await ctx.db
      .query("whoopRecovery")
      .withIndex("by_userId_and_sleepId", (q) =>
        q.eq("userId", userId).eq("sleepId", resource.sleepId),
      )
      .unique();
    if (recovery) await ctx.db.delete(recovery._id);
    if (resource.kind === "sleep") {
      const sleep = await ctx.db
        .query("whoopSleep")
        .withIndex("by_userId_and_sleepId", (q) =>
          q.eq("userId", userId).eq("sleepId", resource.sleepId),
        )
        .unique();
      if (sleep) await ctx.db.delete(sleep._id);
    }
    return null;
  },
});

/** Drain rows from a replaced or disconnected generation in bounded batches. */
export const cleanupWhoopData = internalMutation({
  args: { userId: v.id("users"), generation: v.string() },
  handler: async (ctx, { userId, generation }) => {
    const [recoveries, sleeps, cycles] = await Promise.all([
      ctx.db
        .query("whoopRecovery")
        .withIndex("by_userId_and_generation_and_calendarDate", (q) =>
          q.eq("userId", userId).eq("generation", generation),
        )
        .take(CLEANUP_BATCH_SIZE),
      ctx.db
        .query("whoopSleep")
        .withIndex("by_userId_and_generation_and_calendarDate", (q) =>
          q.eq("userId", userId).eq("generation", generation),
        )
        .take(CLEANUP_BATCH_SIZE),
      ctx.db
        .query("whoopCycles")
        .withIndex("by_userId_and_generation_and_calendarDate", (q) =>
          q.eq("userId", userId).eq("generation", generation),
        )
        .take(CLEANUP_BATCH_SIZE),
    ]);
    for (const row of [...recoveries, ...sleeps, ...cycles]) await ctx.db.delete(row._id);
    if (
      recoveries.length === CLEANUP_BATCH_SIZE ||
      sleeps.length === CLEANUP_BATCH_SIZE ||
      cycles.length === CLEANUP_BATCH_SIZE
    ) {
      await ctx.scheduler.runAfter(0, internal.whoop.persistence.cleanupWhoopData, {
        userId,
        generation,
      });
    }
  },
});
