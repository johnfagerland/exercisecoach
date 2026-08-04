/**
 * Week-plan-derived snapshot sections (missed sessions + today's recovery
 * adjustment note), split from context.ts for file-size hygiene.
 */

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { detectMissedSessions, formatMissedSessionContext } from "../coach/missedSessionDetection";
import { getDateStringInTimezone, getWeekStartDateStringInTimezone } from "../weekPlanHelpers";
import type { SnapshotSection } from "./snapshotHelpers";

interface CompletedActivityRef {
  tonalWorkoutId?: string;
  date: string;
}

export async function appendWeekPlanSections(
  ctx: Pick<ActionCtx, "runQuery">,
  convexUserId: Id<"users">,
  activities: readonly CompletedActivityRef[],
  snapshotNow: Date,
  userTimezone: string | undefined,
  sections: SnapshotSection[],
): Promise<void> {
  try {
    const todayDate = getDateStringInTimezone(snapshotNow, userTimezone);
    const weekStartDate = getWeekStartDateStringInTimezone(snapshotNow, userTimezone);
    const weekPlan = (await ctx.runQuery(internal.weekPlans.getByUserIdAndWeekStartInternal, {
      userId: convexUserId,
      weekStartDate,
    })) as Doc<"weekPlans"> | null;
    if (!weekPlan) return;

    const workoutPlanIds = weekPlan.days
      .map((d) => d.workoutPlanId)
      .filter((id): id is Id<"workoutPlans"> => id !== undefined);

    const uniquePlanIds = [...new Set(workoutPlanIds)];
    const workoutPlanResults = await Promise.all(
      uniquePlanIds.map((planId) =>
        ctx.runQuery(internal.workoutPlans.getById, { planId, userId: convexUserId }),
      ),
    );

    const tonalWorkoutIdByPlanId = new Map<string, string>();
    for (let i = 0; i < uniquePlanIds.length; i++) {
      const wp = workoutPlanResults[i] as Doc<"workoutPlans"> | null;
      if (wp?.tonalWorkoutId) {
        tonalWorkoutIdByPlanId.set(uniquePlanIds[i], wp.tonalWorkoutId);
      }
    }

    const completedTonalIds = new Set(
      activities.map((a) => a.tonalWorkoutId).filter((id): id is string => id !== undefined),
    );

    const localDay = new Date(`${todayDate}T00:00:00.000Z`).getUTCDay();
    const todayDayIndex = (localDay + 6) % 7; // Mon=0..Sun=6
    const missedSummary = detectMissedSessions({
      days: weekPlan.days,
      todayDayIndex,
      completedTonalIds,
      tonalWorkoutIdByPlanId,
      activityDates: activities.map((a) => a.date),
      todayDate,
    });

    const missedContext = formatMissedSessionContext(missedSummary);
    if (missedContext) {
      sections.push({ priority: 12, lines: [missedContext] });
    }

    const todaySlot = weekPlan.days[todayDayIndex];
    if (todaySlot?.workoutPlanId !== undefined) {
      const planIndex = uniquePlanIds.indexOf(todaySlot.workoutPlanId);
      const todayPlan =
        planIndex >= 0 ? (workoutPlanResults[planIndex] as Doc<"workoutPlans"> | null) : null;
      const modulation = todayPlan?.recoveryModulated;
      if (modulation && modulation.calendarDate === todayDate) {
        const summary =
          modulation.zone === "red"
            ? `working sets were cut ~${Math.round((1 - modulation.setScale) * 100)}% and intensity techniques removed`
            : "loads hold flat with one accessory set dropped and no progression attempts";
        sections.push({
          priority: 5,
          lines: [
            `Recovery Adjustment: today's draft workout was automatically adjusted for a ${modulation.zone} Whoop recovery (${Math.round(modulation.recoveryScore)}%): ${summary}. Explain the adjustment to the user; do not re-add volume unless they explicitly override.`,
          ],
        });
      }
    }
  } catch {
    // Week plan context is non-critical; continue without it
  }
}
