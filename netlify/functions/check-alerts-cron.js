// netlify/functions/check-alerts-cron.js
// -----------------------------------------------------------------------
// Runs on a schedule (every 1 minute, see the `config.schedule` export
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
//      1-minute run, and resets automatically the next calendar day.
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
const { getAlertStore } = require("./_blobs.js");
const { sendEmail } = require("./_resend.js");
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

// Regular NYSE/NASDAQ session only: 9:30am-4:00pm America/New_York,
// Monday-Friday. Doesn't know about market holidays (Thanksgiving, etc.)
// — those still run — but this alone kills the biggest source of wasted
// Finnhub calls and stale-quote false alerts: every night and weekend.
// Set FORCE_MARKET_OPEN=true in env vars to bypass this for testing.
function isRegularMarketHoursNow(date = new Date()) {
  if (process.env.FORCE_MARKET_OPEN === "true") return true;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  if (map.weekday === "Sat" || map.weekday === "Sun") return false;

  const hour = Number(map.hour) % 24; // h23 can report "24" at midnight
  const minute = Number(map.minute);
  const minutesSinceMidnight = hour * 60 + minute;

  const marketOpen = 9 * 60 + 30; // 9:30am ET
  const marketClose = 16 * 60; // 4:00pm ET
  return minutesSinceMidnight >= marketOpen && minutesSinceMidnight < marketClose;
}

async function sendAlertEmail({ apiKey, from, to, alert, price }) {
  const verb = alert.direction === "short" ? "broke down below" : "broke out above";
  const subject = `${alert.ticker} ${verb} $${alert.price.toFixed(2)}`;
  const text = `${alert.ticker} is now $${price.toFixed(2)}${alert.label ? " — " + alert.label : ""}.\n\nThis alert won't fire again today — it resets automatically tomorrow.\n\n— Trading Buddy`;
  await sendEmail({ apiKey, from, to, subject, text });
}

// Wrapped in Netlify's `schedule()` helper so this runs on a cron timer
// automatically — no dashboard setup needed — while staying in the same
// CommonJS
