// netlify/functions/refresh-dividends-cron.js
// -----------------------------------------------------------------------
// Keeps Dividend Corner's numbers current automatically instead of
// going stale between manual research passes. Runs once a day
// (weekdays, after the close) and for every symbol already in the
// roster:
//   1. Pulls the latest close price from Finnhub's quote endpoint.
//   2. Pulls recent + upcoming declared dividends from Finnhub's
//      dividend endpoint, and derives the current monthly amount, the
//      next ex-div date, and the next pay date from it.
//   3. Recomputes the dividend yield from the fresh price + amount.
//   4. Compares the new monthly amount to what was stored yesterday
//      and writes a short auto-generated note if it changed (a cut or
//      an increase) — otherwise leaves the existing hand-written
//      `news` text alone.
//
// What this does NOT touch: `name`, `tv`, `strategyLabel`,
// `strategyNote`, `entry`, `exit`, `held` — those are hand-authored
// opinion/structure and are preserved exactly as stored. This job also
// never adds or removes a SYMBOL from the roster; that's still a
// deliberate edit (see _dividend-seed.js's top comment).
//
// FINNHUB FIELD NAMES — please verify on first deploy: Finnhub's
// dividend-endpoint docs are behind a JS-rendered page I could not pull
// field names from directly, so this reads several plausible names per
// value (see readDividendRecord() below) and logs a warning if none of
// them matched a given record, rather than silently breaking. Check
// this function's logs after the first run; if you see "unrecognized
// dividend record shape" warnings, paste one into a conversation here
// and I'll adjust the field list.
//
// Env vars: reuses FINNHUB_API_KEY, already set for quote.js /
// check-alerts-cron.js / hotlist.mts.
// -----------------------------------------------------------------------

const { schedule } = require("@netlify/functions");
const { getAlertStore } = require("./_blobs.js");
const { DIVIDEND_SEED } = require("./_dividend-seed.js");

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const STORE_NAME = "dividend-data";
const STORE_KEY = "roster";

async function fh(path, params, key) {
  const qs = new URLSearchParams({ ...params, token: key }).toString();
  const res = await fetch(`${FINNHUB_BASE}${path}?${qs}`);
  if (!res.ok) {
    const err = new Error(`Finnhub ${path} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function fmtDate(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Finnhub's documented shape (as of when this was written) is objects
// like { symbol, date, amount, adjustedAmount, payDate, recordDate },
// where `date` is the ex-dividend date — but field names on data APIs
// drift between versions, so this checks a few plausible alternates for
// each value rather than assuming one exact name.
function readDividendRecord(rec) {
  const exDateRaw = rec.exDate || rec.date || rec.exDividendDate || null;
  const payDateRaw = rec.payDate || rec.paymentDate || null;
  const amount = typeof rec.amount === "number" ? rec.amount
    : typeof rec.adjustedAmount === "number" ? rec.adjustedAmount
    : null;
  if (exDateRaw == null || amount == null) return null;
  const exDate = new Date(exDateRaw);
  if (isNaN(exDate.getTime())) return null;
  return {
    exDate,
    payDate: payDateRaw ? new Date(payDateRaw) : null,
    amount,
  };
}

async function fetchLiveDividendData(symbol, key) {
  const today = new Date();
  const from = new Date(today.getTime() - 200 * 24 * 60 * 60 * 1000); // ~6.5 months back
  const to = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000); // ~3 months ahead
  const isoDate = (d) => d.toISOString().slice(0, 10);

  const [quote, rawDividends] = await Promise.all([
    fh("/quote", { symbol }, key),
    fh("/stock/dividend", { symbol, from: isoDate(from), to: isoDate(to) }, key),
  ]);

  const price = typeof quote.c === "number" && quote.c > 0 ? quote.c : null;
  if (price == null) throw new Error(`no usable quote for ${symbol}`);

  const parsed = (Array.isArray(rawDividends) ? rawDividends : [])
    .map(readDividendRecord)
    .filter(Boolean)
    .sort((a, b) => a.exDate - b.exDate);

  if (!parsed.length) {
    console.warn(`refresh-dividends: unrecognized or empty dividend record shape for ${symbol} — keeping previous values`);
    return { price, monthlyDiv: null, exDiv: null, payDate: null };
  }

  // Most recent declared dividend (whether already ex-dated or still
  // upcoming) is treated as "the current monthly amount."
  const mostRecent = parsed[parsed.length - 1];
  // The next one strictly in the future is what the card's "Ex-Div"/"Pays"
  // fields should show; if the most recent one hasn't happened yet, it
  // IS the next one.
  const next = parsed.find((d) => d.exDate.getTime() >= today.getTime()) || mostRecent;

  return {
    price,
    monthlyDiv: mostRecent.amount,
    exDiv: fmtDate(next.exDate),
    payDate: next.payDate ? fmtDate(next.payDate) : null,
  };
}

exports.handler = schedule("30 21 * * 1-5", async () => {
  // 21:30 UTC ≈ 4:30–5:30pm ET depending on daylight saving — after the
  // US market close, weekdays only (no new trading data on weekends).
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) {
    console.error("refresh-dividends: missing FINNHUB_API_KEY — skipping run");
    return { statusCode: 200, body: "missing config, skipped" };
  }

  let store;
  try {
    store = getAlertStore(STORE_NAME);
  } catch (e) {
    console.error("refresh-dividends: could not open Blobs store", e);
    return { statusCode: 200, body: "blobs store unavailable, skipped" };
  }

  const existing = await store.get(STORE_KEY, { type: "json" }).catch(() => null);
  const roster = (existing && Array.isArray(existing.items) && existing.items.length ? existing.items : DIVIDEND_SEED)
    .map((r) => ({ ...r })); // shallow-copy so we don't mutate the seed/previous objects in place

  let updated = 0;
  await Promise.all(
    roster.map(async (record) => {
      try {
        const live = await fetchLiveDividendData(record.symbol, finnhubKey);
        record.price = live.price;
        if (live.monthlyDiv != null) {
          const prevDiv = record.monthlyDiv;
          record.yieldPct = Math.round(((live.monthlyDiv * 12) / live.price) * 10000) / 100;
          if (prevDiv != null && Math.abs(prevDiv - live.monthlyDiv) > 0.0005) {
            const verb = live.monthlyDiv > prevDiv ? "raised" : "cut";
            record.news = `Auto-detected: monthly dividend ${verb} from $${prevDiv.toFixed(4)} to $${live.monthlyDiv.toFixed(4)} (refreshed ${fmtDate(new Date())}).`;
          }
          record.monthlyDiv = live.monthlyDiv;
        }
        if (live.exDiv) record.exDiv = live.exDiv;
        if (live.payDate) record.payDate = live.payDate;
        updated++;
      } catch (err) {
        // Leave this record's previous values untouched rather than
        // blanking out a known-good price/dividend over a transient
        // Finnhub error or rate limit.
        console.error(`refresh-dividends: failed to refresh ${record.symbol}`, err);
      }
    })
  );

  await store.setJSON(STORE_KEY, { refreshedAt: new Date().toISOString(), items: roster });

  return { statusCode: 200, body: `refreshed ${updated}/${roster.length} dividend records` };
});
