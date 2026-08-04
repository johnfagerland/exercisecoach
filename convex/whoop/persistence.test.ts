/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../whoop/${key.slice(2)}` : key] = value;
}

const NOW = 1_754_300_000_000;

async function seedConnection(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  generation = "gen-1",
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("whoopConnections", {
      userId,
      whoopUserId: "12345",
      generation,
      status: "active",
      accessTokenEncrypted: "access",
      refreshTokenEncrypted: "refresh",
      tokenExpiresAt: NOW + 3_600_000,
      scopes: ["read:recovery", "read:sleep", "read:cycles", "offline"],
      connectedAt: NOW,
      refreshDueAt: NOW + 1_800_000,
    });
  });
}

function recoveryRow(overrides: Record<string, unknown> = {}) {
  return {
    calendarDate: "2026-08-03",
    sleepId: "sleep-uuid-1",
    cycleId: 100,
    timezoneOffset: "-05:00",
    scoreState: "SCORED",
    recoveryScore: 55,
    hrvRmssdMilli: 48,
    restingHeartRate: 52,
    rawJson: '{"score_state":"SCORED"}',
    ...overrides,
  };
}

function sleepRow(overrides: Record<string, unknown> = {}) {
  return {
    calendarDate: "2026-08-03",
    sleepId: "sleep-uuid-1",
    start: "2026-08-03T03:00:00.000Z",
    end: "2026-08-03T11:00:00.000Z",
    timezoneOffset: "-05:00",
    nap: false,
    scoreState: "SCORED",
    sleepPerformancePercentage: 88,
    rawJson: "{}",
    ...overrides,
  };
}

function cycleRow(overrides: Record<string, unknown> = {}) {
  return {
    calendarDate: "2026-08-03",
    cycleId: 100,
    start: "2026-08-03T09:00:00.000Z",
    timezoneOffset: "-05:00",
    scoreState: "SCORED",
    strain: 11.4,
    rawJson: "{}",
    ...overrides,
  };
}

describe("whoop persistence", () => {
  it("inserts normalized rows and re-upserts by provider id without duplicating", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await seedConnection(t, userId);

    const firstWrite = await t.mutation(internal.whoop.persistence.upsertWhoopData, {
      userId,
      generation: "gen-1",
      recoveries: [recoveryRow()],
      sleeps: [sleepRow()],
      cycles: [cycleRow()],
      now: NOW,
    });
    const secondWrite = await t.mutation(internal.whoop.persistence.upsertWhoopData, {
      userId,
      generation: "gen-1",
      recoveries: [recoveryRow({ recoveryScore: 62 })],
      sleeps: [sleepRow()],
      cycles: [cycleRow({ strain: 14.2 })],
      now: NOW + 1_000,
    });

    expect(firstWrite).toBe(true);
    expect(secondWrite).toBe(true);
    const recoveries = await t.run(async (ctx) =>
      ctx.db
        .query("whoopRecovery")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].recoveryScore).toBe(62);
    expect(recoveries[0].lastIngestedAt).toBe(NOW + 1_000);
    const cycles = await t.run(async (ctx) =>
      ctx.db
        .query("whoopCycles")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0].strain).toBe(14.2);
  });

  it("rejects writes for a stale connection generation", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await seedConnection(t, userId, "gen-2");

    const persisted = await t.mutation(internal.whoop.persistence.upsertWhoopData, {
      userId,
      generation: "gen-1",
      recoveries: [recoveryRow()],
      sleeps: [],
      cycles: [],
      now: NOW,
    });

    expect(persisted).toBe(false);
    const recoveries = await t.run(async (ctx) =>
      ctx.db
        .query("whoopRecovery")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(recoveries).toEqual([]);
  });

  it("re-ingesting a row from a prior generation adopts the current one", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await seedConnection(t, userId, "gen-2");
    await t.run(async (ctx) => {
      await ctx.db.insert("whoopRecovery", {
        userId,
        generation: "gen-1",
        ...recoveryRow(),
        lastIngestedAt: NOW - 5_000,
      });
    });

    await t.mutation(internal.whoop.persistence.upsertWhoopData, {
      userId,
      generation: "gen-2",
      recoveries: [recoveryRow()],
      sleeps: [],
      cycles: [],
      now: NOW,
    });

    const recoveries = await t.run(async (ctx) =>
      ctx.db
        .query("whoopRecovery")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].generation).toBe("gen-2");
  });

  it("deletes a sleep with its recovery, and a recovery alone, on webhook deletes", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await seedConnection(t, userId);
    await t.mutation(internal.whoop.persistence.upsertWhoopData, {
      userId,
      generation: "gen-1",
      recoveries: [recoveryRow(), recoveryRow({ sleepId: "sleep-uuid-2", cycleId: 101 })],
      sleeps: [sleepRow(), sleepRow({ sleepId: "sleep-uuid-2" })],
      cycles: [cycleRow()],
      now: NOW,
    });

    await t.mutation(internal.whoop.persistence.deleteWhoopResource, {
      userId,
      resource: { kind: "sleep", sleepId: "sleep-uuid-1" },
    });
    await t.mutation(internal.whoop.persistence.deleteWhoopResource, {
      userId,
      resource: { kind: "recovery", sleepId: "sleep-uuid-2" },
    });

    const [recoveries, sleeps] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db
          .query("whoopRecovery")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .collect(),
        ctx.db
          .query("whoopSleep")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .collect(),
      ]),
    );
    expect(recoveries).toEqual([]);
    expect(sleeps.map((row) => row.sleepId)).toEqual(["sleep-uuid-2"]);
  });

  it("cleanup drains only rows from the target generation", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.run(async (ctx) => {
      await ctx.db.insert("whoopRecovery", {
        userId,
        generation: "gen-1",
        ...recoveryRow(),
        lastIngestedAt: NOW,
      });
      await ctx.db.insert("whoopRecovery", {
        userId,
        generation: "gen-2",
        ...recoveryRow({ sleepId: "sleep-uuid-2", calendarDate: "2026-08-04" }),
        lastIngestedAt: NOW,
      });
    });

    await t.mutation(internal.whoop.persistence.cleanupWhoopData, {
      userId,
      generation: "gen-1",
    });

    const recoveries = await t.run(async (ctx) =>
      ctx.db
        .query("whoopRecovery")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(recoveries.map((row) => row.generation)).toEqual(["gen-2"]);
  });
});
