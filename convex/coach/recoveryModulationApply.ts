/**
 * Applies a recovery modulation decision to today's draft workout.
 *
 * The webhook-triggered morning pass computes the decision (pure logic in
 * recoveryModulation.ts) and this mutation owns the guarded write: only a
 * plain draft that is still linked to today's programmed slot is touched, and
 * the plan is tagged so progressive-overload tracking treats the session as
 * neutral.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import {
  getDraftWorkoutMutationBlocker,
  getWeekStartDateString,
  isValidWeekStartDateString,
} from "../weekPlanHelpers";
import { normalizeBlocksAgainstCatalog } from "./normalizeBlocks";
import {
  applyRecoveryModulationToBlocks,
  type RecoveryModulationDecision,
} from "./recoveryModulation";

export type ModulateDraftOutcome =
  "modulated" | "already_modulated" | "no_week_plan" | "no_session_today" | "not_draft";

const appliedDecisionValidator = v.union(
  v.object({
    kind: v.literal("hold"),
    zone: v.literal("yellow"),
    dropAccessorySets: v.number(),
    recoveryScore: v.number(),
  }),
  v.object({
    kind: v.literal("reduce"),
    zone: v.literal("red"),
    setScale: v.number(),
    recoveryScore: v.number(),
  }),
);

/** Day index (Mon=0..Sun=6) for a YYYY-MM-DD calendar date. */
export function dayIndexForCalendarDate(calendarDate: string): number {
  const utcDay = new Date(`${calendarDate}T00:00:00.000Z`).getUTCDay();
  return (utcDay + 6) % 7;
}

export const modulateDraftDayForRecovery = internalMutation({
  args: {
    userId: v.id("users"),
    calendarDate: v.string(),
    decision: appliedDecisionValidator,
  },
  handler: async (ctx, { userId, calendarDate, decision }): Promise<ModulateDraftOutcome> => {
    if (!isValidWeekStartDateString(calendarDate)) {
      throw new Error("calendarDate must be a valid YYYY-MM-DD date");
    }
    const weekStartDate = getWeekStartDateString(new Date(`${calendarDate}T00:00:00.000Z`));
    const weekPlan = await ctx.db
      .query("weekPlans")
      .withIndex("by_userId_weekStartDate", (q) =>
        q.eq("userId", userId).eq("weekStartDate", weekStartDate),
      )
      .unique();
    if (!weekPlan) return "no_week_plan";

    const day = weekPlan.days[dayIndexForCalendarDate(calendarDate)];
    if (
      !day ||
      day.status !== "programmed" ||
      day.sessionType === "rest" ||
      day.sessionType === "recovery" ||
      day.workoutPlanId === undefined
    ) {
      return "no_session_today";
    }

    const workoutPlan = await ctx.db.get(day.workoutPlanId);
    if (!workoutPlan || workoutPlan.userId !== userId) return "no_session_today";
    if (workoutPlan.recoveryModulated?.calendarDate === calendarDate) {
      return "already_modulated";
    }
    if (getDraftWorkoutMutationBlocker(workoutPlan) !== null) return "not_draft";

    const fullDecision: RecoveryModulationDecision =
      decision.kind === "hold"
        ? {
            kind: "hold",
            zone: "yellow",
            dropAccessorySets: decision.dropAccessorySets,
            deloadSignal: false,
          }
        : {
            kind: "reduce",
            zone: "red",
            setScale: decision.setScale,
            stripIntensityTechniques: true,
            consecutiveRedDays: 1,
            recommendRecoverySession: false,
            deloadSignal: false,
          };
    const modulatedBlocks = applyRecoveryModulationToBlocks(workoutPlan.blocks, fullDecision);
    const normalizedBlocks = await normalizeBlocksAgainstCatalog(ctx, modulatedBlocks);
    await ctx.db.patch(workoutPlan._id, {
      blocks: normalizedBlocks,
      recoveryModulated: {
        calendarDate,
        zone: decision.zone,
        recoveryScore: decision.recoveryScore,
        setScale: decision.kind === "reduce" ? decision.setScale : 1,
        appliedAt: Date.now(),
      },
    });
    return "modulated";
  },
});
