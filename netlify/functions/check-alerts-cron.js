// netlify/functions/check-alerts-cron.js
// -----------------------------------------------------------------------
// Runs on a schedule (every 5 minutes, see the `config.schedule` export
// below — Netlify detects this automatically, no dashboard setup needed).
// This is what makes alerts work even when no Trading Buddy tab is open:
//   1. Loads every saved push subscription + its watched alert levels
//      (see save-subscription.js) from Netlify Blobs.
//   2. Fetches live prices from Finnhub for every ticker being watched.
//   3. For any alert whose trigger price has been crossed (and that
//      hasn't already fired today), sends a real push notification to
//      that device via the Web Push protocol.
//   4. Marks that alert as fired-for-today so it doesn't repeat on every
//      5-minute run, and resets automatically the next calendar day.
//
// Requires three environment variables in Netlify (Project configuration
// -> Environment variables), same place FINNHUB_API_KEY was added:
//   FINNHUB_API_KEY        (already set)
//   PUSH_VAPID_PUBLIC_KEY
//   PUSH_VAPID_PRIVATE_KEY
//   PUSH_VAPID_SUBJECT      e.g. mailto:you@example.com
// -----------------------------------------------------------------------

const { schedule } = require("@netlify/functions");
const { getStore } = require("@netlify/blobs");
const webpush = require("web-push");

const FINNHUB_BASE = "https://finnhub.io/api/v1/quote";

async function fetchQuotes(symbols, apiKey) {
  const results = {};
  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const res = await fetch(`${FINNHUB_BASE}?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`);
        if (!res.ok) return;
        const data = await res.json();
        if (typeof data.c === "number" && data.c > 0) results[symbol] = data.c;
      } catch (err) {
        console.error(`cron: quote fetch failed for ${symbol}`, err);
      }
    })
  );
  return results;
}

function crossed(direction, price, trigger) {
  return direction === "long" ? price >= trigger : price <= trigger;
}

// Wrapped in Netlify's `schedule()` helper so this runs on a cron timer
// automatically — no dashboard setup needed — while staying in the same
// CommonJS (`require`/`exports`) style as the rest of this repo's functions.
exports.handler = schedule("*/5 * * * *", async () => {
  const finnhubKey = process.env.FINNHUB_API_KEY;
  const vapidPublic = process.env.PUSH_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.PUSH_VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.PUSH_VAPID_SUBJECT || "mailto:admin@example.com";

  if (!finnhubKey || !vapidPublic || !vapidPrivate) {
    console.error("cron: missing FINNHUB_API_KEY or PUSH_VAPID_* env vars — skipping run");
    return { statusCode: 200, body: "missing config, skipped" };
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const store = getStore("push-subscriptions");
  const { blobs } = await store.list();
  if (!blobs || blobs.length === 0) {
    return { statusCode: 200, body: "no subscriptions" };
  }

  const records = [];
  for (const b of blobs) {
    const rec = await store.get(b.key, { type: "json" });
    if (rec) records.push({ key: b.key, rec });
  }

  // Dedupe tickers across every device so we call Finnhub once per symbol.
  const allTickers = new Set();
  for (const { rec } of records) {
    for (const a of rec.alerts || []) allTickers.add(a.ticker);
  }
  if (allTickers.size === 0) return { statusCode: 200, body: "no alerts set" };

  const prices = await fetchQuotes([...allTickers], finnhubKey);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let sent = 0;
  for (const { key, rec } of records) {
    let changed = false;

    for (const alert of rec.alerts || []) {
      const price = prices[alert.ticker];
      if (price == null) continue;
      if (alert.firedOn === today) continue; // already fired today
      if (!crossed(alert.direction, price, alert.price)) continue;

      const payload = JSON.stringify({
        title: `${alert.ticker} ${alert.direction === "long" ? "broke out above" : "broke down below"} $${alert.price.toFixed(2)}`,
        body: `${alert.ticker} is now $${price.toFixed(2)}${alert.label ? " — " + alert.label : ""}`,
        tag: `breakout-${alert.ticker}`,
        url: "/",
      });

      try {
        await webpush.sendNotification(rec.subscription, payload);
        alert.firedOn = today;
        changed = true;
        sent++;
      } catch (err) {
        // 404/410 means the browser unsubscribed or the subscription expired —
        // delete the stale record so we stop wasting cycles on it.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await store.delete(key);
          changed = false;
          break;
        }
        console.error(`cron: push send failed for ${alert.ticker}`, err);
      }
    }

    // Roll fired-flags over on a new day so alerts can fire again next session.
    if (!changed) {
      for (const alert of rec.alerts || []) {
        if (alert.firedOn && alert.firedOn !== today) alert.firedOn = null;
      }
    }

    if (changed) await store.setJSON(key, rec);
  }

  return { statusCode: 200, body: `checked ${allTickers.size} tickers, sent ${sent} notifications` };
});
