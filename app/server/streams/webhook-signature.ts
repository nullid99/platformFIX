import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies Cloudflare's `Webhook-Signature: time=<unix>,sig1=<hex>` header.
 * See https://developers.cloudflare.com/stream/manage-video-library/using-webhooks/
 */
export function verifyStreamWebhookSignature(header: string | undefined, rawBody: Buffer, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((pair) => {
    const [key, value] = pair.split("=");
    return [key?.trim(), value?.trim()];
  }));
  const time = parts.time;
  const sig1 = parts.sig1;
  if (!time || !sig1) return false;

  const expected = createHmac("sha256", secret).update(`${time}.${rawBody.toString("utf8")}`).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(sig1, "hex");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
