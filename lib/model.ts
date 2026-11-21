// Implied-value model for the token launch radar (round 5, clean-room).
//
// Idea: protocols that already issued a token reveal how the market prices
// TVL. Fit a log-log size curve on those comparables (leaving out CEX and
// Chain categories, whose market caps price a business or a whole chain
// rather than one protocol's token), nudge the curve with three small
// tilts (7-day momentum, maturity, chain breadth), and read off what a
// token would be worth for protocols that record none. A seeded bootstrap
// that refits the curve on resampled comparables gives every row a
// low/high band, and the farm verdict nets a stated share of the band's
// low end against a stated cost of farming, category by category.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface Row {
  slug: string;
  name: string;
  rank: number;
  value: number;
  lo: number;
  hi: number;
  tvl: number;
  change7d: number | null;
  ageDays: number;
  nChains: number;
  firstChain: string;
  category: string;
  verdict: "Farm" | "Thin" | "Skip";
  rewardUsd: number;
  costUsd: number;
  farm_steps: string[];
}

export interface FitInfo {
  a: number;
  b: number;
  n: number;
  q05: number;
  q95: number;
}

export interface Backtest {
  nTrain: number;
  nTest: number;
  timeMedian: number;
  timeWithin2: number;
  timeWithin3: number;
  looN: number;
  looMedian: number;
  looWithin2: number;
  looWithin3: number;
  looSpearman: number;
}

// Tilt weights, in log space. Each tilt is deliberately small: the size
// curve does the work, the tilts only order near-ties.
export const TILTS = { mom: 0.35, mat: 0.08, breadth: 0.05 };
// Farm economics: an assumed 8% of supply goes to the community at launch
// and a diligent single-wallet farmer expects 0.05% of that allocation.
export const FARM = { allocShare: 0.08, farmerShare: 0.0005, weeks: 12 };
export const BOOT_SEED = 20261114;
export const BOOT_ROUNDS = 240;

const FIT_EXCLUDED = new Set(["CEX", "Chain"]);
const ASIDE_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);
const EXCHANGE_PREFIXES = [
  "Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini",
];
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

// Weekly farming cost in dollars and the core activity phrase, per
// category. Anything unlisted uses the default row.
export const CATEGORY_PLAN: Record<string, { cost: number; act: string }> = {
  Dexs: { cost: 6, act: "swap a basket of pairs and hold a small liquidity position" },
  Lending: { cost: 10, act: "supply collateral, borrow conservatively and repay on schedule" },
  CDP: { cost: 12, act: "open a small vault, mint the stablecoin and keep collateral well above liquidation" },
  Yield: { cost: 7, act: "deposit into the flagship vault and roll the position as epochs turn" },
  "Yield Aggregator": { cost: 7, act: "deposit into two vaults and rotate between them monthly" },
  Derivatives: { cost: 14, act: "trade small perpetual positions with tight stops and low leverage" },
  Perps: { cost: 14, act: "trade small perpetual positions with tight stops and low leverage" },
  "Risk Curators": { cost: 9, act: "allocate to a curated vault and follow the curator's rebalances" },
  "Onchain Capital Allocator": { cost: 9, act: "allocate to a curated vault and follow the curator's rebalances" },
  RWA: { cost: 11, act: "buy a small position in the flagship real-world asset pool" },
  "Basis Trading": { cost: 13, act: "run a small delta-neutral basis position and rebalance weekly" },
  "Staking Pool": { cost: 5, act: "stake a modest amount and restake the rewards as they land" },
  Services: { cost: 8, act: "use the paid service tier once a month and keep invoices" },
  "Launchpad": { cost: 10, act: "join one launch allocation with a small ticket and hold the result" },
  "NFT Lending": { cost: 9, act: "lend against one blue-chip NFT at a conservative loan-to-value" },
  "Options": { cost: 12, act: "buy one small defined-risk option structure per month" },
  "Prediction Market": { cost: 8, act: "take small positions on liquid markets and settle them out" },
  "Chain": { cost: 8, act: "bridge in, use the native apps and keep gas in the chain token" },
};
export const DEFAULT_PLAN = { cost: 8, act: "use the core product the way a real user would" };

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function dayMs(day: string): number {
  return Date.parse(day + "T00:00:00Z");
}

export function ageDays(p: Protocol, asOf: string): number {
  if (!p.listed_at) return 0;
  const d = Math.round((dayMs(asOf) - dayMs(p.listed_at)) / 86400000);
  return d > 0 ? d : 0;
}

export function isTraded(p: Protocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

export function isSetAside(p: Protocol): boolean {
  if (p.category && ASIDE_CATEGORIES.has(p.category)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  if (VERSION_TAIL.test(p.name)) return true;
  return EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x));
}

export function cleanedFitSet(ps: Protocol[]): Protocol[] {
  return ps.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 &&
      !(p.category && FIT_EXCLUDED.has(p.category)),
  );
}

