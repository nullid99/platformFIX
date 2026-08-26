import "dotenv/config";

async function registerStreamWebhook(): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_STREAM_API_TOKEN?.trim();
  const webOrigin = (process.env.PUBLIC_WEB_ORIGIN ?? process.env.WEB_ORIGIN)?.trim();

  if (!accountId || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_API_TOKEN first");
  if (!webOrigin) throw new Error("Set PUBLIC_WEB_ORIGIN to your public HTTPS origin");
  if (!/^https:\/\//.test(webOrigin) || /localhost|127\.0\.0\.1/.test(webOrigin)) {
    throw new Error("PUBLIC_WEB_ORIGIN must be a public HTTPS URL — Cloudflare cannot reach localhost");
  }

  const notificationUrl = `${webOrigin.replace(/\/$/, "")}/api/streams/webhook`;
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/webhook`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ notificationUrl }),
  });
  const payload = await response.json() as { success: boolean; result?: { notificationUrl: string; secret: string }; errors?: Array<{ message: string }> };
  if (!response.ok || !payload.success || !payload.result) {
    throw new Error(payload.errors?.[0]?.message ?? `Webhook registration failed (${response.status})`);
  }

  console.log("Cloudflare Stream webhook registered.");
  console.log(`notificationUrl: ${payload.result.notificationUrl}`);
  console.log("Add this to your production .env, then restart the API:");
  console.log(`CLOUDFLARE_STREAM_WEBHOOK_SECRET="${payload.result.secret}"`);
}

registerStreamWebhook().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Stream webhook registration failed");
  process.exitCode = 1;
});
