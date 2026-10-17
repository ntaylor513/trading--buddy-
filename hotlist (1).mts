import type { Context, Config } from "@netlify/functions";

// Server-side version of the Daily Hot List ranker. Runs on Netlify's
// servers, not in the visitor's browser — this avoids two problems the
// client-side version had: the Finnhub API key never has to be shipped to
// the browser (it lives only in this project's environment variables), and
// server-to-server requests aren't subject to the browser's CORS rules, so
// this works regardless of whether Finnhub allows direct browser calls.
//
// UNIVERSE: every S&P 500 (large-cap) + S&P MidCap 400 (mid-cap)
// constituent — ~900 tickers, deduplicated — rather than a small
// hand-picked list. That IS the standard definition of "large and mid
// cap US stocks," so no live market-cap lookup is needed: index
// membership already encodes it. Sourced from each index's public
// constituent table; if a symbol lags a recent index reshuffle, Finnhub
// just returns no quote for it (see fh() below) and it's silently
// skipped — stale coverage here degrades gracefully, it never crashes.
//
// RATE LIMITS: Finnhub's free tier allows ~60 calls/minute, and that
// quota is SHARED with quote.js (live chart quotes) and
// check-alerts-cron.js (the alert-checking cron) — all three use the
// same FINNHUB_API_KEY. Scanning ~900 tickers can't happen in one burst
// without tripping 429s, so fetchQuotesThrottled() below works through
// the universe in small batches with a short pause between them, and
// gives up after a fixed time budget — ranking on whatever it managed
// to fetch rather than failing the whole request. In practice this
// means: the FIRST request after the 2-minute edge cache (see
// Cache-Control below) expires takes several seconds to run; every
// request within that 2-minute window after it is instant. If you want
// faster/fuller coverage, a paid Finnhub plan with a higher rate limit
// is the lever — this code doesn't need to change, just the numbers
// below (QUOTE_BATCH_SIZE / SCAN_TIME_BUDGET_MS).

const FINNHUB_BASE = "https://finnhub.io/api/v1";

// Curated name + TradingView-symbol lookup for names we want to pin
// exactly (display name, and which exchange TradingView should chart).
// Everything else in the universe is charted by bare ticker — see the
// `tv` fallback below — since guessing NYSE vs NASDAQ for ~900 names
// isn't worth maintaining by hand; TradingView's own symbol search
// resolves a bare US ticker to its primary listing in the vast majority
// of cases.
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

