/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import { getWeekStartDateString } from "../weekPlanHelpers";
import { dayIndexForCalendarDate } from "../coach/recoveryModulationApply";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../whoop/${key.slice(2)}` : key] = value;
}

const DAY_MS = 24 * 60 * 60 * 1000;
let nextCycleId = 1;

/** The action derives "today" from the record's UTC offset and the real clock. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

interface SeededUser {
  userId: Id<"users">;
  workoutPlanId: Id<"workoutPlans">;
}

async function seedUserWithTodaySession(t: ReturnType<typeof convexTest>): Promise<SeededUser> {
  const today = utcToday();
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("whoopConnections", {
      userId,
      whoopUserId: "12345",
      generation: "gen-1",
      status: "active",
      accessTokenEncrypted: "access",
      refreshTokenEncrypted: "refresh",
      tokenExpiresAt: Date.now() + 3_600_000,
      scopes: ["read:recovery", "read:sleep", "read:cycles", "offline"],
      connectedAt: Date.now(),
      refreshDueAt: Date.now() + 1_800_000,
    });
    const workoutPlanId = await ctx.db.insert("workoutPlans", {
      userId,
      title: "Push Day",
      blocks: [
        {
          exercises: [
            { movementId: "bench", sets: 4, reps: 8, burnout: true },
            { movementId: "row", sets: 4, reps: 8 },
          ],
        },
      ],
      status: "draft",
      createdAt: Date.now(),
    });
    const days: Doc<"weekPlans">["days"] = Array.from({ length: 7 }, () => ({
      sessionType: "rest" as const,
      status: "programmed" as const,
    }));
    const dayIndex = dayIndexForCalendarDate(today);
    days[dayIndex] = {
      sessionType: "push",
      status: "programmed",
      workoutPlanId,
    };
    await ctx.db.insert("weekPlans", {
      userId,
      weekStartDate: getWeekStartDateString(new Date(`${today}T00:00:00.000Z`)),
      preferredSplit: "ppl",
      targetDays: 3,
      days,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { userId, workoutPlanId };
  });
}

async function seedRecovery(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  {
    sleepId,
    calendarDate,
    recoveryScore,
    scoreState = "SCORED",
    hrvRmssdMilli,
  }: {
    sleepId: string;
    calendarDate: string;
    recoveryScore?: number;
    scoreState?: string;
    hrvRmssdMilli?: number;
  },
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("whoopRecovery", {
      userId,
      generation: "gen-1",
      calendarDate,
      sleepId,
      cycleId: nextCycleId++,
      timezoneOffset: "+00:00",
      scoreState,
      recoveryScore,
      hrvRmssdMilli,
      rawJson: "{}",
      lastIngestedAt: Date.now(),
    });
  });
}

describe("runMorningAdjustment", () => {
  it("reduces today's draft when a red recovery lands for today", async () => {
    const t = convexTest(schema, modules);
    const { userId, workoutPlanId } = await seedUserWithTodaySession(t);
    await seedRecovery(t, userId, {
      sleepId: "sleep-today",
      calendarDate: utcToday(),
      recoveryScore: 20,
    });

    const outcome = await t.action(internal.whoop.recoveryAdjustment.runMorningAdjustment, {
      userId,
      sleepId: "sleep-today",
    });

    expect(outcome).toMatchObject({ status: "modulation_attempted", modulation: "modulated" });
    const plan = await t.run(async (ctx) => ctx.db.get(workoutPlanId));
    expect(plan?.blocks[0].exercises.map((exercise) => exercise.sets)).toEqual([3, 3]);
    expect(plan?.blocks[0].exercises[0].burnout).toBeUndefined();
    expect(plan?.recoveryModulated?.zone).toBe("red");
  });

  it("no-ops on a green recovery and leaves the draft untouched", async () => {
    const t = convexTest(schema, modules);
    const { userId, workoutPlanId } = await seedUserWithTodaySession(t);
    await seedRecovery(t, userId, {
      sleepId: "sleep-today",
      calendarDate: utcToday(),
      recoveryScore: 85,
    });

    const outcome = await t.action(internal.whoop.recoveryAdjustment.runMorningAdjustment, {
      userId,
      sleepId: "sleep-today",
    });

    expect(outcome).toMatchObject({ status: "no_modulation", deloadPulled: false });
    const plan = await t.run(async (ctx) => ctx.db.get(workoutPlanId));
    expect(plan?.blocks[0].exercises.map((exercise) => exercise.sets)).toEqual([4, 4]);
    expect(plan?.recoveryModulated).toBeUndefined();
  });

  it("skips unscored recoveries and recoveries for past days", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedUserWithTodaySession(t);
    await seedRecovery(t, userId, {
      sleepId: "sleep-pending",
      calendarDate: utcToday(),
      scoreState: "PENDING_SCORE",
    });
    await seedRecovery(t, userId, {
      sleepId: "sleep-yesterday",
      calendarDate: daysAgo(1),
      recoveryScore: 10,
    });

    const pending = await t.action(internal.whoop.recoveryAdjustment.runMorningAdjustment, {
      userId,
      sleepId: "sleep-pending",
    });
    const backfilled = await t.action(internal.whoop.recoveryAdjustment.runMorningAdjustment, {
      userId,
      sleepId: "sleep-yesterday",
    });

    expect(pending.status).toBe("unscored");
    expect(backfilled.status).toBe("not_today");
  });

  it("pulls the deload forward after three consecutive sub-green days", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedUserWithTodaySession(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("trainingBlocks", {
        userId,
        label: "Building Phase (3 weeks)",
        blockType: "building",
        weekNumber: 2,
        totalWeeks: 3,
        startDate: daysAgo(8),
        status: "active",
        createdAt: Date.now(),
      });
    });
    await seedRecovery(t, userId, {
      sleepId: "sleep-2-ago",
      calendarDate: daysAgo(2),
      recoveryScore: 40,
    });
    await seedRecovery(t, userId, {
      sleepId: "sleep-1-ago",
      calendarDate: daysAgo(1),
      recoveryScore: 30,
    });
    await seedRecovery(t, userId, {
      sleepId: "sleep-today",
      calendarDate: utcToday(),
      recoveryScore: 50,
    });

    const outcome = await t.action(internal.whoop.recoveryAdjustment.runMorningAdjustment, {
      userId,
      sleepId: "sleep-today",
    });

    expect(outcome.deloadPulled).toBe(true);
    const blocks = await t.run(async (ctx) =>
      ctx.db
        .query("trainingBlocks")
        .withIndex("by_userId_status", (q) => q.eq("userId", userId).eq("status", "active"))
        .collect(),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].blockType).toBe("deload");

    // A repeat signal while the deload is active is a no-op.
    const repeat = await t.action(internal.whoop.recoveryAdjustment.runMorningAdjustment, {
      userId,
      sleepId: "sleep-today",
    });
    expect(repeat.deloadPulled).toBe(false);
  });

  it("returns no_context when the connection is missing or the generation is stale", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    const outcome = await t.action(internal.whoop.recoveryAdjustment.runMorningAdjustment, {
      userId,
      sleepId: "sleep-today",
    });

    expect(outcome.status).toBe("no_context");
  });
});
