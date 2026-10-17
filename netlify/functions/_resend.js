// netlify/functions/_resend.js
// -----------------------------------------------------------------------
// Tiny shared helper for sending a single email via Resend (resend.com).
// Used by both check-alerts-cron.js (breakout alert emails) and
// save-email-alert.js (the "please confirm your address" email) so the
// two don't drift out of sync.
//
// Needs RESEND_API_KEY in Netlify env vars; throws if the API call fails
// so the caller can decide how to handle/log that.
// -----------------------------------------------------------------------

const RESEND_API = "https://api.resend.com/emails";

async function sendEmail({ apiKey, from, to, subject, text }) {
  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${detail}`);
  }
}

module.exports = { sendEmail };
