import { describe, expect, it } from "vitest";
import { verifyWhoopWebhookSignature } from "./webhookSignature";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const SECRET = "whoop-client-secret-123";
const BODY = '{"user_id":10129,"id":"e3f34cf9","type":"recovery.updated"}';

async function signPayload(body: string, timestampMs: number, secret = SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestampMs}${body}`)),
  );
  return btoa(String.fromCharCode(...signature));
}

describe("Whoop webhook signatures", () => {
  it("accepts a fresh base64 HMAC of timestamp plus raw body keyed on the client secret", async () => {
    const signature = await signPayload(BODY, NOW);

    await expect(
      verifyWhoopWebhookSignature(signature, String(NOW), BODY, SECRET, NOW),
    ).resolves.toBe(true);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const signature = await signPayload(BODY, NOW, "some-other-secret");

    await expect(
      verifyWhoopWebhookSignature(signature, String(NOW), BODY, SECRET, NOW),
    ).resolves.toBe(false);
  });

  it("rejects a tampered body", async () => {
    const signature = await signPayload(BODY, NOW);

    await expect(
      verifyWhoopWebhookSignature(signature, String(NOW), `${BODY} `, SECRET, NOW),
    ).resolves.toBe(false);
  });

  it("rejects deliveries missing either header", async () => {
    const signature = await signPayload(BODY, NOW);

    await expect(verifyWhoopWebhookSignature(null, String(NOW), BODY, SECRET, NOW)).resolves.toBe(
      false,
    );
    await expect(verifyWhoopWebhookSignature(signature, null, BODY, SECRET, NOW)).resolves.toBe(
      false,
    );
  });

  it("rejects a non-numeric timestamp header", async () => {
    const signature = await signPayload(BODY, NOW);

    await expect(
      verifyWhoopWebhookSignature(signature, "not-a-timestamp", BODY, SECRET, NOW),
    ).resolves.toBe(false);
    await expect(
      verifyWhoopWebhookSignature(signature, `${NOW}.5`, BODY, SECRET, NOW),
    ).resolves.toBe(false);
  });

  it("rejects a timestamp more than five minutes old", async () => {
    const staleAt = NOW - 5 * 60 * 1000 - 1;
    const signature = await signPayload(BODY, staleAt);

    await expect(
      verifyWhoopWebhookSignature(signature, String(staleAt), BODY, SECRET, NOW),
    ).resolves.toBe(false);
  });

  it("rejects a future timestamp beyond the freshness tolerance", async () => {
    const futureAt = NOW + 5 * 60 * 1000 + 1;
    const signature = await signPayload(BODY, futureAt);

    await expect(
      verifyWhoopWebhookSignature(signature, String(futureAt), BODY, SECRET, NOW),
    ).resolves.toBe(false);
  });

  it("rejects a signature header that is not valid base64", async () => {
    await expect(
      verifyWhoopWebhookSignature("not*base64!", String(NOW), BODY, SECRET, NOW),
    ).resolves.toBe(false);
  });

  it("rejects an oversized signature header", async () => {
    await expect(
      verifyWhoopWebhookSignature("A".repeat(68), String(NOW), BODY, SECRET, NOW),
    ).resolves.toBe(false);
  });
});
