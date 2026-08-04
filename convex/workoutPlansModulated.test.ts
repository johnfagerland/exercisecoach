/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

describe("getRecoveryModulatedTonalWorkoutIds", () => {
  it("returns only this user's modulated Tonal workout ids", async () => {
    const t = convexTest(schema, modules);
    const { userId, otherUserId } = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", {});
      const other = await ctx.db.insert("users", {});
      await ctx.db.insert("workoutPlans", {
        userId: owner,
        title: "Modulated Day",
        blocks: [{ exercises: [{ movementId: "bench", sets: 3, reps: 8 }] }],
        status: "completed",
        tonalWorkoutId: "tonal-modulated",
        recoveryModulated: {
          calendarDate: "2026-08-01",
          zone: "red",
          recoveryScore: 25,
          setScale: 0.7,
          appliedAt: 1_000,
        },
        createdAt: 1_000,
      });
      await ctx.db.insert("workoutPlans", {
        userId: owner,
        title: "Normal Day",
        blocks: [{ exercises: [{ movementId: "row", sets: 3, reps: 8 }] }],
        status: "completed",
        tonalWorkoutId: "tonal-normal",
        createdAt: 1_000,
      });
      await ctx.db.insert("workoutPlans", {
        userId: other,
        title: "Other User Modulated",
        blocks: [{ exercises: [{ movementId: "squat", sets: 3, reps: 8 }] }],
        status: "completed",
        tonalWorkoutId: "tonal-other-user",
        recoveryModulated: {
          calendarDate: "2026-08-01",
          zone: "yellow",
          recoveryScore: 50,
          setScale: 1,
          appliedAt: 1_000,
        },
        createdAt: 1_000,
      });
      return { userId: owner, otherUserId: other };
    });

    const modulated = await t.query(internal.workoutPlans.getRecoveryModulatedTonalWorkoutIds, {
      userId,
      tonalWorkoutIds: ["tonal-modulated", "tonal-normal", "tonal-other-user", "tonal-unknown"],
    });
    const otherUserView = await t.query(internal.workoutPlans.getRecoveryModulatedTonalWorkoutIds, {
      userId: otherUserId,
      tonalWorkoutIds: ["tonal-modulated", "tonal-other-user"],
    });

    expect(modulated).toEqual(["tonal-modulated"]);
    expect(otherUserView).toEqual(["tonal-other-user"]);
  });
});
