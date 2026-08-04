/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../whoop/${key.slice(2)}` : key] = value;
}

const NOW = 1_754_300_000_000;

function activeConnectionArgs(userId: Id<"users">, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    whoopUserId: "12345",
    generation: "gen-1",
    accessTokenEncrypted: "access-encrypted",
    refreshTokenEncrypted: "refresh-encrypted",
    tokenExpiresAt: NOW + 3_600_000,
    scopes: ["read:recovery", "read:sleep", "read:cycles", "read:profile", "offline"],
    refreshDueAt: NOW + 1_800_000,
    now: NOW,
    ...overrides,
  };
}

describe("whoop connections", () => {
  it("creates an active connection and resolves webhook ownership by member id", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    await t.mutation(internal.whoop.connections.upsertActiveConnection, {
      ...activeConnectionArgs(userId),
    });

    const owner = await t.query(internal.whoop.connections.getActiveConnectionByWhoopUserId, {
      whoopUserId: "12345",
    });
    expect(owner).toEqual({ userId, generation: "gen-1" });
  });

  it("rejects connecting a Whoop account already active on another Roni account", async () => {
    const t = convexTest(schema, modules);
    const firstUser = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const secondUser = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.mutation(internal.whoop.connections.upsertActiveConnection, {
      ...activeConnectionArgs(firstUser),
    });

    await expect(
      t.mutation(internal.whoop.connections.upsertActiveConnection, {
        ...activeConnectionArgs(secondUser),
      }),
    ).rejects.toThrow("already connected to another Roni account");
  });

  it("reconnecting replaces the generation and schedules old-generation cleanup", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.mutation(internal.whoop.connections.upsertActiveConnection, {
      ...activeConnectionArgs(userId),
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("whoopRecovery", {
        userId,
        generation: "gen-1",
        calendarDate: "2026-08-01",
        sleepId: "sleep-1",
        cycleId: 1,
        scoreState: "SCORED",
        recoveryScore: 80,
        rawJson: "{}",
        lastIngestedAt: NOW,
      });
    });

    vi.useFakeTimers();
    const result = await t.mutation(internal.whoop.connections.upsertActiveConnection, {
      ...activeConnectionArgs(userId, { generation: "gen-2" }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    expect(result.replacedGeneration).toBe("gen-1");
    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("whoopRecovery")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(remaining).toEqual([]);
  });

  it("replaceTokens applies only when generation and expiry watermark still match", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.mutation(internal.whoop.connections.upsertActiveConnection, {
      ...activeConnectionArgs(userId),
    });

    const staleSave = await t.mutation(internal.whoop.connections.replaceTokens, {
      userId,
      generation: "gen-1",
      accessTokenEncrypted: "new-access",
      refreshTokenEncrypted: "new-refresh",
      tokenExpiresAt: NOW + 7_200_000,
      expectedTokenExpiresAt: NOW,
      scopes: ["read:recovery", "offline"],
      refreshDueAt: NOW + 3_000_000,
    });
    const freshSave = await t.mutation(internal.whoop.connections.replaceTokens, {
      userId,
      generation: "gen-1",
      accessTokenEncrypted: "new-access",
      refreshTokenEncrypted: "new-refresh",
      tokenExpiresAt: NOW + 7_200_000,
      expectedTokenExpiresAt: NOW + 3_600_000,
      scopes: ["read:recovery", "offline"],
      refreshDueAt: NOW + 3_000_000,
    });

    expect(staleSave).toBe(false);
    expect(freshSave).toBe(true);
    const connection = await t.query(internal.whoop.connections.getActiveConnectionByUserId, {
      userId,
    });
    expect(connection?.accessTokenEncrypted).toBe("new-access");
  });

  it("disconnecting strips credentials from the stored document", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.mutation(internal.whoop.connections.upsertActiveConnection, {
      ...activeConnectionArgs(userId),
    });

    vi.useFakeTimers();
    const claimed = await t.mutation(internal.whoop.connections.claimDisconnect, {
      userId,
      reason: "user_disconnected",
      now: NOW + 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    expect(claimed?.refreshTokenEncrypted).toBe("refresh-encrypted");
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("whoopConnections")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique(),
    );
    expect(row?.status).toBe("disconnected");
    expect(row && "accessTokenEncrypted" in row).toBe(false);
    expect(row && "refreshTokenEncrypted" in row).toBe(false);
  });

  it("claimDueConnections claims due rows once and pushes the next due time forward", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.mutation(internal.whoop.connections.upsertActiveConnection, {
      ...activeConnectionArgs(userId, { refreshDueAt: NOW - 1 }),
    });

    const firstClaim = await t.mutation(internal.whoop.connections.claimDueConnections, {
      now: NOW,
      limit: 25,
    });
    const secondClaim = await t.mutation(internal.whoop.connections.claimDueConnections, {
      now: NOW,
      limit: 25,
    });

    expect(firstClaim).toEqual([{ userId, generation: "gen-1" }]);
    expect(secondClaim).toEqual([]);
  });

  it("recordSyncResult keeps the last success timestamp when a sync fails", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.mutation(internal.whoop.connections.upsertActiveConnection, {
      ...activeConnectionArgs(userId),
    });
    await t.mutation(internal.whoop.connections.recordSyncResult, {
      userId,
      generation: "gen-1",
      now: NOW + 1_000,
      nextRefreshDueAt: NOW + 2_000_000,
    });

    await t.mutation(internal.whoop.connections.recordSyncResult, {
      userId,
      generation: "gen-1",
      now: NOW + 2_000,
      nextRefreshDueAt: NOW + 3_000_000,
      error: "Whoop sync failed with HTTP 500.",
    });

    const connection = await t.query(internal.whoop.connections.getActiveConnectionByUserId, {
      userId,
    });
    expect(connection?.lastSyncedAt).toBe(NOW + 1_000);
    expect(connection?.lastSyncError).toBe("Whoop sync failed with HTTP 500.");
  });
});
