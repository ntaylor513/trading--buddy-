// netlify/functions/confirm-email-alert.js
// -----------------------------------------------------------------------
// Confirms an email address that was registered via save-email-alert.js.
//
// WHY THIS EXISTS: without it, anyone who knows (or guesses) an email
// address could POST it to save-email-alert.js with a trigger price
// likely to hit soon, and the cron job would happily send that address
// unsolicited "breakout" emails — an open spam relay. Now, a freshly
// saved email is stored as unconfirmed and check-alerts-cron.js skips
// unconfirmed records entirely. save-email-alert.js emails a one-time
// link to this function; only clicking it (i.e. proving you actually
// own that inbox) flips the record to confirmed.
//
// Request: GET /api/confirm-email-alert?email=...&token=...
//          (this is the link emailed by save-email-alert.js — the user
//          just clicks it, nothing to build on the frontend)
// Response: a small HTML page saying what happened, since a human is
//           clicking this from their email client, not a fetch() call.
// -----------------------------------------------------------------------

const crypto = require("crypto");
const { getAlertStore } = require("./_blobs.js");

function keyFor(email) {
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function htmlResponse(statusCode, message) {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!doctype html><html><head><meta charset="utf-8"><title>Trading Buddy</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;text-align:center;color:#1a1a1a}</style>
</head><body><h2>Trading Buddy</h2><p>${escapeHtml(message)}</p></body></html>`,
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const email = typeof params.email === "string" ? params.email.trim() : "";
  const token = typeof params.token === "string" ? params.token : "";

  if (!email || !token) {
    return htmlResponse(400, "This confirmation link is missing information. Please set up your email alert again from Trading Buddy.");
  }

  let store;
  try {
    store = getAlertStore("email-subscribers");
  } catch (e) {
    console.error("confirm-email-alert: could not open Blobs store", e);
    return htmlResponse(500, "Something went wrong on our end. Please try again in a moment.");
  }

  const key = keyFor(email);
  const rec = await store.get(key, { type: "json" });

  if (!rec) {
    return htmlResponse(404, "We couldn't find a pending alert request for this address. It may have expired — please set it up again.");
  }

  if (rec.confirmed) {
    return htmlResponse(200, `${email} is already confirmed for Trading Buddy email alerts.`);
  }

  if (!rec.confirmToken || rec.confirmToken !== token) {
    return htmlResponse(400, "This confirmation link is invalid. Please set up your email alert again to get a fresh one.");
  }

  if (rec.confirmTokenExpires && Date.now() > rec.confirmTokenExpires) {
    return htmlResponse(400, "This confirmation link has expired (links are valid for 24 hours). Please set up your email alert again.");
  }

  rec.confirmed = true;
  delete rec.confirmToken;
  delete rec.confirmTokenExpires;
  await store.setJSON(key, rec);

  return htmlResponse(200, `${email} is confirmed! You'll now receive Trading Buddy email alerts when your watched price levels are hit.`);
};
