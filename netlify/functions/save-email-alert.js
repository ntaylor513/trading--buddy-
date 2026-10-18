// netlify/functions/save-email-alert.js
// (touched 2026-10-18 to force Netlify to rebundle this function with the
// current _blobs.js — a prior deploy left it on a stale bundled copy)
// -----------------------------------------------------------------------
// Stores (or updates) one email address plus the list of breakout levels
// it wants watched, so the scheduled function (check-alerts-cron.js) can
// check prices and send an email when a trigger is hit — independent of
// browser push, so it works even on a device that never clicked "Enable
// Phone Alerts" and isn't tied to one browser.
//
// SECURITY NOTE: a brand-new (or not-yet-confirmed) email address is
// stored as unconfirmed and gets a one-time confirmation link sent to it
// via confirm-email-alert.js. check-alerts-cron.js only ever emails
// CONFIRMED addresses. Without this, anyone could POST any address here
// with a trigger price likely to hit soon and turn this into a spam
// relay. Once an address is confirmed, later saves (editing the alert
// list) don't require re-confirming.
//
// Uses Netlify Blobs — the same key/value store save-subscription.js
// uses for push, just a separate "bucket" so the two channels don't
// collide, opened via _blobs.js (see that file if you ever hit a
// MissingBlobsEnvironmentError; it explains the BLOBS_SITE_ID /
// BLOBS_TOKEN env vars that fix it).
//
// Needs the same RESEND_API_KEY / RESEND_FROM_EMAIL env vars described
// in check-alerts-cron.js's comments, to send the confirmation email.
// Also uses Netlify's auto-provided `URL` env var (the site's own base
// URL) to build the confirmation link; falls back to DEPLOY_PRIME_URL /
// DEPLOY_URL if that's ever unset (e.g. deploy previews).
//
// Request:  POST /api/save-email-alert
//           { "email": "you@example.com",
//             "alerts": [ { "ticker": "AAPL", "direction": "long", "price": 230 }, ... ] }
// Response: { "ok": true, "alertCount": 1, "confirmed": false, "rejected": [] }
//           confirmed:false means a confirmation email was just sent (or
//           re-sent) and alerts won't fire until that link is clicked.
//           "rejected" lists any alerts dropped for bad shape, so the
//           caller isn't left guessing why alertCount is lower than
//           expected.
//
// A DELETE request with the same { "email": "..." } body removes that
// address entirely (used when the user turns email alerts off).
// -----------------------------------------------------------------------

const crypto = require("crypto");
const { getAlertStore } = require("./_blobs.js");
const { sendEmail } = require("./_resend.js");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function keyFor(email) {
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

// Validates each incoming alert and reports *why* anything got dropped,
// instead of silently filtering it out.
function normalizeAlerts(raw) {
  const alerts = [];
  const rejected = [];
  for (const a of Array.isArray(raw) ? raw : []) {
    if (!a || typeof a !== "object") {
      rejected.push({ input: a, reason: "not an object" });
      continue;
    }
    if (!a.ticker || typeof a.ticker !== "string") {
      rejected.push({ input: a, reason: "missing/invalid ticker" });
      continue;
    }
    if (a.direction !== "long" && a.direction !== "short") {
      rejected.push({ ticker: a.ticker, reason: "direction must be 'long' or 'short'" });
      continue;
    }
    if (typeof a.price !== "number" || !Number.isFinite(a.price)) {
      rejected.push({ ticker: a.ticker, reason: "price must be a number" });
      continue;
    }
    alerts.push({
      ticker: a.ticker.toUpperCase(),
      direction: a.direction,
      price: a.price,
      label: a.label || "",
      firedOn: null, // date string (YYYY-MM-DD) this alert last fired, so it only fires once per day
    });
  }
  return { alerts, rejected };
}

function confirmBaseUrl() {
  return process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST" && event.httpMethod !== "DELETE") {
    return { statusCode: 405, body: JSON.stringify({ error: "POST or DELETE only" }) };
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

  let store;
  try {
    store = getAlertStore("email-subscribers");
  } catch (e) {
    console.error("save-email-alert: could not open Blobs store", e);
    return { statusCode: 500, body: JSON.stringify({ error: "storage-unavailable", message: String(e.message || e) }) };
  }
  const key = keyFor(email);

  if (event.httpMethod === "DELETE") {
    await store.delete(key);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, removed: true }) };
  }

  const { alerts, rejected } = normalizeAlerts(payload.alerts);

  const existing = await store.get(key, { type: "json" }).catch(() => null);
  const alreadyConfirmed = Boolean(existing && existing.confirmed);

  const record = {
    email,
    alerts,
    confirmed: alreadyConfirmed,
    updatedAt: new Date().toISOString(),
  };

  let confirmationSent = false;
  let confirmationError = null;

  if (!alreadyConfirmed) {
    const resendKey = process.env.RESEND_API_KEY || null;
    const resendFrom = process.env.RESEND_FROM_EMAIL || "Trading Buddy <onboarding@resend.dev>";
    const baseUrl = confirmBaseUrl();

    if (!resendKey) {
      // Don't silently store an address that can never actually fire.
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "email-not-configured",
          message: "Email alerts aren't set up yet (missing RESEND_API_KEY) — confirmation email can't be sent.",
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
        text: `Someone (hopefully you) set up Trading Buddy price alerts for this email address.\n\nClick to confirm and start receiving alerts:\n${confirmUrl}\n\nThis link expires in 24 hours. If you didn't request this, you can ignore this email — nothing will be sent until it's confirmed.\n\n— Trading Buddy`,
      });
      confirmationSent = true;
    } catch (err) {
      console.error("save-email-alert: failed to send confirmation email", err);
      confirmationError = String(err.message || err);
    }
  }

  await store.setJSON(key, record);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ok: true,
      alertCount: record.alerts.length,
      confirmed: record.confirmed,
      confirmationSent,
      ...(confirmationError ? { confirmationError } : {}),
      ...(rejected.length ? { rejected } : {}),
    }),
  };
};