// S&P 500 constituents (large cap) — see top-of-file note on sourcing.
const SP500: string[] = [
  "MMM","AOS","ABT","ABBV","ACN","ADBE","AMD","AES","AFL","A","APD","ABNB","AKAM","ALB","ARE","ALGN",
  "ALLE","LNT","ALL","GOOGL","GOOG","MO","AMZN","AMCR","AEE","AEP","AXP","AIG","AMT","AWK","AMP","AME",
  "AMGN","APH","ADI","AON","APA","APO","AAPL","AMAT","APP","APTV","ACGL","ADM","ARES","ANET","AJG","AIZ",
  "T","ATO","ADSK","ADP","AZO","AVY","AXON","BKR","BALL","BAC","BAX","BDX","BRK.B","BBY","TECH","BIIB",
  "BLK","BX","XYZ","BNY","BA","BKNG","BSX","BMY","AVGO","BR","BRO","BF.B","BLDR","BG","BXP","CHRW",
  "CDNS","CPT","COF","CAH","CCL","CARR","CVNA","CASY","CAT","CBOE","CBRE","CDW","COR","CNC","CNP","CF",
  "CRL","SCHW","CHTR","CVX","CMG","CB","CHD","CIEN","CI","CINF","CTAS","CSCO","C","CFG","CLX","CME",
  "CMS","KO","CTSH","COHR","COIN","CL","CMCSA","FIX","COP","ED","STZ","CEG","COO","CPRT","GLW","CPAY",
  "CTVA","CSGP","COST","CRH","CRWD","CCI","CSX","CMI","CVS","DHR","DRI","DDOG","DVA","DECK","DE","DELL",
  "DAL","DVN","DXCM","FANG","DLR","DG","DLTR","D","DPZ","DASH","DOV","DOW","DHI","DTE","DUK","DD",
  "ETN","EBAY","ECL","EIX","EW","ELV","EME","EMR","ETR","EOG","EQT","EFX","EQIX","ERIE","ESS","EL",
  "EG","EVRG","ES","EXC","EXE","EXPE","EXPD","EXR","XOM","FFIV","FDS","FICO","FAST","FRT","FDX","FERG",
  "FIS","FITB","FSLR","FE","FLEX","F","FTNT","FTV","FOXA","FOX","BEN","FCX","GRMN","IT","GE","GEHC",
  "GEV","GEN","GNRC","GD","GIS","GM","GPC","GILD","GPN","GL","GDDY","GS","HAL","HIG","HAS","HCA",
  "DOC","HSIC","HSY","HPE","HLT","HD","HON","HRL","HST","HWM","HPQ","HUBB","HUM","HBAN","HII","IBM",
  "IEX","IDXX","ITW","INCY","IR","PODD","INTC","IBKR","ICE","IFF","IP","INTU","ISRG","IVZ","INVH","IQV",
  "IRM","JBHT","JBL","JKHY","J","JNJ","JCI","JPM","KVUE","KDP","KEY","KEYS","KMB","KIM","KMI","KKR",
  "KLAC","KHC","KR","LHX","LH","LRCX","LVS","LDOS","LEN","LII","LLY","LIN","LYV","LMT","L","LOW",
  "LULU","LYB","MTB","MPC","MAR","MLM","MRVL","MAS","MA","MKC","MCD","MCK","MDT","MRK","META","MET",
  "MTD","MGM","MCHP","MU","MSFT","MAA","MRNA","TAP","MDLZ","MPWR","MNST","MCO","MS","MOS","MSI","MSCI",
  "NDAQ","NTAP","NFLX","NEM","NWSA","NWS","NEE","NKE","NI","NDSN","NSC","NTRS","NOC","NCLH","NRG","NUE",
  "NVDA","NVR","NXPI","ORLY","OXY","ODFL","OMC","ON","OKE","ORCL","OTIS","PCAR","PKG","PLTR","PANW","PH",
  "PAYX","PYPL","PNR","PEP","PFE","PCG","PM","PSX","PNW","PNC","PPG","PPL","PFG","PG","PGR","PLD",
  "PRU","PEG","PTC","PSA","PHM","PWR","QCOM","DGX","RL","RJF","RTX","O","REG","REGN","RF","RSG",
  "RMD","RVTY","HOOD","ROK","ROL","ROP","ROST","RCL","SPGI","CRM","SNDK","SBAC","SLB","STX","SRE","NOW",
  "SHW","SPG","SWKS","SJM","SW","SNA","SOLV","SO","LUV","SWK","SBUX","STT","STLD","STE","SYK","SMCI",
  "SYF","SNPS","SYY","TMUS","TROW","TTWO","TPR","TRGP","TGT","TEL","TDY","TER","TSLA","TXN","TPL","TXT",
  "TMO","TJX","TKO","TTD","TSCO","TT","TDG","TRV","TRMB","TFC","TYL","TSN","USB","UBER","UDR","ULTA",
  "UNP","UAL","UPS","URI","UNH","UHS","VLO","VEEV","VTR","VLTO","VRSN","VRSK","VZ","VRTX","VRT","VTRS",
  "VICI","V","VST","VMC","WRB","GWW","WAB","WMT","DIS","WBD","WM","WAT","WEC","WFC","WELL","WST",
  "WDC","WY","WSM","WMB","WTW","WDAY","WYNN","XEL","XYL","YUM","ZBRA","ZBH","ZTS",
];

