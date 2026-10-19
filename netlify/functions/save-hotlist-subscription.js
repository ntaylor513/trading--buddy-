From e8d44a4943e50ffb3f3e2f8d6aabb99fc55f11f1 Mon Sep 17 00:00:00 2001
From: Claude <noreply@anthropic.com>
Date: Mon, 19 Oct 2026 17:11:00 +0000
Subject: [PATCH] Add per-user toggle for Daily Hot List email alerts

Lets any visitor turn the Daily Hot List email digest on/off for their
own address, the same way Neal already gets alerts -- not just
per-ticker breakout alerts.

- New netlify/functions/save-hotlist-subscription.js: POST
  { email, enabled } to turn the digest on or off. Shares the existing
  email-subscribers Blobs record and confirmation flow from
  save-email-alert.js (same confirm-email-alert.js link works for
  both), so an address only has to be confirmed once.
- New netlify/functions/send-hotlist-cron.js: scheduled function that
  emails that day's /api/hotlist picks to every confirmed, opted-in
  address once per trading morning (8:00-8:15am ET window, DST-safe,
  per-address daily-sent guard so the 5-minute cron can't double-send).
- index.html: new "Turn On/Off Daily Hot List Emails" button + email
  input in the Daily Hot List section, mirroring the existing email
  alerts UI/JS pattern (localStorage-remembered state, same status
  styling).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AwiMYrwaN6ZeHiAj1M3cVN
---
 index.html                                    | 101 +++++++++++
 .../functions/save-hotlist-subscription.js    | 152 +++++++++++++++++
 netlify/functions/send-hotlist-cron.js        | 159 ++++++++++++++++++
 3 files changed, 412 insertions(+)
 create mode 100644 netlify/functions/save-hotlist-subscription.js
 create mode 100644 netlify/functions/send-hotlist-cron.js

diff --git a/index.html b/index.html
index 8aa52cc..92db7b6 100644
--- a/index.html
+++ b/index.html
@@ -319,6 +319,12 @@ footer{text-align:center;padding:20px;color:var(--muted);font-size:11px;line-hei
   <div id="hotlistKeyBox"></div>
   <div class="hotlist-grid" id="hotlistGrid"></div>
   <div class="section-note">This list is pulled <b>live</b> from a real-time market-data feed and auto-refreshes every 5 minutes while this page stays open — ranked by which watched stocks are moving the most right now, with real earnings-calendar data folded in as a bonus signal. If the live feed is ever unavailable, it falls back to the last hand-researched list below with a note saying so. Entry/target/stop are reference levels based on the data at the moment shown — always confirm the live price on the chart before acting, and treat anything reporting earnings as gap risk: a stop-loss order does not protect you from a price gapping past it overnight.</div>
+  <div class="email-alerts-row" id="hotlistEmailRow">
+    <input type="email" id="hotlistEmailInput" placeholder="you@example.com — get the Daily Hot List by email" autocomplete="email">
+    <button type="button" id="hotlistEmailBtn" onclick="toggleHotlistEmail()">✉️ Turn On Daily Hot List Emails</button>
+    <div class="email-alert-status" id="hotlistEmailStatus"></div>
+  </div>
+  <div class="section-note">One email, every trading morning before the open, with that day's Hot List picks and the same entry/target/stop levels shown above. Turn it on or off any time with the button above — first time around you'll get a confirmation link to click so nobody can sign up an address that isn't theirs.</div>
 
   <div class="section-label">Price Alerts — Flash, Sound &amp; Notification on a Breakout</div>
   <div class="alerts-card">
@@ -1655,6 +1661,100 @@ function initEmailAlertState(){
   syncEmailAlerts();
 }
 
+// ---------------------------------------------------------------------
+// Daily Hot List email digest — a separate on/off toggle from the
+// breakout email alerts above, sharing the same server-side record (and
+// the same confirmation link) via save-hotlist-subscription.js, so one
+// confirmed address covers both. Mirrors the email-alert pattern above:
+// state remembered in localStorage so the button/status show correctly
+// next time this page loads.
+// ---------------------------------------------------------------------
+const HOTLIST_EMAIL_STORAGE_KEY = 'tb_hotlist_email';
+
+function setHotlistEmailStatus(text, kind){
+  const el = document.getElementById('hotlistEmailStatus');
+  if(!el) return;
+  el.textContent = text;
+  el.className = 'email-alert-status' + (kind ? ' ' + kind : '');
+}
+
+function loadSavedHotlistEmail(){
+  try{ return JSON.parse(localStorage.getItem(HOTLIST_EMAIL_STORAGE_KEY) || 'null'); }
+  catch(e){ return null; }
+}
+function rememberHotlistEmail(email, enabled, confirmed){
+  try{ localStorage.setItem(HOTLIST_EMAIL_STORAGE_KEY, JSON.stringify({ email, enabled, confirmed })); }
+  catch(e){ /* ignore -- private browsing etc, just won't persist across reloads */ }
+}
+
+function updateHotlistEmailButton(){
+  const btn = document.getElementById('hotlistEmailBtn');
+  if(!btn) return;
+  const saved = loadSavedHotlistEmail();
+  btn.textContent = (saved && saved.enabled) ? '🔕 Turn Off Daily Hot List Emails' : '✉️ Turn On Daily Hot List Emails';
+}
+
+async function toggleHotlistEmail(){
+  const input = document.getElementById('hotlistEmailInput');
+  const btn = document.getElementById('hotlistEmailBtn');
+  const saved = loadSavedHotlistEmail();
+  const turningOn = !(saved && saved.enabled);
+  const email = (input.value || (saved && saved.email) || '').trim();
+  if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
+    setHotlistEmailStatus('Enter a valid email address first.', 'err');
+    return;
+  }
+  btn.disabled = true;
+  setHotlistEmailStatus(turningOn ? 'Turning on...' : 'Turning off...', 'pending');
+  try{
+    const res = await fetch('/api/save-hotlist-subscription', {
+      method: 'POST',
+      headers: { 'Content-Type': 'application/json' },
+      body: JSON.stringify({ email, enabled: turningOn }),
+    });
+    const data = await res.json().catch(()=>({}));
+    if(!res.ok){
+      setHotlistEmailStatus((data && data.message) ? data.message : 'Could not save -- try again in a moment.', 'err');
+      return;
+    }
+    if(!turningOn){
+      rememberHotlistEmail(email, false, !!data.confirmed);
+      setHotlistEmailStatus(`Daily Hot List emails off for ${email}.`, 'ok');
+    } else if(data.confirmed){
+      rememberHotlistEmail(email, true, true);
+      setHotlistEmailStatus(`Daily Hot List emails on for ${email}.`, 'ok');
+    } else if(data.confirmationSent){
+      rememberHotlistEmail(email, true, false);
+      setHotlistEmailStatus(`Check ${email} for a confirmation link -- the daily email starts once you click it.`, 'pending');
+    } else {
+      rememberHotlistEmail(email, true, false);
+      setHotlistEmailStatus('Saved, but the confirmation email could not be sent' + (data.confirmationError ? ': ' + data.confirmationError : '.') + ' Try again shortly.', 'err');
+    }
+    updateHotlistEmailButton();
+  }catch(e){
+    console.warn('[hotlist email] save failed', e);
+    setHotlistEmailStatus('Could not reach the server -- try again in a moment.', 'err');
+  }finally{
+    btn.disabled = false;
+  }
+}
+
+// Restores the saved email address + on/off state into the box when the
+// page loads (no server round-trip needed just to show prior state).
+function initHotlistEmailState(){
+  const saved = loadSavedHotlistEmail();
+  if(!saved || !saved.email) return;
+  const input = document.getElementById('hotlistEmailInput');
+  if(input) input.value = saved.email;
+  updateHotlistEmailButton();
+  if(saved.enabled){
+    setHotlistEmailStatus(
+      saved.confirmed ? `Daily Hot List emails on for ${saved.email}.` : `${saved.email} saved -- check your inbox to confirm.`,
+      saved.confirmed ? 'ok' : 'pending'
+    );
+  }
+}
+
 async function togglePhoneAlerts(){
   const btn = document.getElementById('pushBtn');
   const label = document.getElementById('pushBtnLabel');
@@ -1788,6 +1888,7 @@ function init(){
   renderManualAlerts();
   initPushButtonState();
   initEmailAlertState();
+  initHotlistEmailState();
   document.addEventListener('click', unlockAlertAudioOnce);
   document.addEventListener('keydown', unlockAlertAudioOnce);
   document.addEventListener('touchstart', unlockAlertAudioOnce);
diff --git a/netlify/functions/save-hotlist-subscription.js b/netlify/functions/save-hotlist-subscription.js
new file mode 100644
index 0000000..1d62737
--- /dev/null
+++ b/netlify/functions/save-hotlist-subscription.js
@@ -0,0 +1,152 @@
+// netlify/functions/save-hotlist-subscription.js
+// -----------------------------------------------------------------------
+// Lets a user turn the Daily Hot List email digest on or off for their own
+// address, independent of the per-ticker breakout alerts handled by
+// save-email-alert.js. Shares the same Netlify Blobs record (same store,
+// same key-by-email, same confirmation flow) so one confirmed address
+// covers both breakout alerts and the Hot List digest -- nobody has to
+// confirm their inbox twice, and confirm-email-alert.js needs no changes
+// to also confirm a hotlist-only signup.
+//
+// Request:  POST /api/save-hotlist-subscription
+//           { "email": "you@example.com", "enabled": true }
+// Response: { "ok": true, "enabled": true, "confirmed": false,
+//              "confirmationSent": true }
+//           confirmed:false + confirmationSent:true means a confirmation
+//           email was just sent -- the digest won't go out until that
+//           link is clicked (send-hotlist-cron.js only emails confirmed
+//           addresses that also have hotListEnabled true).
+//
+// Turning OFF (enabled:false) never deletes the record outright -- it
+// just clears hotListEnabled, so any separately-configured breakout
+// alerts on the same address keep working, and flipping it back on later
+// doesn't need to re-confirm an already-confirmed address.
+// -----------------------------------------------------------------------
+
+const crypto = require("crypto");
+const { getAlertStore } = require("./_blobs.js");
+const { sendEmail } = require("./_resend.js");
+
+const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
+const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
+
+function keyFor(email) {
+  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
+}
+
+function confirmBaseUrl() {
+  return process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || null;
+}
+
+exports.handler = async (event) => {
+  if (event.httpMethod !== "POST") {
+    return { statusCode: 405, body: JSON.stringify({ error: "POST only" }) };
+  }
+
+  let payload;
+  try {
+    payload = JSON.parse(event.body || "{}");
+  } catch (e) {
+    return { statusCode: 400, body: JSON.stringify({ error: "invalid JSON body" }) };
+  }
+
+  const email = typeof payload.email === "string" ? payload.email.trim() : "";
+  if (!email || !EMAIL_RE.test(email)) {
+    return { statusCode: 400, body: JSON.stringify({ error: "a valid email address is required" }) };
+  }
+  const enabled = payload.enabled !== false; // default true unless explicitly false
+
+  let store;
+  try {
+    store = getAlertStore("email-subscribers");
+  } catch (e) {
+    console.error("save-hotlist-subscription: could not open Blobs store", e);
+    return { statusCode: 500, body: JSON.stringify({ error: "storage-unavailable", message: String(e.message || e) }) };
+  }
+  const key = keyFor(email);
+
+  const existing = await store.get(key, { type: "json" }).catch(() => null);
+  const alreadyConfirmed = Boolean(existing && existing.confirmed);
+
+  const record = existing
+    ? { ...existing }
+    : { email, alerts: [], confirmed: false };
+  record.email = email;
+  record.hotListEnabled = enabled;
+  record.updatedAt = new Date().toISOString();
+
+  // Turning it off never needs a confirmation round-trip -- just flip the
+  // flag and stop. (If the address was never confirmed, nothing was going
+  // to send to it anyway.)
+  if (!enabled) {
+    await store.setJSON(key, record);
+    return {
+      statusCode: 200,
+      headers: { "Content-Type": "application/json" },
+      body: JSON.stringify({ ok: true, enabled: false, confirmed: alreadyConfirmed }),
+    };
+  }
+
+  let confirmationSent = false;
+  let confirmationError = null;
+
+  if (!alreadyConfirmed) {
+    const resendKey = process.env.RESEND_API_KEY || null;
+    const resendFrom = process.env.RESEND_FROM_EMAIL || "Trading Buddy <onboarding@resend.dev>";
+    const baseUrl = confirmBaseUrl();
+
+    if (!resendKey) {
+      // Don't silently store an address that can never actually receive it.
+      return {
+        statusCode: 500,
+        body: JSON.stringify({
+          error: "email-not-configured",
+          message: "Email alerts aren't set up yet (missing RESEND_API_KEY) -- confirmation email can't be sent.",
+        }),
+      };
+    }
+    if (!baseUrl) {
+      return {
+        statusCode: 500,
+        body: JSON.stringify({
+          error: "missing-base-url",
+          message: "Could not determine this site's URL to build a confirmation link.",
+        }),
+      };
+    }
+
+    const token = crypto.randomBytes(24).toString("hex");
+    record.confirmToken = token;
+    record.confirmTokenExpires = Date.now() + CONFIRM_TOKEN_TTL_MS;
+
+    const confirmUrl = `${baseUrl.replace(/\/+$/, "")}/api/confirm-email-alert?email=${encodeURIComponent(email)}&token=${token}`;
+
+    try {
+      await sendEmail({
+        apiKey: resendKey,
+        from: resendFrom,
+        to: email,
+        subject: "Confirm your Trading Buddy email alerts",
+        text: `Someone (hopefully you) turned on the Trading Buddy Daily Hot List email for this address.\n\nClick to confirm and start receiving it each trading morning:\n${confirmUrl}\n\nThis link expires in 24 hours. If you didn't request this, you can ignore this email -- nothing will be sent until it's confirmed.\n\n— Trading Buddy`,
+      });
+      confirmationSent = true;
+    } catch (err) {
+      console.error("save-hotlist-subscription: failed to send confirmation email", err);
+      confirmationError = String(err.message || err);
+    }
+  }
+
+  await store.setJSON(key, record);
+
+  return {
+    statusCode: 200,
+    headers: { "Content-Type": "application/json" },
+    body: JSON.stringify({
+      ok: true,
+      enabled: true,
+      confirmed: record.confirmed,
+      confirmationSent,
+      ...(confirmationError ? { confirmationError } : {}),
+    }),
+  };
+};
diff --git a/netlify/functions/send-hotlist-cron.js b/netlify/functions/send-hotlist-cron.js
new file mode 100644
index 0000000..21b27ee
--- /dev/null
+++ b/netlify/functions/send-hotlist-cron.js
@@ -0,0 +1,159 @@
+// netlify/functions/send-hotlist-cron.js
+// -----------------------------------------------------------------------
+// Emails the Daily Hot List to every address that has confirmed its email
+// (see save-email-alert.js / save-hotlist-subscription.js) AND has turned
+// the digest on via save-hotlist-subscription.js -- once per trading day,
+// before the open.
+//
+// Pulls the day's picks from this site's own /api/hotlist endpoint (the
+// same live-mover ranker the page itself calls) instead of duplicating
+// that ranking logic here, so the emailed list always matches what the
+// app shows.
+//
+// TIMING: runs every 5 minutes, every day (same pattern as
+// check-alerts-cron.js), and only actually does anything inside an
+// 8:00-8:15am America/New_York window, Monday-Friday -- computed from
+// wall-clock time via Intl, not a fixed UTC cron offset, so it doesn't
+// drift an hour when the US switches between EST/EDT. A per-address
+// `hotListSentOn` date guard (reset automatically each calendar day, same
+// idea as `firedOn` in check-alerts-cron.js) keeps the 3 runs inside that
+// window from sending the same person 3 emails.
+// Set FORCE_HOTLIST_SEND=true in env vars to bypass the time window for
+// testing.
+//
+// Doesn't know about market holidays (same limitation as
+// check-alerts-cron.js) -- those still fire a send.
+//
+// Needs RESEND_API_KEY / RESEND_FROM_EMAIL (see check-alerts-cron.js's
+// comments) -- if missing, the run is skipped (logged) rather than
+// failing loudly with nothing to send.
+// -----------------------------------------------------------------------
+
+const { schedule } = require("@netlify/functions");
+const { getAlertStore } = require("./_blobs.js");
+const { sendEmail } = require("./_resend.js");
+
+function confirmBaseUrl() {
+  return process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || null;
+}
+
+// Mirrors isRegularMarketHoursNow() in check-alerts-cron.js, but for a
+// short pre-market send window instead of the regular session.
+function isHotlistSendWindowNow(date = new Date()) {
+  if (process.env.FORCE_HOTLIST_SEND === "true") return true;
+
+  const parts = new Intl.DateTimeFormat("en-US", {
+    timeZone: "America/New_York",
+    weekday: "short",
+    hour: "numeric",
+    minute: "numeric",
+    hourCycle: "h23",
+  }).formatToParts(date);
+
+  const map = {};
+  for (const p of parts) map[p.type] = p.value;
+
+  if (map.weekday === "Sat" || map.weekday === "Sun") return false;
+
+  const hour = Number(map.hour) % 24; // h23 can report "24" at midnight
+  const minute = Number(map.minute);
+  const minutesSinceMidnight = hour * 60 + minute;
+
+  const windowStart = 8 * 60; // 8:00am ET
+  const windowEnd = 8 * 60 + 15; // 8:15am ET
+  return minutesSinceMidnight >= windowStart && minutesSinceMidnight < windowEnd;
+}
+
+function formatPickText(pick) {
+  const gap = pick.gapRisk
+    ? "\n⚠️ Gap risk -- if this reports earnings after today's close and you hold through it, a stop-loss will NOT protect you from an overnight gap."
+    : "";
+  return (
+    [
+      `${pick.symbol} (${pick.name}) -- ${String(pick.direction || "").toUpperCase()}`,
+      pick.catalyst,
+      pick.setup,
+      `Entry: ${pick.entry}`,
+      `Target: ${pick.target}`,
+      `Stop: ${pick.stop}`,
+    ].join("\n") + gap
+  );
+}
+
+exports.handler = schedule("*/5 * * * *", async () => {
+  if (!isHotlistSendWindowNow()) {
+    return { statusCode: 200, body: "outside hot list send window, skipped" };
+  }
+
+  const resendKey = process.env.RESEND_API_KEY || null;
+  const resendFrom = process.env.RESEND_FROM_EMAIL || "Trading Buddy <onboarding@resend.dev>";
+  const baseUrl = confirmBaseUrl();
+
+  if (!resendKey) {
+    console.warn("send-hotlist-cron: missing RESEND_API_KEY -- skipping run");
+    return { statusCode: 200, body: "missing RESEND_API_KEY, skipped" };
+  }
+  if (!baseUrl) {
+    console.error("send-hotlist-cron: could not determine site base URL -- skipping run");
+    return { statusCode: 200, body: "missing base URL, skipped" };
+  }
+
+  let store;
+  try {
+    store = getAlertStore("email-subscribers");
+  } catch (e) {
+    console.error("send-hotlist-cron: could not open Blobs store", e);
+    return { statusCode: 200, body: "blobs store unavailable, skipped" };
+  }
+
+  const all = await store.list().catch(() => ({ blobs: [] }));
+  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
+
+  // Load every record up front so we can bail out before ever fetching the
+  // hot list (and before calling Resend) if nobody actually wants it today.
+  const candidates = [];
+  for (const b of all.blobs || []) {
+    const rec = await store.get(b.key, { type: "json" }).catch(() => null);
+    if (!rec || !rec.confirmed || !rec.hotListEnabled) continue;
+    if (rec.hotListSentOn === today) continue; // already sent today
+    candidates.push({ key: b.key, rec });
+  }
+
+  if (candidates.length === 0) {
+    return { statusCode: 200, body: "no hotlist subscribers pending for today" };
+  }
+
+  let list;
+  try {
+    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/hotlist`);
+    const data = await res.json();
+    if (!res.ok || !Array.isArray(data.list) || !data.list.length) {
+      console.error("send-hotlist-cron: /api/hotlist returned no usable list", data);
+      return { statusCode: 200, body: "no hot list data, skipped" };
+    }
+    list = data.list;
+  } catch (err) {
+    console.error("send-hotlist-cron: failed to fetch /api/hotlist", err);
+    return { statusCode: 200, body: "hotlist fetch failed, skipped" };
+  }
+
+  const subject = `Trading Buddy Daily Hot List -- ${today}`;
+  const body =
+    `Today's Hot List (${list.length} pick${list.length === 1 ? "" : "s"}):\n\n` +
+    list.map(formatPickText).join("\n\n---\n\n") +
+    `\n\nReference levels based on data at generation time -- always confirm the live price on the chart before acting. Signal quality and risk management matter more than any single pick.\n\n— Trading Buddy\n\nTurn these emails off any time from the Trading Buddy app (Daily Hot List section).`;
+
+  let sent = 0;
+  for (const { key, rec } of candidates) {
+    try {
+      await sendEmail({ apiKey: resendKey, from: resendFrom, to: rec.email, subject, text: body });
+      rec.hotListSentOn = today;
+      await store.setJSON(key, rec);
+      sent++;
+    } catch (err) {
+      console.error(`send-hotlist-cron: email send failed -> ${rec.email}`, err);
+    }
+  }
+
+  return { statusCode: 200, body: `sent ${sent} hot list emails` };
+});
-- 
2.43.0