// Ordinary least squares for log(mcap) = a + b * log(tvl).
export function ols(points: { x: number; y: number }[]): { a: number; b: number } {
  const n = points.length;
  let sx = 0, sy = 0;
  for (const q of points) { sx += q.x; sy += q.y; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0;
  for (const q of points) {
    sxy += (q.x - mx) * (q.y - my);
    sxx += (q.x - mx) * (q.x - mx);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return { a: my - b * mx, b };
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

export function tiltLog(p: Protocol, asOf: string): number {
  const c = p.change_7d === null ? 0 : Math.max(-30, Math.min(60, p.change_7d));
  const mom = (TILTS.mom * c) / 100;
  const mat = TILTS.mat * Math.log1p(ageDays(p, asOf) / 365);
  const breadth = TILTS.breadth * Math.log(Math.max(1, p.chains.length));
  return mom + mat + breadth;
}

export function predictLog(fit: { a: number; b: number }, p: Protocol, asOf: string): number {
  return fit.a + fit.b * Math.log(p.tvl_usd) + tiltLog(p, asOf);
}

export function fitModel(snap: Snapshot): FitInfo {
  const set = cleanedFitSet(snap.protocols);
  const raw = ols(set.map((p) => ({ x: Math.log(p.tvl_usd), y: Math.log(p.mcap_usd as number) })));
  const fit = { a: round6(raw.a), b: round6(raw.b) };
  return { a: fit.a, b: fit.b, n: set.length, q05: 0, q95: 0 };
}

// Band from a bootstrap of the fit itself: resample the comparables,
// refit the curve, and look at how far the refit predictions move from
// the point prediction, pooled over the candidate board. The band is a
// statement about model uncertainty, not about market noise, and the
// farm verdicts net against its low end.
export function bootstrapBand(snap: Snapshot, fit: FitInfo, candidates: Protocol[]): { q05: number; q95: number } {
  const set = cleanedFitSet(snap.protocols);
  const rnd = mulberry32(BOOT_SEED);
  const ratios: number[] = [];
  for (let r = 0; r < BOOT_ROUNDS; r++) {
    const sample: Protocol[] = [];
    for (let i = 0; i < set.length; i++) sample.push(set[Math.floor(rnd() * set.length)]);
    const raw = ols(sample.map((p) => ({ x: Math.log(p.tvl_usd), y: Math.log(p.mcap_usd as number) })));
    const f = { a: round6(raw.a), b: round6(raw.b) };
    for (const p of candidates) {
      ratios.push(predictLog(f, p, snap.as_of) - predictLog(fit, p, snap.as_of));
    }
  }
  ratios.sort((x, y) => x - y);
  return {
    q05: round4(ratios[Math.floor(0.05 * ratios.length)]),
    q95: round4(ratios[Math.floor(0.95 * ratios.length)]),
  };
}

export function round3sig(v: number): number {
  if (v <= 0) return 0;
  const d = Math.pow(10, Math.floor(Math.log10(v)) - 2);
  return Math.round(v / d) * d;
}

export function planFor(category: string | null): { cost: number; act: string } {
  if (category && CATEGORY_PLAN[category]) return CATEGORY_PLAN[category];
  return DEFAULT_PLAN;
}

export function stakeTier(tvl: number): number {
  const raw = Math.round(tvl * 0.00002);
  return Math.max(100, Math.min(5000, raw));
}

// The farm plan generator. dashboard/app.js carries the same templates and
// constants and must produce these strings byte for byte; both are written
// by the same hand for this entry, and the dashboard's recompute badge
// verifies them in the browser.
export function farmSteps(r: {
  name: string; category: string; firstChain: string; nChains: number;
  tvl: number; value: number; lo: number; hi: number;
}): string[] {
  const plan = planFor(r.category);
  const stake = stakeTier(r.tvl);
  const weekly = plan.cost;
  const total = weekly * FARM.weeks + (r.nChains > 1 ? 15 : 0);
  const weeks = FARM.weeks;
  return [
    `Start on ${r.firstChain}: open ${r.name} in a fresh wallet, bookmark the official app and keep $${stake} of working capital ready for the first session.`,
    `Make a first real deposit of about $${stake} and ${plan.act}; a position you would be content to hold is the whole point of week one.`,
    `Repeat the core activity weekly for ${weeks} weeks; expected fees and gas come to about $${weekly} a week, roughly $${total} across the full campaign.`,
    r.nChains > 1
      ? `Spread activity across ${r.name}'s ${r.nChains} chains over the campaign; breadth is cheap evidence of a real user and the bridge budget is already in the $${total}.`
      : `Stay on ${r.firstChain} and deepen the position instead of spreading thin; add a second product inside ${r.name} from week four if one exists.`,
    `Join ${r.name}'s governance and community channels, vote on every proposal you can and keep screenshots and transaction hashes of each week's activity.`,
    `Review monthly against the radar: the implied value is $${r.value.toLocaleString("en-US")} with a band of $${r.lo.toLocaleString("en-US")} to $${r.hi.toLocaleString("en-US")}; if TVL falls for three straight weeks, pause new deposits.`,
    `If a token launches, claim in the first window, then sell or hedge in tranches rather than all at once; the band low, not the headline value, is the number to plan around.`,
  ];
}

export function verdictFor(lo: number, costUsd: number): { verdict: Row["verdict"]; reward: number } {
  const reward = Math.round(lo * FARM.allocShare * FARM.farmerShare);
  const ratio = costUsd > 0 ? reward / costUsd : 0;
  if (ratio >= 3) return { verdict: "Farm", reward };
  if (ratio >= 1) return { verdict: "Thin", reward };
  return { verdict: "Skip", reward };
}

export interface BoardResult {
  rows: Row[];
  fit: FitInfo;
  ledger: { total: number; ranked: number; setAside: number; traded: number; unpriced: number };
  backtest: Backtest;
}

export function buildBoard(snap: Snapshot): BoardResult {
  const point = fitModel(snap);
  const traded = snap.protocols.filter(isTraded).length;
  const tokenless = snap.protocols.filter((p) => !isTraded(p));
  const setAside = tokenless.filter(isSetAside).length;
  const candidates = tokenless.filter((p) => !isSetAside(p) && p.tvl_usd >= snap.floor_usd / 10);
  const unpriced = tokenless.length - setAside - candidates.length;
  const band = bootstrapBand(snap, point, candidates);
  const fit: FitInfo = { ...point, q05: band.q05, q95: band.q95 };

  const rows: Row[] = candidates.map((p) => {
    const value = Math.round(Math.exp(predictLog(fit, p, snap.as_of)));
    const lo = round3sig(value * Math.exp(fit.q05));
    const hi = round3sig(value * Math.exp(fit.q95));
    const plan = planFor(p.category);
    const costUsd = plan.cost * FARM.weeks + (p.chains.length > 1 ? 15 : 0);
    const { verdict, reward } = verdictFor(lo, costUsd);
    const base = {
      name: p.name,
      category: p.category ?? "Uncategorised",
      firstChain: p.chains[0] ?? "Ethereum",
      nChains: Math.max(1, p.chains.length),
      tvl: p.tvl_usd,
      value, lo, hi,
    };
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      value, lo, hi,
      tvl: p.tvl_usd,
      change7d: p.change_7d,
      ageDays: ageDays(p, snap.as_of),
      nChains: base.nChains,
      firstChain: base.firstChain,
      category: base.category,
      verdict,
      rewardUsd: reward,
      costUsd,
      farm_steps: farmSteps(base),
    };
  });
  rows.sort((x, y) => (y.value - x.value) || (x.slug < y.slug ? -1 : 1));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return {
    rows,
    fit,
    ledger: { total: snap.protocols.length, ranked: rows.length, setAside, traded, unpriced },
    backtest: runBacktest(snap),
  };
}

function missStats(preds: number[], actuals: number[]): { median: number; w2: number; w3: number } {
  const miss = preds.map((p, i) => Math.exp(Math.abs(Math.log(p / actuals[i]))));
  const sorted = [...miss].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  const w2 = miss.filter((m) => m <= 2).length / miss.length;
  const w3 = miss.filter((m) => m <= 3).length / miss.length;
  return { median, w2, w3 };
}

function spearman(xs: number[], ys: number[]): number {
  const rank = (vs: number[]): number[] => {
    const order = vs.map((v, i) => ({ v, i })).sort((p, q) => p.v - q.v);
    const out = new Array<number>(vs.length);
    order.forEach((o, r) => { out[o.i] = r; });
    return out;
  };
  const rx = rank(xs), ry = rank(ys);
  const n = xs.length;
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) * (rx[i] - ry[i]);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

export function runBacktest(snap: Snapshot): Backtest {
  const set = cleanedFitSet(snap.protocols);
  const train = set.filter((p) => (p.listed_at ?? "9999") < "2024-01-01");
  const test = set.filter((p) => (p.listed_at ?? "0000") >= "2024-01-01");
  const rawT = ols(train.map((p) => ({ x: Math.log(p.tvl_usd), y: Math.log(p.mcap_usd as number) })));
  const fitT = { a: round6(rawT.a), b: round6(rawT.b) };
  const tStats = missStats(
    test.map((p) => Math.exp(predictLog(fitT, p, snap.as_of))),
    test.map((p) => p.mcap_usd as number),
  );
  const looPred: number[] = [];
  const looAct: number[] = [];
  for (let i = 0; i < set.length; i++) {
    const rest = set.filter((_, j) => j !== i);
    const raw = ols(rest.map((p) => ({ x: Math.log(p.tvl_usd), y: Math.log(p.mcap_usd as number) })));
    const f = { a: round6(raw.a), b: round6(raw.b) };
    looPred.push(Math.exp(predictLog(f, set[i], snap.as_of)));
    looAct.push(set[i].mcap_usd as number);
  }
  const lStats = missStats(looPred, looAct);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const pc = (v: number) => Math.round(v * 1000) / 10;
  return {
    nTrain: train.length,
    nTest: test.length,
    timeMedian: r3(tStats.median),
    timeWithin2: pc(tStats.w2),
    timeWithin3: pc(tStats.w3),
    looN: set.length,
    looMedian: r3(lStats.median),
    looWithin2: pc(lStats.w2),
    looWithin3: pc(lStats.w3),
    looSpearman: r3(spearman(looPred, looAct)),
  };
}
