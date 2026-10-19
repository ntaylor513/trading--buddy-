// netlify/functions/save-hotlist-subscription.js
// -----------------------------------------------------------------------
// Lets a user turn the Daily Hot List email digest on or off for their own
// address, independent of the per-ticker breakout alerts handled by
// save-email-alert.js. Shares the same Netlify Blobs record (same store,
// same key-by-email, same confirmation flow) so one confirmed address
// covers both breakout alerts and the Hot List digest -- nobody has to
// confirm their inbox twice, and confirm-email-alert.js needs no changes
// to also confirm a hotlist-only signup.
//
// Request:  POST /api/save-hotlist-subscription
//           { "email": "you@example.com", "enabled": true }
// Response: { "ok": true, "enabled": true, "confirmed": false,
//              "confirmationSent": true }
//           confirmed:false + confirmationSent:true means a confirmation
//           email was just sent -- the digest won't go out until that
//           link is clicked (send-hotlist-cron.js only emails confirmed
//           addresses that also have hotListEnabled true).
//
// Turning OFF (enabled:false) never deletes the record outright -- it
// just clears hotListEnabled, so any separately-configured breakout
// alerts on the same address keep working, and flipping it back on later
// doesn't need to re-confirm an already-confirmed address.
// -----------------------------------------------------------------------

const crypto = require("crypto");
const { getAlertStore } = require("./_blobs.js");
const { sendEmail } = require("./_resend.js");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function keyFor(email) {
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function confirmBaseUrl() {
  return process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "POST only" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "invalid JSON body" }) };
  }

  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (!email || !EMAIL_RE.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: "a valid email address is required" }) };
  }
  const enabled = payload.enabled !== false; // default true unless explicitly false

  let store;
  try {
    store = getAlertStore("email-subscribers");
  } catch (e) {
    console.error("save-hotlist-subscription: could not open Blobs store", e);
    return { statusCode: 500, body: JSON.stringify({ error: "storage-unavailable", message: String(e.message || e) }) };
  }
  const key = keyFor(email);

  const existing = await store.get(key, { type: "json" }).catch(() => null);
  const alreadyConfirmed = Boolean(existing && existing.confirmed);

  const record = existing
    ? { ...existing }
    : { email, alerts: [], confirmed: false };
  record.email = email;
  record.hotListEnabled = enabled;
  record.updatedAt = new Date().toISOString();

  // Turning it off never needs a confirmation round-trip -- just flip the
  // flag and stop. (If the address was never confirmed, nothing was going
  // to send to it anyway.)
  if (!enabled) {
    await store.setJSON(key, record);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, enabled: false, confirmed: alreadyConfirmed }),
    };
  }

  let confirmationSent = false;
  let confirmationError = null;

  if (!alreadyConfirmed) {
    const resendKey = process.env.RESEND_API_KEY || null;
    const resendFrom = process.env.RESEND_FROM_EMAIL || "Trading Buddy <onboarding@resend.dev>";
    const baseUrl = confirmBaseUrl();

    if (!resendKey) {
      // Don't silently store an address that can never actually receive it.
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "email-not-configured",
          message: "Email alerts aren't set up yet (missing RESEND_API_KEY) -- confirmation email can't be sent.",
        }),
      };
    }
    if (!baseUrl) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "missing-base-url",
          message: "Could not determine this site's URL to build a confirmation link.",
        }),
      };
    }

    const token = crypto.randomBytes(24).toString("hex");
    record.confirmToken = token;
    record.confirmTokenExpires = Date.now() + CONFIRM_TOKEN_TTL_MS;

    const confirmUrl = `${baseUrl.replace(/\/+$/, "")}/api/confirm-email-alert?email=${encodeURIComponent(email)}&token=${token}`;

    try {
      await sendEmail({
        apiKey: resendKey,
        from: resendFrom,
        to: email,
        subject: "Confirm your Trading Buddy email alerts",
        text: `Someone (hopefully you) turned on the Trading Buddy Daily Hot List email for this address.\n\nClick to confirm and start receiving it each trading morning:\n${confirmUrl}\n\nThis link expires in 24 hours. If you didn't request this, you can ignore this email -- nothing will be sent until it's confirmed.\n\n— Trading Buddy`,
      });
      confirmationSent = true;
    } catch (err) {
      console.error("save-hotlist-subscription: failed to send confirmation email", err);
      confirmationError = String(err.message || err);
    }
  }

  await store.setJSON(key, record);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ok: true,
      enabled: true,
      confirmed: record.confirmed,
      confirmationSent,
      ...(confirmationError ? { confirmationError } : {}),
    }),
  };
};
