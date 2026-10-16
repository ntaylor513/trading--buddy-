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
  "AVGO", "DELL", "MDB",
