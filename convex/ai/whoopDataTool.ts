import { createTool } from "@convex-dev/agent";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { classifyRecoveryZone, type RecoveryZone } from "../coach/recoveryModulation";
import { requireUserId, withToolTracking } from "./helpers";

const MAX_RANGE_DAYS = 31;
const DEFAULT_RANGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface WhoopDailyEntry {
  calendarDate: string;
  recoveryScore?: number;
  recoveryZone?: RecoveryZone;
  hrvMilliseconds?: number;
  restingHeartRate?: number;
  sleepPerformancePercent?: number;
  sleepHours?: number;
  respiratoryRate?: number;
  dayStrain?: number;
}

export interface WhoopDataResult {
  connected: boolean;
  startDate: string;
  endDate: string;
  days: WhoopDailyEntry[];
}

type WhoopDataQueryArgs = {
  userId: Id<"users">;
  startDate: string;
  endDate: string;
};

const readWhoopDailyMetricsRef = makeFunctionReference<
  "query",
  WhoopDataQueryArgs,
  WhoopDataResult
>("ai/whoopDataTool:readWhoopDailyMetrics");

function scoredRecovery(row: Doc<"whoopRecovery">): number | undefined {
  if (row.scoreState !== "SCORED" || row.userCalibrating === true) return undefined;
  return row.recoveryScore;
}

function sleepHours(row: Doc<"whoopSleep"> | undefined): number | undefined {
  if (!row || row.totalInBedTimeMilli === undefined || row.totalAwakeTimeMilli === undefined) {
    return undefined;
  }
  const seconds = Math.max(0, (row.totalInBedTimeMilli - row.totalAwakeTimeMilli) / 1000);
  return Math.round((seconds / 3600) * 10) / 10;
}

function compactEntry(entry: WhoopDailyEntry): WhoopDailyEntry {
  return Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined),
  ) as unknown as WhoopDailyEntry;
}

export const readWhoopDailyMetrics = internalQuery({
  args: { userId: v.id("users"), startDate: v.string(), endDate: v.string() },
  handler: async (ctx, { userId, startDate, endDate }): Promise<WhoopDataResult> => {
    const connection = await ctx.db
      .query("whoopConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!connection || connection.status !== "active") {
      return { connected: false, startDate, endDate, days: [] };
    }
    const generation = connection.generation;
    const [recoveries, sleeps, cycles] = await Promise.all([
      ctx.db
        .query("whoopRecovery")
        .withIndex("by_userId_and_generation_and_calendarDate", (q) =>
          q
            .eq("userId", userId)
            .eq("generation", generation)
            .gte("calendarDate", startDate)
            .lte("calendarDate", endDate),
        )
        .take(MAX_RANGE_DAYS * 2),
      ctx.db
        .query("whoopSleep")
        .withIndex("by_userId_and_generation_and_calendarDate", (q) =>
          q
            .eq("userId", userId)
            .eq("generation", generation)
            .gte("calendarDate", startDate)
            .lte("calendarDate", endDate),
        )
        .take(MAX_RANGE_DAYS * 2),
      ctx.db
        .query("whoopCycles")
        .withIndex("by_userId_and_generation_and_calendarDate", (q) =>
          q
            .eq("userId", userId)
            .eq("generation", generation)
            .gte("calendarDate", startDate)
            .lte("calendarDate", endDate),
        )
        .take(MAX_RANGE_DAYS * 2),
    ]);

    const sleepsById = new Map(sleeps.map((row) => [row.sleepId, row]));
    const cyclesByDate = new Map(cycles.map((row) => [row.calendarDate, row]));
    const byDate = new Map<string, WhoopDailyEntry>();
    for (const recovery of recoveries) {
      const sleep = sleepsById.get(recovery.sleepId);
      const cycle = cyclesByDate.get(recovery.calendarDate);
      const recoveryScore = scoredRecovery(recovery);
      byDate.set(
        recovery.calendarDate,
        compactEntry({
          calendarDate: recovery.calendarDate,
          recoveryScore,
          recoveryZone:
            recoveryScore !== undefined ? classifyRecoveryZone(recoveryScore) : undefined,
          hrvMilliseconds: recovery.hrvRmssdMilli,
          restingHeartRate: recovery.restingHeartRate,
          sleepPerformancePercent: sleep?.sleepPerformancePercentage,
          sleepHours: sleepHours(sleep),
          respiratoryRate: sleep?.respiratoryRate,
          dayStrain: cycle?.strain,
        }),
      );
    }
    // Days with strain or sleep but no recovery record still count.
    for (const cycle of cycles) {
      if (byDate.has(cycle.calendarDate)) continue;
      byDate.set(
        cycle.calendarDate,
        compactEntry({ calendarDate: cycle.calendarDate, dayStrain: cycle.strain }),
      );
    }
    const days = [...byDate.values()].sort((a, b) => b.calendarDate.localeCompare(a.calendarDate));
    return { connected: true, startDate, endDate, days };
  },
});

function clampRange(startDate?: string, endDate?: string): { start: string; end: string } {
  const today = new Date().toISOString().slice(0, 10);
  const end = endDate && DATE_PATTERN.test(endDate) ? endDate : today;
  const defaultStart = new Date(
    Date.parse(`${end}T00:00:00.000Z`) - (DEFAULT_RANGE_DAYS - 1) * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
  let start = startDate && DATE_PATTERN.test(startDate) ? startDate : defaultStart;
  const earliest = new Date(Date.parse(`${end}T00:00:00.000Z`) - (MAX_RANGE_DAYS - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  if (start > end) start = end;
  if (start < earliest) start = earliest;
  return { start, end };
}

export const getWhoopDataTool = createTool({
  description:
    "Get the user's stored Whoop data by date range: daily recovery score and zone, HRV, resting heart rate, sleep performance and duration, respiratory rate, and day strain. Use when the user asks about their recovery, HRV, sleep, or strain history or trends. Do not use it to compute workout adjustments — recovery modulation is applied deterministically by the system and surfaced in the training snapshot. Inputs are optional startDate/endDate (YYYY-MM-DD, window capped at 31 days, defaults to the last 7); returns one entry per day, newest first, plus whether Whoop is connected.",
  inputSchema: z.object({
    startDate: z
      .string()
      .optional()
      .describe("Range start, YYYY-MM-DD. Defaults to 7 days before endDate."),
    endDate: z.string().optional().describe("Range end, YYYY-MM-DD. Defaults to today."),
  }),
  execute: withToolTracking("get_whoop_data", async (ctx, input, _options) => {
    const userId = requireUserId(ctx);
    const { start, end } = clampRange(input.startDate, input.endDate);
    return (await ctx.runQuery(readWhoopDailyMetricsRef, {
      userId,
      startDate: start,
      endDate: end,
    })) as WhoopDataResult;
  }),
});
