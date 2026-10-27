// netlify/functions/dividends-history.js
// -----------------------------------------------------------------------
// Read-only endpoint the Position Tracker calls to figure out how much
// dividend income a position has earned while held — ANY ticker, not
// just the curated Dividend Corner roster (that's dividends.js, a
// different file). This hits Finnhub's dividend endpoint live, the same
// way refresh-dividends-cron.js does for the roster, and just returns the
// raw declared dividends in a date range — the front end does the
// shares-held multiplication and summing.
//
// Request:  GET /api/dividends-history?symbol=O&from=2026-01-01&to=2026-10-27
// Response: { symbol, items: [ { exDate: "2026-03-14", payDate: "2026-03-28"|null, amount: 0.2715 }, ... ] }
// A symbol with no declared dividends in range (most stocks, most of the
// time) just comes back with items: [] — not an error, the front end
// treats that as "$0 dividend income for this holding period."
//
// Env vars: reuses FINNHUB_API_KEY, already set for quote.js /
// check-alerts-cron.js / refresh-dividends-cron.js.
// -----------------------------------------------------------------------

const FINNHUB_BASE = "https://finnhub.io/api/v1";

// Same tolerant field-name reading as refresh-dividends-cron.js, since
// Finnhub's exact field names weren't confirmable from docs when that
// file was written — keep both in sync if you ever learn the real shape.
function readDividendRecord(rec) {
  const exDateRaw = rec.exDate || rec.date || rec.exDividendDate || null;
  const payDateRaw = rec.payDate || rec.paymentDate || null;
  const amount =
    typeof rec.amount === "number" ? rec.amount : typeof rec.adjustedAmount === "number" ? rec.adjustedAmount : null;
  if (exDateRaw == null || amount == null) return null;
  const exDate = new Date(exDateRaw);
  if (isNaN(exDate.getTime())) return null;
  return {
    exDate: exDate.toISOString().slice(0, 10),
    payDate: payDateRaw ? new Date(payDateRaw).toISOString().slice(0, 10) : null,
    amount,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "GET only" }) };
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "FINNHUB_API_KEY is not set in this site's environment variables" }),
    };
  }

  const qs = event.queryStringParameters || {};
  const symbol = (qs.symbol || "").trim().toUpperCase();
  const from = (qs.from || "").trim();
  const to = (qs.to || "").trim();
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;

  if (!symbol) {
    return { statusCode: 400, body: JSON.stringify({ error: "pass ?symbol=TICKER" }) };
  }
  if (!dateRe.test(from) || !dateRe.test(to)) {
    return { statusCode: 400, body: JSON.stringify({ error: "pass ?from=YYYY-MM-DD&to=YYYY-MM-DD" }) };
  }

  try {
    const url = `${FINNHUB_BASE}/stock/dividend?${new URLSearchParams({ symbol, from, to, token: apiKey })}`;
    const res = await fetch(url);
    if (!res.ok) {
      // Finnhub free-tier accounts can get a 403 on this endpoint depending
      // on plan — treat as "no data available" rather than a hard failure,
      // same philosophy as quote.js: one bad lookup shouldn't be an error
      // the whole feature can't recover from.
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({ symbol, items: [], note: `Finnhub returned ${res.status} — no dividend data available` }),
      };
    }
    const raw = await res.json();
    const items = (Array.isArray(raw) ? raw : [])
      .map(readDividendRecord)
      .filter(Boolean)
      .sort((a, b) => (a.exDate < b.exDate ? -1 : 1));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ symbol, items }),
    };
  } catch (err) {
    console.error(`dividends-history: fetch failed for ${symbol}`, err);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ symbol, items: [], note: "lookup failed — treated as no data" }),
    };
  }
};
