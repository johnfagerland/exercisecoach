const SIGNATURE_FRESHNESS_MS = 5 * 60 * 1000;
const BASE64_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_SIGNATURE_LENGTH = 64;

function base64ToBytes(value: string): Uint8Array | null {
  if (!BASE64_SIGNATURE_PATTERN.test(value)) return null;
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Whoop signs each delivery with base64(HMAC-SHA256(timestamp + rawBody))
 * keyed on the app's client secret, carried in `X-WHOOP-Signature` with the
 * millisecond timestamp in `X-WHOOP-Signature-Timestamp`.
 */
export async function verifyWhoopWebhookSignature(
  signatureHeader: string | null,
  timestampHeader: string | null,
  rawBody: string,
  clientSecret: string,
  now = Date.now(),
): Promise<boolean> {
  if (!signatureHeader || !timestampHeader) return false;
  if (signatureHeader.length > MAX_SIGNATURE_LENGTH) return false;
  if (!/^\d{1,16}$/.test(timestampHeader)) return false;
  const timestampMs = Number(timestampHeader);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(now - timestampMs) > SIGNATURE_FRESHNESS_MS) {
    return false;
  }
  const received = base64ToBytes(signatureHeader);
  if (!received) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(clientSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestampHeader}${rawBody}`)),
  );
  return constantTimeBytesEqual(received, expected);
}
