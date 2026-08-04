/**
 * Whoop HTTP route registration, split from convex/http.ts for file-size
 * hygiene. Callers pass the shared router and the bounded body reader.
 */

import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { resolveWhoopAppOrigin } from "../httpOrigin";
import { getWhoopWebhookSecret, isWhoopConfigured } from "./config";
import { parseWhoopWebhookEnvelope } from "./webhookEvents";
import { verifyWhoopWebhookSignature } from "./webhookSignature";

const MAX_WEBHOOK_BODY_BYTES = 64 * 1_024;

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

export function addWhoopRoutes(
  http: HttpRouter,
  readBoundedBody: (req: Request, maxBytes: number) => Promise<string | null>,
): void {
  // Complete the exchange on the app origin where the authenticated session is available.
  http.route({
    path: "/whoop/oauth/callback",
    method: "GET",
    handler: httpAction(async (ctx, req) => {
      const url = new URL(req.url);
      const appOrigin = resolveWhoopAppOrigin();
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        const reason = oauthError === "access_denied" ? "access_denied" : "oauth_error";
        return redirectResponse(`${appOrigin}/settings?whoop=error&reason=${reason}`);
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code?.trim() || !state?.trim()) {
        return redirectResponse(`${appOrigin}/settings?whoop=error&reason=missing_params`);
      }

      const result = await ctx.runAction(internal.whoop.oauthFlow.issueWhoopCallbackTicket, {
        code,
        state,
      });
      if (!result.success) {
        return redirectResponse(`${appOrigin}/settings?whoop=error&reason=invalid_callback`);
      }

      const bounce = new URL("/whoop/callback", appOrigin);
      bounce.searchParams.set("ticket", result.ticket);
      return redirectResponse(bounce.toString());
    }),
  });

  /**
   * Whoop v2 webhooks. Deliveries carry only ids (`user_id`, `id`, `type`);
   * processing re-fetches the affected window from the API. Signature is
   * base64 HMAC-SHA256 of timestamp + body keyed on the app client secret.
   * Unknown members are ACKed silently and never retained.
   */
  http.route({
    path: "/whoop/webhook",
    method: "POST",
    handler: httpAction(async (ctx, req) => {
      if (!isWhoopConfigured()) {
        return new Response("Webhook unavailable", { status: 503 });
      }
      const body = await readBoundedBody(req, MAX_WEBHOOK_BODY_BYTES);
      if (body === null) return new Response("Payload too large", { status: 413 });
      if (
        !(await verifyWhoopWebhookSignature(
          req.headers.get("X-WHOOP-Signature"),
          req.headers.get("X-WHOOP-Signature-Timestamp"),
          body,
          getWhoopWebhookSecret(),
        ))
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      let envelope;
      try {
        envelope = parseWhoopWebhookEnvelope(JSON.parse(body));
      } catch {
        return new Response("Invalid payload", { status: 400 });
      }
      const owner = await ctx.runQuery(
        internal.whoop.connections.getActiveConnectionByWhoopUserId,
        { whoopUserId: envelope.whoopUserId },
      );
      if (!owner) return Response.json({});
      await ctx.runMutation(internal.whoop.webhookEvents.recordReceived, {
        userId: owner.userId,
        connectionGeneration: owner.generation,
        eventType: envelope.eventType,
        resourceId: envelope.resourceId,
        whoopUserId: envelope.whoopUserId,
        traceId: envelope.traceId,
        now: Date.now(),
      });
      return Response.json({});
    }),
  });
}
