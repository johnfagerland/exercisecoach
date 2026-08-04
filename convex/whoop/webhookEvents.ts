import { v } from "convex/values";
import { z } from "zod";
import { internal } from "../_generated/api";
import { internalAction, internalMutation } from "../_generated/server";
import { runWhoopSync } from "./sync";

const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_SWEEP_BATCH_SIZE = 100;
const MAX_PROCESS_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 30_000;
/** Deletes touch one row; updates re-sync a short window around the change. */
const WEBHOOK_SYNC_DAYS = 3;

export const WHOOP_WEBHOOK_EVENT_TYPES = [
  "recovery.updated",
  "recovery.deleted",
  "sleep.updated",
  "sleep.deleted",
  "workout.updated",
  "workout.deleted",
] as const;

export type WhoopWebhookEventType = (typeof WHOOP_WEBHOOK_EVENT_TYPES)[number];

const webhookEnvelopeSchema = z
  .object({
    user_id: z.number().int(),
    id: z.union([z.string().min(1).max(128), z.number().int()]),
    type: z.enum(WHOOP_WEBHOOK_EVENT_TYPES),
    trace_id: z.string().max(128).optional(),
  })
  .passthrough();

export interface WhoopWebhookEnvelope {
  whoopUserId: string;
  resourceId: string;
  eventType: WhoopWebhookEventType;
  traceId?: string;
}

/** Parse a v2 webhook delivery; throws on unknown event types or shapes. */
export function parseWhoopWebhookEnvelope(raw: unknown): WhoopWebhookEnvelope {
  const parsed = webhookEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Malformed Whoop webhook payload");
  return {
    whoopUserId: String(parsed.data.user_id),
    resourceId: String(parsed.data.id),
    eventType: parsed.data.type,
    ...(parsed.data.trace_id === undefined ? {} : { traceId: parsed.data.trace_id }),
  };
}

export const recordReceived = internalMutation({
  args: {
    userId: v.id("users"),
    connectionGeneration: v.string(),
    eventType: v.string(),
    resourceId: v.string(),
    whoopUserId: v.string(),
    traceId: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const eventId = await ctx.db.insert("whoopWebhookEvents", {
      userId: args.userId,
      connectionGeneration: args.connectionGeneration,
      eventType: args.eventType,
      resourceId: args.resourceId,
      whoopUserId: args.whoopUserId,
      traceId: args.traceId,
      status: "received",
      attempts: 0,
      receivedAt: args.now,
      updatedAt: args.now,
      expiresAt: args.now + EVENT_RETENTION_MS,
    });
    await ctx.scheduler.runAfter(0, internal.whoop.webhookEvents.processEvent, { eventId });
    return eventId;
  },
});

export const claimEvent = internalMutation({
  args: { eventId: v.id("whoopWebhookEvents"), now: v.number() },
  handler: async (ctx, { eventId, now }) => {
    const event = await ctx.db.get(eventId);
    if (!event) return null;
    if (event.status !== "received" && event.status !== "error") return null;
    if (event.attempts >= MAX_PROCESS_ATTEMPTS) return null;
    await ctx.db.patch(eventId, {
      status: "processing",
      attempts: event.attempts + 1,
      updatedAt: now,
    });
    return { ...event, attempts: event.attempts + 1 };
  },
});

export const finishEvent = internalMutation({
  args: {
    eventId: v.id("whoopWebhookEvents"),
    status: v.union(v.literal("processed"), v.literal("ignored"), v.literal("error")),
    errorReason: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, { eventId, status, errorReason, now }) => {
    const event = await ctx.db.get(eventId);
    if (!event || event.status !== "processing") return false;
    await ctx.db.patch(eventId, { status, errorReason, updatedAt: now });
    return true;
  },
});

/**
 * Process one delivery: deletes remove the stored row; updates re-sync a
 * short window so the changed record (and anything Whoop revised alongside
 * it) lands via the normal idempotent upsert path. A scored recovery for the
 * current day then triggers the morning adjustment pass.
 */
export const processEvent = internalAction({
  args: { eventId: v.id("whoopWebhookEvents") },
  handler: async (ctx, { eventId }): Promise<void> => {
    const event = await ctx.runMutation(internal.whoop.webhookEvents.claimEvent, {
      eventId,
      now: Date.now(),
    });
    if (!event) return;

    try {
      const connection = await ctx.runQuery(
        internal.whoop.connections.getActiveConnectionByUserId,
        { userId: event.userId },
      );
      if (!connection || connection.generation !== event.connectionGeneration) {
        await ctx.runMutation(internal.whoop.webhookEvents.finishEvent, {
          eventId,
          status: "ignored",
          now: Date.now(),
        });
        return;
      }

      if (event.eventType === "workout.updated" || event.eventType === "workout.deleted") {
        await ctx.runMutation(internal.whoop.webhookEvents.finishEvent, {
          eventId,
          status: "ignored",
          now: Date.now(),
        });
        return;
      }

      if (event.eventType === "recovery.deleted" || event.eventType === "sleep.deleted") {
        await ctx.runMutation(internal.whoop.persistence.deleteWhoopResource, {
          userId: event.userId,
          resource:
            event.eventType === "sleep.deleted"
              ? { kind: "sleep", sleepId: event.resourceId }
              : { kind: "recovery", sleepId: event.resourceId },
        });
        await ctx.runMutation(internal.whoop.webhookEvents.finishEvent, {
          eventId,
          status: "processed",
          now: Date.now(),
        });
        return;
      }

      const result = await runWhoopSync(
        ctx,
        event.userId,
        event.connectionGeneration,
        WEBHOOK_SYNC_DAYS,
      );
      if (!result.success) throw new Error(result.error);

      if (event.eventType === "recovery.updated") {
        await ctx.scheduler.runAfter(0, internal.whoop.recoveryAdjustment.runMorningAdjustment, {
          userId: event.userId,
          sleepId: event.resourceId,
        });
      }

      await ctx.runMutation(internal.whoop.webhookEvents.finishEvent, {
        eventId,
        status: "processed",
        now: Date.now(),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Whoop webhook processing failed";
      await ctx.runMutation(internal.whoop.webhookEvents.finishEvent, {
        eventId,
        status: "error",
        errorReason: reason,
        now: Date.now(),
      });
      if (event.attempts < MAX_PROCESS_ATTEMPTS) {
        // The daily backfill window is the terminal safety net after retries.
        await ctx.scheduler.runAfter(
          RETRY_BASE_DELAY_MS * 2 ** (event.attempts - 1),
          internal.whoop.webhookEvents.processEvent,
          { eventId },
        );
      }
    }
  },
});

export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("whoopWebhookEvents")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(EVENT_SWEEP_BATCH_SIZE);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === EVENT_SWEEP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.whoop.webhookEvents.sweepExpired, {});
    }
    return expired.length;
  },
});
