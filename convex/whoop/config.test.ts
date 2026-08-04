import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getWhoopAppConfig,
  getWhoopWebhookSecret,
  isWhoopConfigured,
  supportedWhoopScopes,
} from "./config";

const originalEnv = {
  clientId: process.env.WHOOP_CLIENT_ID,
  clientSecret: process.env.WHOOP_CLIENT_SECRET,
  callbackUrl: process.env.WHOOP_OAUTH_CALLBACK_URL,
  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("Whoop configuration", () => {
  beforeEach(() => {
    process.env.WHOOP_CLIENT_ID = "client-id";
    process.env.WHOOP_CLIENT_SECRET = "client-secret";
    process.env.WHOOP_OAUTH_CALLBACK_URL = "https://api.example.com/whoop/oauth/callback";
    process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
  });

  afterEach(() => {
    restoreEnv("WHOOP_CLIENT_ID", originalEnv.clientId);
    restoreEnv("WHOOP_CLIENT_SECRET", originalEnv.clientSecret);
    restoreEnv("WHOOP_OAUTH_CALLBACK_URL", originalEnv.callbackUrl);
    restoreEnv("TOKEN_ENCRYPTION_KEY", originalEnv.encryptionKey);
  });

  it("keeps only the supported read scopes and drops duplicates", () => {
    expect(
      supportedWhoopScopes(["read:recovery", "read:recovery", "read:workout", "openid", "offline"]),
    ).toEqual(["read:recovery", "offline"]);
    expect(supportedWhoopScopes(["read:workout", "openid"])).toEqual([]);
  });

  it("requires all provider and encryption configuration", () => {
    expect(isWhoopConfigured()).toBe(true);
    expect(getWhoopAppConfig()).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://api.example.com/whoop/oauth/callback",
    });

    delete process.env.TOKEN_ENCRYPTION_KEY;

    expect(isWhoopConfigured()).toBe(false);
  });

  it("fails closed when the OAuth app settings are missing", () => {
    delete process.env.WHOOP_CLIENT_SECRET;

    expect(isWhoopConfigured()).toBe(false);
    expect(() => getWhoopAppConfig()).toThrow("Whoop is not configured");
  });

  it("signs webhooks with the client secret and fails closed when it is unset", () => {
    expect(getWhoopWebhookSecret()).toBe("client-secret");

    delete process.env.WHOOP_CLIENT_SECRET;

    expect(() => getWhoopWebhookSecret()).toThrow("WHOOP_CLIENT_SECRET env var is not set");
  });
});
