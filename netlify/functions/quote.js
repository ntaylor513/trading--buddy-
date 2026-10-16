// netlify/functions/quote.js
// -----------------------------------------------------------------------
// Proxies real-time quotes from Finnhub's free tier so the API key never
// reaches the browser, and so the front end can call a same-origin path
// (/api/quote) with no CORS concerns.
//
// Setup (one-time, ~2 minutes):
//   1. Free account at https://finnhub.io/register — the free tier is
//      enough for this (60 calls/min, real-time US equity quotes).
//   2. Copy your API key from the Finnhub dashboard.
//   3. In the Netlify UI: Project configuration -> Environment variables
//      -> add FINNHUB_API_KEY = <your key> -> redeploy (or trigger a new
//      deploy so the function picks it up).
//
// Request:  GET /api/quote?symbols=AAPL,MSFT,TSLA
// Response: { "AAPL": { "price": 231.42 }, "MSFT": { "price": 418.11 }, ... }
// A symbol Finnhub can't price (bad ticker, rate-limited, etc.) is simply
// left out of the response rather than failing the whole request — the
// front end treats a missing symbol as "no price available yet" and skips
// it for that poll rather than erroring out.
// -----------------------------------------------------------------------

const FINNHUB_BASE = "https://finnhub.io/api/v1/quote";

exports.handler = async (event) => {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "FINNHUB_API_KEY is not set in this site's environment variables" }),
    };
  }

  const symbolsParam = (event.queryStringParameters && event.queryStringParameters.symbols) || "";
  const symbols = symbolsParam
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 25); // sane upper bound per request

  if (symbols.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "pass ?symbols=AAPL,MSFT,..." }) };
  }

  const results = {};
  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const res = await fetch(`${FINNHUB_BASE}?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`);
        if (!res.ok) return; // leave this symbol out of results
        const data = await res.json();
        // Finnhub returns c:0 for an unknown/unpriced symbol — skip those too.
        if (typeof data.c === "number" && data.c > 0) {
          results[symbol] = { price: data.c, high: data.h, low: data.l, prevClose: data.pc };
        }
      } catch (err) {
        // one bad symbol should never fail the whole batch
        console.error(`quote fetch failed for ${symbol}`, err);
      }
    })
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(results),
  };
};
