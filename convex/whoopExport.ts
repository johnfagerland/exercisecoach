import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type ActionCtx, internalQuery } from "./_generated/server";

const EXPORT_PAGE_SIZE = 500;

type UserMetadata = "_id" | "_creationTime" | "userId";
type WhoopRecoveryExportRow = Omit<Doc<"whoopRecovery">, UserMetadata>;
type WhoopSleepExportRow = Omit<Doc<"whoopSleep">, UserMetadata>;
type WhoopCycleExportRow = Omit<Doc<"whoopCycles">, UserMetadata>;

export interface WhoopExportData {
  whoopRecovery: WhoopRecoveryExportRow[];
  whoopSleep: WhoopSleepExportRow[];
  whoopCycles: WhoopCycleExportRow[];
}

function toExportRow<T extends { _id: unknown; _creationTime: number; userId: unknown }>(
  row: T,
): Omit<T, UserMetadata> {
  const {
    _id: _unusedId,
    _creationTime: _unusedCreationTime,
    userId: _unusedUserId,
    ...exportRow
  } = row;
  return exportRow;
}

export const listRecoveryPage = internalQuery({
  args: { userId: v.id("users"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { userId, cursor }) =>
    ctx.db
      .query("whoopRecovery")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("asc")
      .paginate({ cursor, numItems: EXPORT_PAGE_SIZE }),
});

export const listSleepPage = internalQuery({
  args: { userId: v.id("users"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { userId, cursor }) =>
    ctx.db
      .query("whoopSleep")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("asc")
      .paginate({ cursor, numItems: EXPORT_PAGE_SIZE }),
});

export const listCyclePage = internalQuery({
  args: { userId: v.id("users"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { userId, cursor }) =>
    ctx.db
      .query("whoopCycles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("asc")
      .paginate({ cursor, numItems: EXPORT_PAGE_SIZE }),
});

async function collectRecoveryRows(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<WhoopRecoveryExportRow[]> {
  const rows: WhoopRecoveryExportRow[] = [];
  let cursor: string | null = null;
  let isDone = false;
  while (!isDone) {
    const result: {
      page: Doc<"whoopRecovery">[];
      isDone: boolean;
      continueCursor: string;
    } = await ctx.runQuery(internal.whoopExport.listRecoveryPage, { userId, cursor });
    rows.push(...result.page.map(toExportRow));
    isDone = result.isDone;
    cursor = result.continueCursor;
  }
  return rows;
}

async function collectSleepRows(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<WhoopSleepExportRow[]> {
  const rows: WhoopSleepExportRow[] = [];
  let cursor: string | null = null;
  let isDone = false;
  while (!isDone) {
    const result: {
      page: Doc<"whoopSleep">[];
      isDone: boolean;
      continueCursor: string;
    } = await ctx.runQuery(internal.whoopExport.listSleepPage, { userId, cursor });
    rows.push(...result.page.map(toExportRow));
    isDone = result.isDone;
    cursor = result.continueCursor;
  }
  return rows;
}

async function collectCycleRows(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<WhoopCycleExportRow[]> {
  const rows: WhoopCycleExportRow[] = [];
  let cursor: string | null = null;
  let isDone = false;
  while (!isDone) {
    const result: {
      page: Doc<"whoopCycles">[];
      isDone: boolean;
      continueCursor: string;
    } = await ctx.runQuery(internal.whoopExport.listCyclePage, { userId, cursor });
    rows.push(...result.page.map(toExportRow));
    isDone = result.isDone;
    cursor = result.continueCursor;
  }
  return rows;
}

/** Collect all Whoop data for account export, paged to stay under read limits. */
export async function collectWhoopExportData(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<WhoopExportData> {
  const [whoopRecovery, whoopSleep, whoopCycles] = await Promise.all([
    collectRecoveryRows(ctx, userId),
    collectSleepRows(ctx, userId),
    collectCycleRows(ctx, userId),
  ]);
  return { whoopRecovery, whoopSleep, whoopCycles };
}
