// netlify/functions/send-hotlist-cron.js
// -----------------------------------------------------------------------
// Emails the Daily Hot List to every address that has confirmed its email
// (see save-email-alert.js / save-hotlist-subscription.js) AND has turned
// the digest on via save-hotlist-subscription.js -- once per trading day,
// before the open.
//
// Pulls the day's picks from this site's own /api/hotlist endpoint (the
// same live-mover ranker the page itself calls) instead of duplicating
// that ranking logic here, so the emailed list always matches what the
// app shows.
//
// TIMING: runs every 5 minutes, every day (same pattern as
// check-alerts-cron.js), and only actually does anything inside an
// 8:00-8:15am America/New_York window, Monday-Friday -- computed from
// wall-clock time via Intl, not a fixed UTC cron offset, so it doesn't
// drift an hour when the US switches between EST/EDT. A per-address
// `hotListSentOn` date guard (reset automatically each calendar day, same
// idea as `firedOn` in check-alerts-cron.js) keeps the 3 runs inside that
// window from sending the same person 3 emails.
// Set FORCE_HOTLIST_SEND=true in env vars to bypass the time window for
// testing.
//
// Doesn't know about market holidays (same limitation as
// check-alerts-cron.js) -- those still fire a send.
//
// Needs RESEND_API_KEY / RESEND_FROM_EMAIL (see check-alerts-cron.js's
// comments) -- if missing, the run is skipped (logged) rather than
// failing loudly with nothing to send.
// -----------------------------------------------------------------------

const { schedule } = require("@netlify/functions");
const { getAlertStore } = require("./_blobs.js");
const { sendEmail } = require("./_resend.js");

function confirmBaseUrl() {
  return process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || null;
}

// Mirrors isRegularMarketHoursNow() in check-alerts-cron.js, but for a
// short pre-market send window instead of the regular session.
function isHotlistSendWindowNow(date = new Date()) {
  if (process.env.FORCE_HOTLIST_SEND === "true") return true;

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

  const windowStart = 8 * 60; // 8:00am ET
  const windowEnd = 8 * 60 + 15; // 8:15am ET
  return minutesSinceMidnight >= windowStart && minutesSinceMidnight < windowEnd;
}

function formatPickText(pick) {
  const gap = pick.gapRisk
    ? "\n⚠️ Gap risk -- if this reports earnings after today's close and you hold through it, a stop-loss will NOT protect you from an overnight gap."
    : "";
  return (
    [
      `${pick.symbol} (${pick.name}) -- ${String(pick.direction || "").toUpperCase()}`,
      pick.catalyst,
      pick.setup,
      `Entry: ${pick.entry}`,
      `Target: ${pick.target}`,
      `Stop: ${pick.stop}`,
    ].join("\n") + gap
  );
}

exports.handler = schedule("*/5 * * * *", async () => {
  if (!isHotlistSendWindowNow()) {
    return { statusCode: 200, body: "outside hot list send window, skipped" };
  }

  const resendKey = process.env.RESEND_API_KEY || null;
  const resendFrom = process.env.RESEND_FROM_EMAIL || "Trading Buddy <onboarding@resend.dev>";
  const baseUrl = confirmBaseUrl();

  if (!resendKey) {
    console.warn("send-hotlist-cron: missing RESEND_API_KEY -- skipping run");
    return { statusCode: 200, body: "missing RESEND_API_KEY, skipped" };
  }
  if (!baseUrl) {
    console.error("send-hotlist-cron: could not determine site base URL -- skipping run");
    return { statusCode: 200, body: "missing base URL, skipped" };
  }

  let store;
  try {
    store = getAlertStore("email-subscribers");
  } catch (e) {
    console.error("send-hotlist-cron: could not open Blobs store", e);
    return { statusCode: 200, body: "blobs store unavailable, skipped" };
  }

  const all = await store.list().catch(() => ({ blobs: [] }));
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Load every record up front so we can bail out before ever fetching the
  // hot list (and before calling Resend) if nobody actually wants it today.
  const candidates = [];
  for (const b of all.blobs || []) {
    const rec = await store.get(b.key, { type: "json" }).catch(() => null);
    if (!rec || !rec.confirmed || !rec.hotListEnabled) continue;
    if (rec.hotListSentOn === today) continue; // already sent today
    candidates.push({ key: b.key, rec });
  }

  if (candidates.length === 0) {
    return { statusCode: 200, body: "no hotlist subscribers pending for today" };
  }

  let list;
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/hotlist`);
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.list) || !data.list.length) {
      console.error("send-hotlist-cron: /api/hotlist returned no usable list", data);
      return { statusCode: 200, body: "no hot list data, skipped" };
    }
    list = data.list;
  } catch (err) {
    console.error("send-hotlist-cron: failed to fetch /api/hotlist", err);
    return {
    return { statusCode: 200, body: "hotlist fetch failed, skipped" };
  }

  const subject = `Trading Buddy Daily Hot List -- ${today}`;
  const body =
    `Today's Hot List (${list.length} pick${list.length === 1 ? "" : "s"}):\n\n` +
    list.map(formatPickText).join("\n\n---\n\n") +
    `\n\nReference levels based on data at generation time -- always confirm the live price on the chart before acting. Signal quality and risk management matter more than any single pick.\n\n— Trading Buddy\n\nTurn these emails off any time from the Trading Buddy app (Daily Hot List section).`;

  let sent = 0;
  for (const { key, rec } of candidates) {
    try {
      await sendEmail({ apiKey: resendKey, from: resendFrom, to: rec.email, subject, text: body });
      rec.hotListSentOn = today;
      await store.setJSON(key, rec);
      sent++;
    } catch (err) {
      console.error(`send-hotlist-cron: email send failed -> ${rec.email}`, err);
    }
  }

  return { statusCode: 200, body: `sent ${sent} hot list emails` };
});

