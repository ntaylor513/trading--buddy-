// netlify/functions/save-subscription.js
// -----------------------------------------------------------------------
// Stores (or updates) one browser/phone's push subscription plus the list
// of breakout levels it wants watched, so the scheduled function
// (check-alerts-cron.js) can check prices and send push notifications
// even when no Trading Buddy tab is open.
//
// Uses Netlify Blobs — Netlify's built-in key/value store. No extra
// signup or env vars needed for this part; it works automatically on any
// Netlify site.
//
// Request:  POST /api/save-subscription
//           { "subscription": <PushSubscription JSON from the browser>,
//             "alerts": [ { "ticker": "AAPL", "direction": "long", "price": 230 }, ... ] }
// Response: { "ok": true }
//
// A DELETE request with the same { "subscription": {...} } body removes
// that device's subscription (used when the user turns phone alerts off).
// -----------------------------------------------------------------------

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

function keyFor(endpoint) {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
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

  const subscription = payload.subscription;
  if (!subscription || !subscription.endpoint) {
    return { statusCode: 400, body: JSON.stringify({ error: "subscription with endpoint is required" }) };
  }

  const store = getStore("push-subscriptions");
  const key = keyFor(subscription.endpoint);

  if (event.httpMethod === "DELETE") {
    await store.delete(key);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, removed: true }) };
  }

  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  const record = {
    subscription,
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
