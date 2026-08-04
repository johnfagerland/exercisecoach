import { decrypt, encrypt } from "../tonal/encryption";

export const WHOOP_AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
export const WHOOP_API_BASE_URL = "https://api.prod.whoop.com/developer";

/**
 * `offline` is required for Whoop to issue a refresh token; without it the
 * connection dies when the hourly access token expires.
 */
export const WHOOP_READ_SCOPES = [
  "read:recovery",
  "read:sleep",
  "read:cycles",
  "read:profile",
  "offline",
] as const;

export type WhoopReadScope = (typeof WHOOP_READ_SCOPES)[number];

const whoopReadScopeSet = new Set<string>(WHOOP_READ_SCOPES);

/** Keep only the supported read scopes so status never exposes unrelated grants. */
export function supportedWhoopScopes(scopes: readonly string[]): WhoopReadScope[] {
  return [...new Set(scopes)].filter((scope): scope is WhoopReadScope =>
    whoopReadScopeSet.has(scope),
  );
}

export interface WhoopAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function isWhoopConfigured(): boolean {
  return Boolean(
    process.env.WHOOP_CLIENT_ID &&
    process.env.WHOOP_CLIENT_SECRET &&
    process.env.WHOOP_OAUTH_CALLBACK_URL &&
    process.env.TOKEN_ENCRYPTION_KEY,
  );
}

export function getWhoopAppConfig(): WhoopAppConfig {
  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  const redirectUri = process.env.WHOOP_OAUTH_CALLBACK_URL;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Whoop is not configured: set WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, WHOOP_OAUTH_CALLBACK_URL",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

/** Whoop signs webhook deliveries with the app's client secret. */
export function getWhoopWebhookSecret(): string {
  const secret = process.env.WHOOP_CLIENT_SECRET;
  if (!secret) throw new Error("WHOOP_CLIENT_SECRET env var is not set");
  return secret;
}

function getEncryptionKey(): string {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY env var is not set");
  return key;
}

export async function encryptWhoopSecret(plaintext: string): Promise<string> {
  return encrypt(plaintext, getEncryptionKey());
}

export async function decryptWhoopSecret(ciphertext: string): Promise<string> {
  return decrypt(ciphertext, getEncryptionKey());
}
