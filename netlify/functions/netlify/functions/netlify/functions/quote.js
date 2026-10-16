// netlify/functions/quote.js
// Proxies real-time quotes from Finnhub's free tier so the API key never
// reaches the browser, and the front end can call a same-origin path
// (/api/quote) with no CORS concerns.
//
// Request:  GET /api/quote?symbols=AAPL,MSFT,TSLA
// Response: { "AAPL": { "price": 231.42 }, "MSFT": { "price": 418.11 }, ... }

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
    .slice(0, 25);

  if (symbols.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "pass ?symbols=AAPL,MSFT,..." }) };
  }

  const results = {};
  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const res = await fetch(`${FINNHUB_BASE}?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`);
        if (!res.ok) return;
        const data = await res.json();
        if (typeof data.c === "number" && data.c > 0) {
          results[symbol] = { price: data.c, high: data.h, low: data.l, prevClose: data.pc };
        }
      } catch (err) {
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
