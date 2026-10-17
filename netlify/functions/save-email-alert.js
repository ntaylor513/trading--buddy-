// netlify/functions/save-email-alert.js
// -----------------------------------------------------------------------
// Stores (or updates) one email address plus the list of breakout levels
// it wants watched, so the scheduled function (check-alerts-cron.js) can
// check prices and send an email when a trigger is hit — independent of
// browser push, so it works even on a device that never clicked "Enable
// Phone Alerts" and isn't tied to one browser.
//
// Uses Netlify Blobs — the same key/value store save-subscription.js
// uses for push, just a separate "bucket" so the two channels don't
// collide. No extra signup needed for THIS part; sending the email in
// check-alerts-cron.js does need a RESEND_API_KEY env var — see that
// file's comments.
//
// Request:  POST /api/save-email-alert
//           { "email": "you@example.com",
//             "alerts": [ { "ticker": "AAPL", "direction": "long", "price": 230 }, ... ] }
// Response: { "ok": true }
//
// A DELETE request with the same { "email": "..." } body removes that
// address (used when the user turns email alerts off).
// -----------------------------------------------------------------------

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function keyFor(email) {
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
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

  const store = getStore("email-subscribers");
  const key = keyFor(email);

  if (event.httpMethod === "DELETE") {
    await store.delete(key);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, removed: true }) };
  }

  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  const record = {
    email,
    alerts: alerts
      .filter((a) => a && a.ticker && a.direction && typeof a.price === "number")
      .map((a) => ({
        ticker: String(a.ticker).toUpperCase(),
        direction: a.direction === "short" ? "short" : "long",
        price: a.price,
        label: a.label || "",
        firedOn: null, // date string (YYYY-MM-DD) this alert last fired, so it only fires once per day
      })),
    updatedAt: new Date().toISOString(),
  };

  await store.setJSON(key, record);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, alertCount: record.alerts.length }),
  };
};