// S&P MidCap 400 constituents (mid cap) — see top-of-file note on sourcing.
const SP400: string[] = [
  "AA","AAL","AAON","ACI","ACM","ADC","AEIS","AFG","AGCO","AHR","AIT","ALGM","ALK","ALLY","ALV","AM",
  "AMG","AMH","AMKR","AN","ANF","APG","APPF","AR","ARMK","ARW","ASB","ASH","ATI","ATR","AVAV","AVNT",
  "AVT","AVTR","AXTA","AYI","BAH","BBWI","BC","BCO","BDC","BHF","BILL","BIO","BJ","BKH","BLD","BMRN",
  "BRKR","BROS","BRX","BSY","BURL","BWA","BWXT","BYD","CACI","CAR","CART","CAVA","CBSH","CBT","CCK","CDE",
  "CELH","CFR","CG","CGNX","CHDN","CHE","CHH","CHRD","CHWY","CLF","CLH","CMC","CNH","CNM","CNO","CNX",
  "COKE","COLB","COLM","CPRI","CR","CRBG","CROX","CRS","CRUS","CSL","CTRE","CUBE","CUZ","CVLT","CW","CXT",
  "CYTK","DAR","DBX","DCI","DINO","DKS","DLB","DOCN","DOCS","DOCU","DT","DTM","DUOL","DY","EEFT","EGP",
  "EHC","ELAN","ELF","ELS","ENS","ENSG","ENTG","EPR","EQH","ESAB","ESNT","EVR","EWBC","EXEL","EXLS","EXP",
  "EXPO","FAF","FBIN","FCFS","FCN","FFIN","FHI","FHN","FIVE","FLG","FLR","FLS","FN","FNB","FND","FNF",
  "FOUR","FR","FTI","G","GAP","GATX","GBCI","GEF","GGG","GHC","GLPI","GME","GMED","GNTX","GPK","GT",
  "GTLS","GWRE","GXO","H","HAE","HALO","HGV","HIMS","HL","HLI","HLNE","HOG","HOMB","HQY","HR","HRB",
  "HWC","HXL","IBOC","IDA","IDCC","ILMN","INGR","IPGP","IRT","ITT","JAZZ","JEF","JHG","JLL","KBH","KBR",
  "KD","KEX","KNF","KNSL","KNX","KRC","KRG","KTOS","LAD","LAMR","LEA","LECO","LFUS","LIVN","LNTH","LOPE",
  "LPX","LSCC","LSTR","M","MANH","MAT","MEDP","MIDD","MKSI","MLI","MMS","MOG.A","MORN","MP","MSA","MSM",
  "MTDR","MTG","MTN","MTSI","MTZ","MUR","MUSA","NBIX","NEU","NFG","NJR","NLY","NNN","NOV","NOVT","NSA",
  "NTNX","NVST","NVT","NWE","NXST","NXT","NYT","OC","OGE","OGS","OHI","OKTA","OLED","OLLI","OLN","ONB",
  "ONTO","OPCH","ORA","ORI","OSK","OVV","OZK","P","PAG","PATH","PB","PBF","PCTY","PEGA","PEN","PFGC",
  "PII","PINS","PK","PLNT","PNFP","POR","POST","PPC","PR","PRI","PSN","PVH","QLYS","R","RBA","RBC",
  "REXR","RGA","RGEN","RGLD","RH","RLI","RMBS","RNR","ROIV","ROKU","RPM","RRC","RRX","RS","RYAN","RYN",
  "SAIA","SAIC","SAM","SANM","SBRA","SCI","SEIC","SF","SFM","SHC","SIGI","SIRI","SITM","SLAB","SLGN","SLM",
  "SMG","SMTC","SN","SNX","SON","SPXC","SR","SSB","SSD","ST","STAG","STRL","STWD","SWX","SYNA","TCBI",
  "TEX","THC","THG","THO","TKR","TLN","TMHC","TNL","TOL","TREX","TRU","TTC","TTEK","TTMI","TWLO","TXNM",
  "TXRH","UBSI","UFPI","UGI","UMBF","UNM","USFD","UTHR","VAL","VC","VFC","VIAV","VICR","VLY","VMI","VNO",
  "VNOM","VNT","VOYA","VVV","WAL","WBS","WCC","WEX","WFRD","WH","WHR","WING","WLK","WMG","WMS","WPC",
  "WSO","WTFC","WTRG","WTS","WWD","XPO","XRAY","YETI","ZION",
];

