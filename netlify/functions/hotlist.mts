import type { Context, Config } from "@netlify/functions";

// Server-side version of the Daily Hot List ranker. Runs on Netlify's
// servers, not in the visitor's browser — this avoids two problems the
// client-side version had: the Finnhub API key never has to be shipped to
// the browser (it lives only in this project's environment variables), and
// server-to-server requests aren't subject to the browser's CORS rules, so
// this works regardless of whether Finnhub allows direct browser calls.

const FINNHUB_BASE = "https://finnhub.io/api/v1";

// Same candidate universe as the client used to hold — the tv/name lookup
// used for chart symbols and display names on the app's own watchlist.
const WATCHLIST: Record<string, { name: string; tv: string }> = {
  AAPL: { name: "Apple Inc.", tv: "NASDAQ:AAPL" },
  MSFT: { name: "Microsoft Corp.", tv: "NASDAQ:MSFT" },
  GOOGL: { name: "Alphabet Inc.", tv: "NASDAQ:GOOGL" },
  AMZN: { name: "Amazon.com Inc.", tv: "NASDAQ:AMZN" },
  NVDA: { name: "NVIDIA Corp.", tv: "NASDAQ:NVDA" },
  META: { name: "Meta Platforms Inc.", tv: "NASDAQ:META" },
  TSLA: { name: "Tesla Inc.", tv: "NASDAQ:TSLA" },
  JPM: { name: "JPMorgan Chase & Co.", tv: "NYSE:JPM" },
  SOFI: { name: "SoFi Technologies Inc.", tv: "NASDAQ:SOFI" },
  RYCEY: { name: "Rolls-Royce Holdings plc", tv: "OTC:RYCEY" },
  PLTR: { name: "Palantir Technologies", tv: "NASDAQ:PLTR" },
  RIVN: { name: "Rivian Automotive Inc.", tv: "NASDAQ:RIVN" },
  COIN: { name: "Coinbase Global Inc.", tv: "NASDAQ:COIN" },
  DKNG: { name: "DraftKings Inc.", tv: "NASDAQ:DKNG" },
  ROKU: { name: "Roku Inc.", tv: "NASDAQ:ROKU" },
  CHWY: { name: "Chewy Inc.", tv: "NYSE:CHWY" },
  AFRM: { name: "Affirm Holdings Inc.", tv: "NASDAQ:AFRM" },
  UPST: { name: "Upstart Holdings Inc.", tv: "NASDAQ:UPST" },
};

const HOTLIST_UNIVERSE = [...new Set([
  ...Object.keys(WATCHLIST),
  "AVGO", "DELL", "MDB", "PANW", "GTLB", "CRDO", "OLLI", "LULU",
  "MSTR", "SMCI", "ARM", "SNOW", "CRWD", "NET", "SHOP", "UBER",
])];

async function fh(path: string, params: Record<string, string>, key: string) {
  const qs = new URLSearchParams({ ...params, token: key }).toString();
  const res = await fetch(`${FINNHUB_BASE}${path}?${qs}`);
  if (!res.ok) {
    const err: any = new Error(`Finnhub ${path} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export default async (req: Request, context: Context) => {
  const key = Netlify.env.get("FINNHUB_API_KEY");
  if (!key) {
    return Response.json({ error: "no-key", message: "FINNHUB_API_KEY is not set in this site's environment variables." }, { status: 500 });
  }

  const today = todayStr();

  // Probe first, unswallowed, so a real failure reason survives.
  try {
    await fh("/quote", { symbol: "AAPL" }, key);
  } catch (probeErr: any) {
    if (probeErr.status === 401 || probeErr.status === 403) {
      return Response.json({ error: "auth", message: "Finnhub rejected this API key." }, { status: 502 });
    }
    if (probeErr.status === 429) {
      return Response.json({ error: "ratelimit", message: "Finnhub rate-limited this key." }, { status: 502 });
    }
    return Response.json({ error: "upstream", message: String(probeErr.message || probeErr) }, { status: 502 });
  }

  let earningsToday = new Set<string>();
  let earningsInfo: Record<string, any> = {};
  try {
    const cal = await fh("/calendar/earnings", { from: today, to: today }, key);
    (cal.earningsCalendar || []).forEach((e: any) => {
      if (HOTLIST_UNIVERSE.includes(e.symbol)) {
        earningsToday.add(e.symbol);
        earningsInfo[e.symbol] = e;
      }
    });
  } catch { /* bonus signal only */ }

  const quotes: Record<string, any> = {};
  await Promise.all(HOTLIST_UNIVERSE.map(async (sym) => {
    try {
      const q = await fh("/quote", { symbol: sym }, key);
      if (q && q.c) quotes[sym] = q;
    } catch { /* skip this symbol */ }
  }));

  const ranked = HOTLIST_UNIVERSE
    .filter((sym) => quotes[sym] && typeof quotes[sym].dp === "number")
    .map((sym) => ({
      sym,
      q: quotes[sym],
      hasEarnings: earningsToday.has(sym),
      score: Math.abs(quotes[sym].dp || 0) + (earningsToday.has(sym) ? 3 : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  if (!ranked.length) {
    return Response.json({ error: "no-data", message: "No candidates returned usable quotes." }, { status: 502 });
  }

  const list = ranked.map(({ sym, q, hasEarnings }) => {
    const watchItem = WATCHLIST[sym];
    const tv = watchItem ? watchItem.tv : `NASDAQ:${sym}`;
    const name = watchItem ? watchItem.name : sym;
    const dir = q.dp >= 0 ? "long" : "short";
    const rangeWidth = (q.h - q.l) || (q.c * 0.02);
    const breakoutTarget = dir === "long" ? (q.h + rangeWidth) : (q.l - rangeWidth);
    let catalyst;
    if (hasEarnings) {
      const info = earningsInfo[sym];
      const when = info?.hour === "bmo" ? "before today's open" : info?.hour === "amc" ? "after today's close" : "around today's session";
      catalyst = `Reporting earnings ${when}${info?.epsEstimate != null ? ` (consensus ≈$${info.epsEstimate} EPS)` : ""} — live earnings calendar`;
    } else {
      catalyst = `Live mover: ${q.dp >= 0 ? "+" : ""}${q.dp.toFixed(2)}% today on real-time price action`;
    }
    return {
      symbol: sym, name, tv, direction: dir, catalyst,
      setup: `Live quote $${q.c.toFixed(2)} (${q.dp >= 0 ? "+" : ""}${q.dp.toFixed(2)}% today), day range $${q.l.toFixed(2)}–$${q.h.toFixed(2)}, prev close $${q.pc.toFixed(2)}.`,
      entry: dir === "long" ? `Break above $${q.h.toFixed(2)} (today's high)` : `Break below $${q.l.toFixed(2)} (today's low)`,
      target: `≈$${breakoutTarget.toFixed(2)} (today's range projected past the breakout)`,
      stop: dir === "long" ? `$${q.l.toFixed(2)} (today's low)` : `$${q.h.toFixed(2)} (today's high)`,
      gapRisk: hasEarnings,
      note: hasEarnings
        ? "Reports earnings today — if that's after the close and you hold through it, a stop-loss will NOT protect you from an overnight gap."
        : "Ranked purely by live % move — confirm this is a real breakout on the chart, not just noise, before acting.",
    };
  });

  return Response.json({ list, generatedAt: new Date().toISOString() }, {
    headers: { "Cache-Control": "public, max-age=120" },
  });
};

export const config: Config = {
  path: "/api/hotlist",
};
