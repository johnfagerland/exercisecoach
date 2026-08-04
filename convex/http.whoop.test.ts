/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { hashOAuthArtifact } from "./whoop/oauthFlow";

const modules = import.meta.glob("./**/*.*s");

const CLIENT_SECRET = "whoop-client-secret-123";
const originalEnv = {
  clientId: process.env.WHOOP_CLIENT_ID,
  clientSecret: process.env.WHOOP_CLIENT_SECRET,
  callbackUrl: process.env.WHOOP_OAUTH_CALLBACK_URL,
  postRedirectUrl: process.env.WHOOP_OAUTH_POST_REDIRECT_URL,
  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function signWebhookBody(
  body: string,
  timestamp: number,
  secret = CLIENT_SECRET,
): Promise<{ signature: string; timestamp: string }> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}${body}`)),
  );
  return { signature: btoa(String.fromCharCode(...digest)), timestamp: String(timestamp) };
}

async function seedActiveConnection(
  t: ReturnType<typeof convexTest>,
  whoopUserId = "12345",
): Promise<Id<"users">> {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("whoopConnections", {
      userId,
      whoopUserId,
      generation: "gen-1",
      status: "active",
      accessTokenEncrypted: "access",
      refreshTokenEncrypted: "refresh",
      tokenExpiresAt: Date.now() + 3_600_000,
      scopes: ["read:recovery", "offline"],
      connectedAt: Date.now(),
      refreshDueAt: Date.now() + 1_800_000,
    });
    return userId;
  });
}

function webhookBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    user_id: 12345,
    id: "sleep-uuid-1",
    type: "recovery.updated",
    trace_id: "trace-1",
    ...overrides,
  });
}

describe("Whoop HTTP endpoints", () => {
  beforeEach(() => {
    process.env.WHOOP_CLIENT_ID = "client-id";
    process.env.WHOOP_CLIENT_SECRET = CLIENT_SECRET;
    process.env.WHOOP_OAUTH_CALLBACK_URL = "https://api.example.com/whoop/oauth/callback";
    process.env.WHOOP_OAUTH_POST_REDIRECT_URL = "https://app.example.com/settings";
    process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
  });

  afterEach(() => {
    restoreEnv("WHOOP_CLIENT_ID", originalEnv.clientId);
    restoreEnv("WHOOP_CLIENT_SECRET", originalEnv.clientSecret);
    restoreEnv("WHOOP_OAUTH_CALLBACK_URL", originalEnv.callbackUrl);
    restoreEnv("WHOOP_OAUTH_POST_REDIRECT_URL", originalEnv.postRedirectUrl);
    restoreEnv("TOKEN_ENCRYPTION_KEY", originalEnv.encryptionKey);
  });

  it("exchanges a valid OAuth callback for a one-time ticket bounce", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const state = "whoop-state-value-123456";
    await t.mutation(internal.whoop.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: await hashOAuthArtifact(state),
      now: Date.now(),
    });

    const response = await t.fetch(
      `/whoop/oauth/callback?code=whoop-authorization-code-123456&state=${state}`,
      { method: "GET" },
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://app.example.com");
    expect(location.pathname).toBe("/whoop/callback");
    expect(location.searchParams.get("ticket")).toBeTruthy();
    expect(location.searchParams.get("ticket")).not.toContain("whoop-authorization-code");
  });

  it("redirects OAuth errors and missing params to settings with a reason", async () => {
    const t = convexTest(schema, modules);

    const denied = await t.fetch("/whoop/oauth/callback?error=access_denied", { method: "GET" });
    const missing = await t.fetch("/whoop/oauth/callback?code=only-code-no-state-123", {
      method: "GET",
    });

    expect(denied.headers.get("Location")).toBe(
      "https://app.example.com/settings?whoop=error&reason=access_denied",
    );
    expect(missing.headers.get("Location")).toBe(
      "https://app.example.com/settings?whoop=error&reason=missing_params",
    );
  });

  it("accepts a correctly signed webhook for a connected member and records the event", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedActiveConnection(t);
    const body = webhookBody();
    const { signature, timestamp } = await signWebhookBody(body, Date.now());

    const response = await t.fetch("/whoop/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WHOOP-Signature": signature,
        "X-WHOOP-Signature-Timestamp": timestamp,
      },
      body,
    });

    expect(response.status).toBe(200);
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("whoopWebhookEvents")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "recovery.updated",
      resourceId: "sleep-uuid-1",
      whoopUserId: "12345",
      status: "received",
    });
  });

  it("silently ACKs deliveries for unknown members without retaining them", async () => {
    const t = convexTest(schema, modules);
    const body = webhookBody({ user_id: 99999 });
    const { signature, timestamp } = await signWebhookBody(body, Date.now());

    const response = await t.fetch("/whoop/webhook", {
      method: "POST",
      headers: {
        "X-WHOOP-Signature": signature,
        "X-WHOOP-Signature-Timestamp": timestamp,
      },
      body,
    });

    expect(response.status).toBe(200);
    const events = await t.run(async (ctx) => ctx.db.query("whoopWebhookEvents").collect());
    expect(events).toEqual([]);
  });

  it("rejects a webhook with a bad signature, stale timestamp, or malformed payload", async () => {
    const t = convexTest(schema, modules);
    await seedActiveConnection(t);
    const body = webhookBody();
    const wrongSecret = await signWebhookBody(body, Date.now(), "not-the-secret");
    const stale = await signWebhookBody(body, Date.now() - 10 * 60 * 1000);
    const malformedBody = "{not json";
    const malformed = await signWebhookBody(malformedBody, Date.now());

    const badSignature = await t.fetch("/whoop/webhook", {
      method: "POST",
      headers: {
        "X-WHOOP-Signature": wrongSecret.signature,
        "X-WHOOP-Signature-Timestamp": wrongSecret.timestamp,
      },
      body,
    });
    const staleTimestamp = await t.fetch("/whoop/webhook", {
      method: "POST",
      headers: {
        "X-WHOOP-Signature": stale.signature,
        "X-WHOOP-Signature-Timestamp": stale.timestamp,
      },
      body,
    });
    const invalidPayload = await t.fetch("/whoop/webhook", {
      method: "POST",
      headers: {
        "X-WHOOP-Signature": malformed.signature,
        "X-WHOOP-Signature-Timestamp": malformed.timestamp,
      },
      body: malformedBody,
    });

    expect(badSignature.status).toBe(403);
    expect(staleTimestamp.status).toBe(403);
    expect(invalidPayload.status).toBe(400);
  });

  it("returns 503 when Whoop is not configured on the deployment", async () => {
    delete process.env.WHOOP_CLIENT_ID;
    const t = convexTest(schema, modules);

    const response = await t.fetch("/whoop/webhook", { method: "POST", body: webhookBody() });

    expect(response.status).toBe(503);
  });
});
