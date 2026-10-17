// netlify/functions/dividends.js
// -----------------------------------------------------------------------
// Read-only endpoint the frontend calls for Dividend Corner's data.
// Just reads whatever refresh-dividends-cron.js last wrote to Blobs —
// no live Finnhub calls happen on this path, so it's fast regardless of
// how many people load the page. Falls back to the static seed list
// (see _dividend-seed.js) if the cron hasn't run yet (fresh deploy) or
// the Blobs store can't be reached, and says so via `live:false` so the
// frontend can show that it's not the auto-refreshed data.
//
// Request:  GET /api/dividends
// Response: { live: boolean, refreshedAt: string|null, items: [...] }
// -----------------------------------------------------------------------

const { getAlertStore } = require("./_blobs.js");
const { DIVIDEND_SEED } = require("./_dividend-seed.js");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "GET only" }) };
  }

  let store;
  try {
    store = getAlertStore("dividend-data");
  } catch (e) {
    console.error("dividends: could not open Blobs store", e);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ live: false, refreshedAt: null, items: DIVIDEND_SEED }),
    };
  }

  const stored = await store.get("roster", { type: "json" }).catch(() => null);

  if (!stored || !Array.isArray(stored.items) || !stored.items.length) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ live: false, refreshedAt: null, items: DIVIDEND_SEED }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
    body: JSON.stringify({ live: true, refreshedAt: stored.refreshedAt, items: stored.items }),
  };
};
