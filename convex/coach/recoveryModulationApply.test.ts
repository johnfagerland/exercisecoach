/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import { dayIndexForCalendarDate } from "./recoveryModulationApply";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../coach/${key.slice(2)}` : key] = value;
}

// 2026-08-04 is a Tuesday; its week starts Monday 2026-08-03.
const CALENDAR_DATE = "2026-08-04";
const WEEK_START = "2026-08-03";

const RED_DECISION = {
  kind: "reduce" as const,
  zone: "red" as const,
  setScale: 0.7,
  recoveryScore: 25,
};

const DRAFT_BLOCKS = [
  { exercises: [{ movementId: "warm-1", sets: 2, reps: 15, warmUp: true }] },
  {
    exercises: [
      { movementId: "bench", sets: 4, reps: 8, dropSet: true },
      { movementId: "row", sets: 4, reps: 8 },
    ],
  },
];

async function seedWeek(
  t: ReturnType<typeof convexTest>,
  options: { planStatus?: Doc<"workoutPlans">["status"]; sessionType?: "push" | "rest" } = {},
): Promise<{ userId: Id<"users">; workoutPlanId: Id<"workoutPlans"> }> {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const workoutPlanId = await ctx.db.insert("workoutPlans", {
      userId,
      title: "Push Day",
      blocks: DRAFT_BLOCKS,
      status: options.planStatus ?? "draft",
      createdAt: Date.now(),
    });
    const days = Array.from({ length: 7 }, () => ({
      sessionType: "rest" as const,
      status: "programmed" as const,
    }));
    const dayIndex = dayIndexForCalendarDate(CALENDAR_DATE);
    days[dayIndex] = {
      sessionType: options.sessionType ?? "push",
      status: "programmed",
      ...(options.sessionType === "rest" ? {} : { workoutPlanId }),
    } as (typeof days)[number];
    await ctx.db.insert("weekPlans", {
      userId,
      weekStartDate: WEEK_START,
      preferredSplit: "ppl",
      targetDays: 3,
      days,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { userId, workoutPlanId };
  });
}

describe("modulateDraftDayForRecovery", () => {
  it("reduces today's draft blocks and tags the plan on a red day", async () => {
    const t = convexTest(schema, modules);
    const { userId, workoutPlanId } = await seedWeek(t);

    const outcome = await t.mutation(
      internal.coach.recoveryModulationApply.modulateDraftDayForRecovery,
      { userId, calendarDate: CALENDAR_DATE, decision: RED_DECISION },
    );

    expect(outcome).toBe("modulated");
    const plan = await t.run(async (ctx) => ctx.db.get(workoutPlanId));
    expect(plan?.blocks[0].exercises[0].sets).toBe(2);
    expect(plan?.blocks[1].exercises.map((exercise) => exercise.sets)).toEqual([3, 3]);
    expect(plan?.blocks[1].exercises[0].dropSet).toBeUndefined();
    expect(plan?.recoveryModulated).toMatchObject({
      calendarDate: CALENDAR_DATE,
      zone: "red",
      recoveryScore: 25,
      setScale: 0.7,
    });
  });

  it("drops one accessory set and holds everything else on a yellow day", async () => {
    const t = convexTest(schema, modules);
    const { userId, workoutPlanId } = await seedWeek(t);

    const outcome = await t.mutation(
      internal.coach.recoveryModulationApply.modulateDraftDayForRecovery,
      {
        userId,
        calendarDate: CALENDAR_DATE,
        decision: { kind: "hold", zone: "yellow", dropAccessorySets: 1, recoveryScore: 50 },
      },
    );

    expect(outcome).toBe("modulated");
    const plan = await t.run(async (ctx) => ctx.db.get(workoutPlanId));
    expect(plan?.blocks[1].exercises.map((exercise) => exercise.sets)).toEqual([3, 3]);
    expect(plan?.blocks[1].exercises[0].dropSet).toBe(true);
    expect(plan?.recoveryModulated?.setScale).toBe(1);
  });

  it("is idempotent for the same calendar date", async () => {
    const t = convexTest(schema, modules);
    const { userId, workoutPlanId } = await seedWeek(t);
    await t.mutation(internal.coach.recoveryModulationApply.modulateDraftDayForRecovery, {
      userId,
      calendarDate: CALENDAR_DATE,
      decision: RED_DECISION,
    });

    const secondOutcome = await t.mutation(
      internal.coach.recoveryModulationApply.modulateDraftDayForRecovery,
      { userId, calendarDate: CALENDAR_DATE, decision: RED_DECISION },
    );

    expect(secondOutcome).toBe("already_modulated");
    const plan = await t.run(async (ctx) => ctx.db.get(workoutPlanId));
    // A second red pass must not compound the reduction.
    expect(plan?.blocks[1].exercises.map((exercise) => exercise.sets)).toEqual([3, 3]);
  });

  it("no-ops when there is no week plan, no session, or a rest day", async () => {
    const t = convexTest(schema, modules);
    const { userId: restUser } = await seedWeek(t, { sessionType: "rest" });
    const bareUser = await t.run(async (ctx) => ctx.db.insert("users", {}));

    const noPlan = await t.mutation(
      internal.coach.recoveryModulationApply.modulateDraftDayForRecovery,
      { userId: bareUser, calendarDate: CALENDAR_DATE, decision: RED_DECISION },
    );
    const restDay = await t.mutation(
      internal.coach.recoveryModulationApply.modulateDraftDayForRecovery,
      { userId: restUser, calendarDate: CALENDAR_DATE, decision: RED_DECISION },
    );

    expect(noPlan).toBe("no_week_plan");
    expect(restDay).toBe("no_session_today");
  });

  it("refuses to touch a workout that is no longer a plain draft", async () => {
    const t = convexTest(schema, modules);
    const { userId, workoutPlanId } = await seedWeek(t, { planStatus: "pushed" });

    const outcome = await t.mutation(
      internal.coach.recoveryModulationApply.modulateDraftDayForRecovery,
      { userId, calendarDate: CALENDAR_DATE, decision: RED_DECISION },
    );

    expect(outcome).toBe("not_draft");
    const plan = await t.run(async (ctx) => ctx.db.get(workoutPlanId));
    expect(plan?.blocks[1].exercises.map((exercise) => exercise.sets)).toEqual([4, 4]);
    expect(plan?.recoveryModulated).toBeUndefined();
  });

  it("rejects malformed calendar dates", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedWeek(t);

    await expect(
      t.mutation(internal.coach.recoveryModulationApply.modulateDraftDayForRecovery, {
        userId,
        calendarDate: "08/04/2026",
        decision: RED_DECISION,
      }),
    ).rejects.toThrow("calendarDate must be a valid YYYY-MM-DD date");
  });
});
