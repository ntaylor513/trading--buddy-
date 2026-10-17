// netlify/functions/check-alerts-cron.js
// -----------------------------------------------------------------------
// Runs on a schedule (every 5 minutes, see the `config.schedule` export
// below — Netlify detects this automatically, no dashboard setup needed).
// This is what makes alerts work even when no Trading Buddy tab is open:
//   1. Loads every saved push subscription + its watched alert levels
//      (see save-subscription.js) AND every saved email address + its
//      watched alert levels (see save-email-alert.js) from Netlify Blobs.
//   2. Fetches live prices from Finnhub for every ticker being watched,
//      across both channels combined (one Finnhub call per symbol, no
//      matter how many devices/emails are watching it).
//   3. For any alert whose trigger price has been crossed (and that
//      hasn't already fired today), sends a push notification to that
//      device via Web Push, and/or an email via Resend, depending on
//      which channel(s) that alert is registered under.
//   4. Marks that alert as fired-for-today so it doesn't repeat on every
//      5-minute run, and resets automatically the next calendar day.
//
// Env vars needed in Netlify (Project configuration -> Environment
// variables), same place FINNHUB_API_KEY was added:
//   FINNHUB_API_KEY        (already set)
//   PUSH_VAPID_PUBLIC_KEY   (already set, for phone/browser push)
//   PUSH_VAPID_PRIVATE_KEY  (already set, for phone/browser push)
//   PUSH_VAPID_SUBJECT      (already set, e.g. mailto:you@example.com)
//   RESEND_API_KEY          NEW — for email alerts. Sign up free at
//                           resend.com, create an API key, paste it in.
//   RESEND_FROM_EMAIL       NEW — optional. Defaults to
//                           "Trading Buddy <onboarding@resend.dev>",
//                           Resend's built-in sending address. That
//                           default only delivers to the email address
//                           on your own Resend account — fine for
//                           testing/personal use. To email ANY address
//                           (e.g. a different inbox than your Resend
//                           login), verify your own domain in Resend
//                           and set this to an address at that domain,
//                           e.g. "Trading Buddy <alerts@yourdomain.com>".
// If RESEND_API_KEY is missing, email alerts are silently skipped (push
// alerts still work) rather than failing the whole run.
// -----------------------------------------------------------------------

const { schedule } = require("@netlify/functions");
const { getStore } = require("@netlify/blobs");
const webpush = require("web-push");

const FINNHUB_BASE = "https://finnhub.io/api/v1/quote";
const RESEND_API = "https://api.resend.com/emails";

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

async function sendAlertEmail({ apiKey, from, to, alert, price }) {
  const verb = alert.direction === "short" ? "broke down below" : "broke out above";
  const subject = `${alert.ticker} ${verb} $${alert.price.toFixed(2)}`;
  const body = `${alert.ticker} is now $${price.toFixed(2)}${alert.label ? " — " + alert.label : ""}.\n\nThis alert won't fire again today — it resets automatically tomorrow.\n\n— Trading Buddy`;
  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text: body,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${detail}`);
  }
}

// Wrapped in Netlify's `schedule()` helper so this runs on a cron timer
// automatically — no dashboard setup needed — while staying in the same
// CommonJS (`require`/`exports`) style as the rest of this repo's functions.
exports.handler = schedule("*/5 * * * *", async () => {
  const finnhubKey = process.env.FINNHUB_API_KEY;
  const vapidPublic = process.env.PUSH_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.PUSH_VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.PUSH_VAPID_SUBJECT || "mailto:admin@example.com";
  const resendKey = process.env.RESEND_API_KEY || null;
  const resendFrom = process.env.RESEND_FROM_EMAIL || "Trading Buddy <onboarding@resend.dev>";

  if (!finnhubKey) {
    console.error("cron: missing FINNHUB_API_KEY — skipping run");
    return { statusCode: 200, body: "missing config, skipped" };
  }

  const pushReady = Boolean(vapidPublic && vapidPrivate);
  if (pushReady) {
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  } else {
    console.warn("cron: missing PUSH_VAPID_* env vars — push alerts skipped this run");
  }
  if (!resendKey) {
    console.warn("cron: missing RESEND_API_KEY — email alerts skipped this run");
  }

  const pushStore = getStore("push-subscriptions");
  const emailStore = getStore("email-subscribers");

  const [pushList, emailList] = await Promise.all([
    pushStore.list().catch(() => ({ blobs: [] })),
    emailStore.list().catch(() => ({ blobs: [] })),
  ]);

  const pushRecords = [];
  for (const b of pushList.blobs || []) {
    const rec = await pushStore.get(b.key, { type: "json" });
    if (rec) pushRecords.push({ key: b.key, rec });
  }

  const emailRecords = [];
  for (const b of emailList.blobs || []) {
    const rec = await emailStore.get(b.key, { type: "json" });
    if (rec) emailRecords.push({ key: b.key, rec });
  }

  if (pushRecords.length === 0 && emailRecords.length === 0) {
    return { statusCode: 200, body: "no subscriptions" };
  }

  // Dedupe tickers across every device AND every email so we call
  // Finnhub once per symbol, no matter how many places are watching it.
  const allTickers = new Set();
  for (const { rec } of pushRecords) for (const a of rec.alerts || []) allTickers.add(a.ticker);
  for (const { rec } of emailRecords) for (const a of rec.alerts || []) allTickers.add(a.ticker);
  if (allTickers.size === 0) return { statusCode: 200, body: "no alerts set" };

  const prices = await fetchQuotes([...allTickers], finnhubKey);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let pushSent = 0;
  let emailSent = 0;

  if (pushReady) {
    for (const { key, rec } of pushRecords) {
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
          pushSent++;
        } catch (err) {
          // 404/410 means the browser unsubscribed or the subscription expired —
          // delete the stale record so we stop wasting cycles on it.
          if (err.statusCode === 404 || err.statusCode === 410) {
            await pushStore.delete(key);
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

      if (changed) await pushStore.setJSON(key, rec);
    }
  }

  if (resendKey) {
    for (const { key, rec } of emailRecords) {
      let changed = false;

      for (const alert of rec.alerts || []) {
        const price = prices[alert.ticker];
        if (price == null) continue;
        if (alert.firedOn === today) continue; // already fired today
        if (!crossed(alert.direction, price, alert.price)) continue;

        try {
          await sendAlertEmail({ apiKey: resendKey, from: resendFrom, to: rec.email, alert, price });
          alert.firedOn = today;
          changed = true;
          emailSent++;
        } catch (err) {
          console.error(`cron: email send failed for ${alert.ticker} -> ${rec.email}`, err);
        }
      }

      if (!changed) {
        for (const alert of rec.alerts || []) {
          if (alert.firedOn && alert.firedOn !== today) alert.firedOn = null;
        }
      }

      if (changed) await emailStore.setJSON(key, rec);
    }
  }

  return {
    statusCode: 200,
    body: `checked ${allTickers.size} tickers, sent ${pushSent} push + ${emailSent} email notifications`,
  };
});
