/**
 * Morning adjustment pass: when a scored recovery lands for today, run the
 * deterministic modulation over today's draft session and, on a sustained
 * deficit, pull the periodization deload forward. The AI coach reads the
 * resulting tags and explains the decision — it never computes it.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalAction, internalQuery } from "../_generated/server";
import {
  computeRecoveryModulation,
  type RecoveryDayObservation,
} from "../coach/recoveryModulation";
import { whoopLocalCalendarDate } from "./normalizers";

/** Recovery history window read for streak + HRV trend computation. */
const HISTORY_DAYS_LIMIT = 30;
const HRV_RECENT_DAYS = 7;
/** Minimum scored days before the 7-day HRV average is trusted. */
const HRV_MIN_RECENT_SAMPLES = 4;
/** Minimum baseline samples (days 8-30) before the trend rule can fire. */
const HRV_MIN_BASELINE_SAMPLES = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export const getAdjustmentContext = internalQuery({
  args: { userId: v.id("users"), sleepId: v.string() },
  handler: async (ctx, { userId, sleepId }) => {
    const connection = await ctx.db
      .query("whoopConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!connection || connection.status !== "active") return null;
    const recovery = await ctx.db
      .query("whoopRecovery")
      .withIndex("by_userId_and_sleepId", (q) => q.eq("userId", userId).eq("sleepId", sleepId))
      .unique();
    if (!recovery || recovery.generation !== connection.generation) return null;
    const recentRecoveries = await ctx.db
      .query("whoopRecovery")
      .withIndex("by_userId_and_generation_and_calendarDate", (q) =>
        q.eq("userId", userId).eq("generation", connection.generation),
      )
      .order("desc")
      .take(HISTORY_DAYS_LIMIT);
    return { recovery, recentRecoveries };
  },
});

function scoredValue(row: Doc<"whoopRecovery">): number | null {
  if (row.scoreState !== "SCORED" || row.userCalibrating === true) return null;
  return row.recoveryScore ?? null;
}

/** One observation per calendar date, newest first; later sleeps win a date. */
export function dedupeByCalendarDate(
  rows: readonly Doc<"whoopRecovery">[],
): Doc<"whoopRecovery">[] {
  const byDate = new Map<string, Doc<"whoopRecovery">>();
  for (const row of rows) {
    const existing = byDate.get(row.calendarDate);
    if (!existing || row.lastIngestedAt > existing.lastIngestedAt) {
      byDate.set(row.calendarDate, row);
    }
  }
  return [...byDate.values()].sort((a, b) => b.calendarDate.localeCompare(a.calendarDate));
}

function meanHrv(rows: readonly Doc<"whoopRecovery">[], minSamples: number): number | undefined {
  const values = rows.flatMap((row) =>
    scoredValue(row) !== null && row.hrvRmssdMilli !== undefined ? [row.hrvRmssdMilli] : [],
  );
  if (values.length < minSamples) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface MorningAdjustmentOutcome {
  status: "no_context" | "unscored" | "not_today" | "no_modulation" | "modulation_attempted";
  modulation?: string;
  deloadPulled?: boolean;
}

export const runMorningAdjustment = internalAction({
  args: { userId: v.id("users"), sleepId: v.string() },
  handler: async (ctx, { userId, sleepId }): Promise<MorningAdjustmentOutcome> => {
    const context = await ctx.runQuery(internal.whoop.recoveryAdjustment.getAdjustmentContext, {
      userId,
      sleepId,
    });
    if (!context) return { status: "no_context" };
    const { recovery, recentRecoveries } = context;

    const todayScore = scoredValue(recovery);
    if (todayScore === null) return { status: "unscored" };

    const localToday = whoopLocalCalendarDate(new Date().toISOString(), recovery.timezoneOffset);
    if (localToday === null || recovery.calendarDate !== localToday) {
      return { status: "not_today" };
    }

    const dailyRows = dedupeByCalendarDate(recentRecoveries);
    const priorDays: RecoveryDayObservation[] = dailyRows
      .filter((row) => row.calendarDate < localToday)
      .map((row) => ({ calendarDate: row.calendarDate, recoveryScore: scoredValue(row) }));

    const recentCutoff = new Date(
      Date.parse(`${localToday}T00:00:00.000Z`) - HRV_RECENT_DAYS * DAY_MS,
    )
      .toISOString()
      .slice(0, 10);
    const recentRows = dailyRows.filter((row) => row.calendarDate > recentCutoff);
    const baselineRows = dailyRows.filter((row) => row.calendarDate <= recentCutoff);
    const decision = computeRecoveryModulation({
      todayScore,
      priorDays,
      hrvRecentAvg: meanHrv(recentRows, HRV_MIN_RECENT_SAMPLES),
      hrvBaselineAvg: meanHrv(baselineRows, HRV_MIN_BASELINE_SAMPLES),
    });

    let deloadPulled = false;
    if (decision.deloadSignal) {
      const result: { pulled: boolean } = await ctx.runMutation(
        internal.coach.periodization.pullDeloadForward,
        { userId, startDate: localToday },
      );
      deloadPulled = result.pulled;
    }

    if (decision.kind === "none") {
      return { status: "no_modulation", deloadPulled };
    }

    const outcome: string = await ctx.runMutation(
      internal.coach.recoveryModulationApply.modulateDraftDayForRecovery,
      {
        userId,
        calendarDate: localToday,
        decision:
          decision.kind === "hold"
            ? {
                kind: "hold",
                zone: "yellow",
                dropAccessorySets: decision.dropAccessorySets,
                recoveryScore: todayScore,
              }
            : {
                kind: "reduce",
                zone: "red",
                setScale: decision.setScale,
                recoveryScore: todayScore,
              },
      },
    );
    return { status: "modulation_attempted", modulation: outcome, deloadPulled };
  },
});