const HOTLIST_UNIVERSE = [...new Set([...Object.keys(WATCHLIST), ...SP500, ...SP400])];

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

// Pulls quotes for the whole universe in small throttled batches so a
// shared, rate-limited Finnhub key doesn't get hammered by ~900 calls at
// once. Gives up once SCAN_TIME_BUDGET_MS has elapsed and ranks on
// whatever was gathered so far — a partial, fresher-than-nothing scan
// beats either failing outright or blocking the page for a minute+.
const QUOTE_BATCH_SIZE = 80;
const QUOTE_BATCH_PAUSE_MS = 400;
const SCAN_TIME_BUDGET_MS = 8000;

async function fetchQuotesThrottled(symbols: string[], key: string) {
  const quotes: Record<string, any> = {};
  const start = Date.now();

  for (let i = 0; i < symbols.length; i += QUOTE_BATCH_SIZE) {
    if (Date.now() - start > SCAN_TIME_BUDGET_MS) {
      console.warn(`hotlist: time budget hit after ${i}/${symbols.length} symbols — ranking on partial scan`);
      break;
    }
    const batch = symbols.slice(i, i + QUOTE_BATCH_SIZE);
    await Promise.all(
      batch.map(async (sym) => {
        try {
          const q = await fh("/quote", { symbol: sym }, key);
          if (q && q.c) quotes[sym] = q;
        } catch {
          /* bad ticker, unpriced, or rate-limited this batch — just skip it */
        }
      })
    );
    if (i + QUOTE_BATCH_SIZE < symbols.length) {
      await new Promise((r) => setTimeout(r, QUOTE_BATCH_PAUSE_MS));
    }
  }

  return quotes;
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

  const quotes = await fetchQuotesThrottled(HOTLIST_UNIVERSE, key);

  // ── Ranking ──────────────────────────────────────────────────────────
  // Revisited now that the universe is ~900 names instead of ~30 — pure
  // "biggest % move wins" stops being a good filter at that scale, since
  // it's dominated by thin/erratic names that swing on noise rather than
  // real interest. Three changes:
  //
  //   1. MIN_PRICE screens out low-priced names whose % swings are often
  //      just noise, not a real move worth trading.
  //   2. MOVE_CAP_PCT caps how much credit raw % move gets, so one freak
  //      outlier (a halt, a spinoff, a bad print) can't mathematically
  //      bury every genuinely tradeable setup under it.
  //   3. rangePosition rewards a move that's AT today's high/low right
  //      now — a live, in-progress breakout — over one that spiked
  //      earlier and has since faded halfway back. This comes for free
  //      from the h/l/c Finnhub already returns, no extra API calls.
  //
  // The earnings bonus also drops from a flat +3 to +1.5: with hundreds
  // more tickers in play, far more names report on any given day, and a
  // middling earnings mover shouldn't automatically outrank a strong
  // organic technical breakout just for having a scheduled report.
  const MIN_PRICE = 5;
  const MOVE_CAP_PCT = 15;
  const EARNINGS_BONUS = 1.5;
  const RANGE_POSITION_WEIGHT = 2;
  const MIN_PICKS = 4;
  // Tried in order until at least MIN_PICKS candidates clear the bar, so
  // a genuinely quiet market day still returns a usable (if duller) list
  // instead of coming back empty.
  const MOVE_THRESHOLDS_PCT = [1.5, 1.0, 0.5, 0];

  const candidates = HOTLIST_UNIVERSE
    .filter((sym) => quotes[sym] && typeof quotes[sym].dp === "number" && quotes[sym].c >= MIN_PRICE)
    .map((sym) => {
      const q = quotes[sym];
      const dir = q.dp >= 0 ? "long" : "short";
      const range = q.h - q.l;
      // 0 = sitting at the opposite extreme from the move's direction
      // (a faded spike); 1 = right at today's high/low this instant (a
      // live breakout in progress). No intraday range at all (e.g. a
      // single illiquid print) neither rewards nor penalizes.
      const rangePosition = range > 0
        ? (dir === "long" ? (q.c - q.l) / range : (q.h - q.c) / range)
        : 1;
      const hasEarnings = earningsToday.has(sym);
      const absMove = Math.abs(q.dp);
      const cappedMove = Math.min(absMove, MOVE_CAP_PCT);
      const score = cappedMove + rangePosition * RANGE_POSITION_WEIGHT + (hasEarnings ? EARNINGS_BONUS : 0);
      return { sym, q, dir, rangePosition, hasEarnings, absMove, score };
    });

  let qualifying: typeof candidates = [];
  for (const threshold of MOVE_THRESHOLDS_PCT) {
    qualifying = candidates.filter((c) => c.absMove >= threshold);
    if (qualifying.length >= MIN_PICKS) break;
  }
  if (!qualifying.length) qualifying = candidates; // nothing cleared even a 0% floor — use whatever priced

  const ranked = qualifying.sort((a, b) => b.score - a.score).slice(0, MIN_PICKS);

  if (!ranked.length) {
    return Response.json({ error: "no-data", message: "No candidates returned usable quotes." }, { status: 502 });
  }

  const list = ranked.map(({ sym, q, hasEarnings, dir, rangePosition }) => {
    const watchItem = WATCHLIST[sym];
    // No curated entry for this symbol (true for most of the widened
    // universe) — chart it by bare ticker and let TradingView's own
    // symbol search resolve the primary listing, rather than guessing
    // an exchange prefix that's wrong more often than not.
    const tv = watchItem ? watchItem.tv : sym;
    const name = watchItem ? watchItem.name : sym;
    const rangeWidth = (q.h - q.l) || (q.c * 0.02);
    const breakoutTarget = dir === "long" ? (q.h + rangeWidth) : (q.l - rangeWidth);
    // The same number already shown in the Entry field below, exposed here
    // as a plain numeric value (plus direction) so the breakout-alert
    // engine on the page can auto-arm each pick without any manual entry —
    // "break above today's high" / "break below today's low".
    const triggerPrice = dir === "long" ? q.h : q.l;
    let catalyst;
    if (hasEarnings) {
      const info = earningsInfo[sym];
      const when = info?.hour === "bmo" ? "before today's open" : info?.hour === "amc" ? "after today's close" : "around today's session";
      catalyst = `Reporting earnings ${when}${info?.epsEstimate != null ? ` (consensus ≈$${info.epsEstimate} EPS)` : ""} — live earnings calendar`;
    } else {
      const extremeWord = dir === "long" ? "high" : "low";
      const pressing = rangePosition >= 0.8 ? `, currently pressing today's ${extremeWord}` : "";
      catalyst = `Live mover: ${q.dp >= 0 ? "+" : ""}${q.dp.toFixed(2)}% today on real-time price action${pressing}`;
    }
    return {
      symbol: sym, name, tv, direction: dir, catalyst,
      setup: `Live quote $${q.c.toFixed(2)} (${q.dp >= 0 ? "+" : ""}${q.dp.toFixed(2)}% today), day range $${q.l.toFixed(2)}–$${q.h.toFixed(2)}, prev close $${q.pc.toFixed(2)}.`,
      entry: dir === "long" ? `Break above $${q.h.toFixed(2)} (today's high)` : `Break below $${q.l.toFixed(2)} (today's low)`,
      target: `≈$${breakoutTarget.toFixed(2)} (today's range projected past the breakout)`,
      stop: dir === "long" ? `$${q.l.toFixed(2)} (today's low)` : `$${q.h.toFixed(2)} (today's high)`,
      gapRisk: hasEarnings,
      triggerPrice,
      triggerDirection: dir,
      note: hasEarnings
        ? "Reports earnings today — if that's after the close and you hold through it, a stop-loss will NOT protect you from an overnight gap."
        : "Ranked by live % move, proximity to today's high/low, and (if applicable) an earnings catalyst — confirm this is a real breakout on the chart, not just noise, before acting.",
    };
  });

  return Response.json({ list, generatedAt: new Date().toISOString(), scanned: Object.keys(quotes).length, universeSize: HOTLIST_UNIVERSE.length }, {
    headers: { "Cache-Control": "public, max-age=120" },
  });
};

export const config: Config = {
  path: "/api/hotlist",
};
