// netlify/functions/_dividend-seed.js
// -----------------------------------------------------------------------
// Starting roster for Dividend Corner, used two ways:
//   1. By refresh-dividends-cron.js, ONLY the very first time it ever
//      runs (i.e. the Blobs store is empty) — after that, the stored
//      roster is the source of truth and this file is never consulted
//      again for symbols already in it.
//   2. By dividends.js as the fallback response if the cron hasn't run
//      yet at all (fresh deploy) or the Blobs store is unreachable.
//
// Each record splits into two kinds of fields:
//   STATIC  (name, tv, strategyLabel, strategyNote, entry, exit, held) —
//     hand-authored opinion/structure. The cron job never touches these
//     once a record exists in the store; they only change when a human
//     (or Claude, on request) edits them directly in Blobs.
//   LIVE    (price, monthlyDiv, yieldPct, exDiv, payDate, news) —
//     refreshed automatically every run from Finnhub's quote + dividend
//     endpoints. The values below are just the seed/fallback snapshot.
//
// MAINTENANCE POLICY (same as before): held:true on any record means it
// is NEVER removed from the roster by a swap, only supplemented by
// adding alongside it. Adding or removing a SYMBOL from the roster is
// still a deliberate edit (to the live Blobs roster, or to this seed
// file before the first run) — the cron job only refreshes numbers for
// symbols already present, it never decides to add or drop one itself.
// -----------------------------------------------------------------------

const DIVIDEND_SEED = [
  {
    symbol: "AGNC", name: "AGNC Investment Corp.", tv: "NASDAQ:AGNC", held: false,
    price: 8.72, monthlyDiv: 0.12, yieldPct: 16.51,
    exDiv: "Oct 30, 2026", payDate: "Nov 10, 2026",
    news: "Declared its $0.12/share monthly dividend again — unchanged since late 2021.",
    strategyLabel: "Wheel",
    strategyNote: "Cheap per-share price makes 100-share lots affordable — classic wheel candidate. A mortgage REIT, so it moves with interest-rate expectations more than company news.",
    entry: "Sell an $8.50 cash-secured put, ~30–45 days out", exit: "If assigned at $8.50, sell a $9 covered call the next cycle",
  },
  {
    symbol: "O", name: "Realty Income", tv: "NYSE:O", held: false,
    price: 56.08, monthlyDiv: 0.2715, yieldPct: 5.81,
    exDiv: "Oct 30, 2026", payDate: "Nov 13, 2026",
    news: "Declared its regular monthly dividend — now on 22 straight years of dividend growth (\"The Monthly Dividend Company\").",
    strategyLabel: "Wheel",
    strategyNote: "Lower yield but very high dividend-growth quality — a steadier, lower-drama name to run the wheel on for extra income on top of the payout.",
    entry: "Sell a $55 cash-secured put, ~30–45 days out", exit: "If assigned at $55, sell a $58 covered call the next cycle",
  },
  {
    symbol: "MAIN", name: "Main Street Capital", tv: "NYSE:MAIN", held: false,
    price: 53.83, monthlyDiv: 0.265, yieldPct: 8.14,
    exDiv: "Nov 6, 2026", payDate: "Nov 13, 2026",
    news: "Raised its regular monthly dividend to $0.265/share (from $0.260) starting July 2026, and continues paying a supplemental dividend quarterly ($0.30/share most recently in Sept 2026) on top of the regular monthly payout.",
    strategyLabel: "Covered Call",
    strategyNote: "Trades in a fairly tight range for a BDC — better suited to owning shares outright and selling calls above resistance than an aggressive wheel.",
    entry: "Buy shares near $53–54", exit: "Sell a $56 covered call, ~30–45 days out",
  },
  {
    symbol: "LTC", name: "LTC Properties", tv: "NYSE:LTC", held: false,
    price: 43.68, monthlyDiv: 0.19, yieldPct: 5.22,
    exDiv: "Oct 22, 2026", payDate: "Oct 30, 2026",
    news: "Healthcare REIT (senior housing + skilled nursing operators) that has paid an unchanged $0.19/share monthly dividend since early 2022, with a reasonable ~83% payout ratio for a REIT. Added in place of STAG Industrial, which shifted from monthly to quarterly dividends in January 2026.",
    strategyLabel: "Wheel",
    strategyNote: "Steadier, lower-drama income name — the tradeoff for its long run of unchanged monthly payments is a middling (not high) yield. Check the options chain's open interest before sizing up, as REIT options can be thinner than large-cap names.",
    entry: "Sell a $42 cash-secured put, ~30–45 days out", exit: "If assigned at $42, sell a $46 covered call the next cycle",
  },
  {
    symbol: "GLAD", name: "Gladstone Capital", tv: "NASDAQ:GLAD", held: false,
    price: 18.88, monthlyDiv: 0.15, yieldPct: 9.53,
    exDiv: "Oct 23, 2026", payDate: "Oct 30, 2026",
    news: "Regular monthly rate has held at $0.15/share since an October 2025 reduction (down from $0.165); also paid an extra $0.18/share supplemental distribution in Sept 2026 on top of the regular monthly payout.",
    strategyLabel: "Wheel",
    strategyNote: "Mid-priced and volatile enough for decent option premium without being as thinly traded as the smallest BDCs — check the options chain's open interest before sizing up.",
    entry: "Sell an $18 cash-secured put, ~30–45 days out", exit: "If assigned at $18, sell a $20 covered call the next cycle",
  },
  {
    symbol: "HRZN", name: "Horizon Technology Finance", tv: "NASDAQ:HRZN", held: false,
    price: 4.29, monthlyDiv: 0.09, yieldPct: 25.17,
    exDiv: "Nov 17, 2026", payDate: "Dec 15, 2026",
    news: "Cut its monthly dividend by about 45% in March 2026 (from $0.11 to $0.06/share), then partially restored it to the current $0.09/share starting June 2026. Venture-debt BDC — highest headline yield on this list, but that cut history is exactly why.",
    strategyLabel: "Wheel (caution)",
    strategyNote: "Very cheap per share, but options on a sub-$5 stock are often thin — confirm real bid/ask spreads and open interest before committing size, or this may not be practically tradeable as an option play. The shakiest name on this list — a candidate for the next swap.",
    entry: "Sell a $4.00–4.50 cash-secured put, ~30–45 days out (if liquidity supports it)", exit: "If assigned, sell a $5.00 covered call the next cycle",
  },
];

module.exports = { DIVIDEND_SEED };
