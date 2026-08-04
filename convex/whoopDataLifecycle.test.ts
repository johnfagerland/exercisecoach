/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { JSON_EXPORT_SECTION_KEYS, USER_DATA_TABLES } from "./userData";

const modules = import.meta.glob("./**/*.*s");

const WHOOP_REGISTRY_ENTRIES = [
  { table: "whoopConnections", delete: "byUserIdBatch", jsonExportKey: null },
  { table: "whoopOauthStates", delete: "byUserIdBatch", jsonExportKey: null },
  { table: "whoopOauthCallbackTickets", delete: "byUserIdBatch", jsonExportKey: null },
  { table: "whoopWebhookEvents", delete: "byUserIdBatch", jsonExportKey: null },
  { table: "whoopRecovery", delete: "byUserIdBatch", jsonExportKey: "whoopRecovery" },
  { table: "whoopSleep", delete: "byUserIdBatch", jsonExportKey: "whoopSleep" },
  { table: "whoopCycles", delete: "byUserIdBatch", jsonExportKey: "whoopCycles" },
] as const;

async function insertWhoopData(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  suffix: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("whoopConnections", {
      userId,
      whoopUserId: `member-${suffix}`,
      generation: `generation-${suffix}`,
      status: "active",
      accessTokenEncrypted: `access-secret-${suffix}`,
      refreshTokenEncrypted: `refresh-secret-${suffix}`,
      tokenExpiresAt: 2_000,
      scopes: ["read:recovery", "offline"],
      connectedAt: 1_000,
      refreshDueAt: 1_500,
    });
    await ctx.db.insert("whoopOauthStates", {
      userId,
      stateHash: `state-${suffix}`,
      createdAt: 1_000,
      expiresAt: 2_000,
    });
    await ctx.db.insert("whoopOauthCallbackTickets", {
      userId,
      ticketHash: `ticket-${suffix}`,
      authorizationCodeEncrypted: `code-secret-${suffix}`,
      createdAt: 1_000,
      expiresAt: 2_000,
    });
    await ctx.db.insert("whoopWebhookEvents", {
      userId,
      connectionGeneration: `generation-${suffix}`,
      eventType: "recovery.updated",
      resourceId: `sleep-${suffix}`,
      whoopUserId: `member-${suffix}`,
      status: "received",
      attempts: 0,
      receivedAt: 1_100,
      updatedAt: 1_100,
      expiresAt: 700_000,
    });
    await ctx.db.insert("whoopRecovery", {
      userId,
      generation: `generation-${suffix}`,
      calendarDate: "2026-08-01",
      sleepId: `sleep-${suffix}`,
      cycleId: 1,
      scoreState: "SCORED",
      recoveryScore: 70,
      rawJson: "{}",
      lastIngestedAt: 1_200,
    });
    await ctx.db.insert("whoopSleep", {
      userId,
      generation: `generation-${suffix}`,
      calendarDate: "2026-08-01",
      sleepId: `sleep-${suffix}`,
      start: "2026-08-01T03:00:00.000Z",
      end: "2026-08-01T11:00:00.000Z",
      nap: false,
      scoreState: "SCORED",
      rawJson: "{}",
      lastIngestedAt: 1_200,
    });
    await ctx.db.insert("whoopCycles", {
      userId,
      generation: `generation-${suffix}`,
      calendarDate: "2026-08-01",
      cycleId: 1,
      start: "2026-08-01T09:00:00.000Z",
      scoreState: "SCORED",
      strain: 12,
      rawJson: "{}",
      lastIngestedAt: 1_200,
    });
  });
}

describe("Whoop user-data lifecycle", () => {
  test("registers connection artifacts as non-exported and health data as exported", () => {
    const entries = USER_DATA_TABLES.filter((entry) => entry.table.startsWith("whoop"));

    expect(entries).toEqual(WHOOP_REGISTRY_ENTRIES);
    expect(JSON_EXPORT_SECTION_KEYS.filter((key) => key.toLowerCase().includes("whoop"))).toEqual([
      "whoopRecovery",
      "whoopSleep",
      "whoopCycles",
    ]);
  });

  test("deletes only the target user's Whoop artifacts", async () => {
    const t = convexTest(schema, modules);
    const targetUser = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const otherUser = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertWhoopData(t, targetUser, "target");
    await insertWhoopData(t, otherUser, "other");

    for (const entry of WHOOP_REGISTRY_ENTRIES) {
      let hasMore = true;
      while (hasMore) {
        hasMore = await t.mutation(internal.accountDeletion.deleteUserTableBatch, {
          userId: targetUser,
          table: entry.table,
        });
      }
    }

    await t.run(async (ctx) => {
      for (const entry of WHOOP_REGISTRY_ENTRIES) {
        const rows = await ctx.db.query(entry.table).collect();
        expect(rows, `${entry.table} should retain only the other user's rows`).toHaveLength(1);
        expect(rows[0].userId).toBe(otherUser);
      }
    });
  });

  test("export pages strip Convex metadata and the owning user id", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertWhoopData(t, userId, "export");

    const page = await t.query(internal.whoopExport.listRecoveryPage, { userId, cursor: null });

    expect(page.isDone).toBe(true);
    expect(page.page).toHaveLength(1);
    // The exporter strips these before returning data to the user.
    const { _id, _creationTime, userId: owner, ...rest } = page.page[0];
    expect(_id).toBeTruthy();
    expect(_creationTime).toBeTruthy();
    expect(owner).toBe(userId);
    expect(rest).toMatchObject({ sleepId: "sleep-export", recoveryScore: 70 });
  });
});
