// lib/model.ts — the Token Launch Radar pricing model and everything derived
// from it: universe classification, the fitted size curve, backtest
// validation, bootstrap uncertainty bands, farm economics and farm plans.
//
// The model in one paragraph: a protocol that records no token is priced off
// the protocols whose tokens already trade. On the traded peers, market cap
// is fitted as a power law of TVL (a least-squares line in log-log space)
// with a per-category log offset shrunk toward zero. The curve is fitted on
// a cleaned peer set: the CEX and Chain categories are excluded, because an
// exchange's or a chain's token price does not read off the TVL its record
// tracks. Three hand-set tilts from the protocol's own record then apply:
// momentum (its 7-day TVL change), maturity (how long it has run tokenless)
// and breadth (how many chains it runs on). Fitted tilt weights were tested
// and rejected: they chase noise on 118 fit points and degrade every
// out-of-sample split that matters.

export interface ProtocolRec {
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
  source: string;
  floor_usd: number;
  protocols: ProtocolRec[];
  watchlist: string[];
}

// ---------------------------------------------------------------------------
// Constants of the model. Every one is stated on the dashboard's Method view.
// ---------------------------------------------------------------------------

export const FIT_EXCLUDED_CATEGORIES: string[] = ["CEX", "Chain"];
export const OFFSET_PRIOR = 6; // shrinkage strength on category offsets
export const MOMENTUM_RATE = 0.4; // value moves 40% of the 7-day TVL change
export const MOMENTUM_MIN = -0.6; // growth clamp, low
export const MOMENTUM_MAX = 1.2; // growth clamp, high
export const MATURITY_FLOOR = 0.75; // maturity multiplier at age zero
export const MATURITY_CAP = 1.2; // maturity multiplier as age -> infinity
export const MATURITY_TAU_DAYS = 540; // maturity time constant
export const BREADTH_PER_CHAIN = 0.02; // +2% per chain past the first
export const BREADTH_MAX_EXTRA = 10; // breadth bonus capped at ten chains
export const BOOTSTRAP_REPS = 200;
export const BOOTSTRAP_SEED = 20261114;
export const AIRDROP_SHARE = 0.1; // farmers split 10% of implied value
export const TICKET_FRACTION = 0.0001; // ticket = 0.01% of TVL ...
export const TICKET_MIN = 250; // ... clamped to [$250, $5,000]
export const TICKET_MAX = 5000;
export const FORGONE_APR = 0.04; // 4% a year on the ticket while it is locked
export const HOLD_DAYS = 84; // the plan runs twelve weeks

// ---------------------------------------------------------------------------
// Small deterministic helpers (the program runs twice and must write the
// same bytes both times: no wall clock, no Math.random anywhere).
// ---------------------------------------------------------------------------

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + "T00:00:00Z");
  const b = Date.parse(toIso + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

export function ageDays(p: ProtocolRec, asOf: string): number {
  if (p.listed_at === null) return -1;
  return Math.max(0, daysBetween(p.listed_at, asOf));
}

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = q * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

export function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  return quantile(s, 0.5);
}

export function roundTo(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

// ---------------------------------------------------------------------------
// Universe classification: the set-aside ledger. Every one of the snapshot's
// 758 protocols lands in exactly one class, and the classes reconcile:
// 758 = ranked + set aside + traded + unpriced.
// ---------------------------------------------------------------------------

export const CONDUIT_CATEGORIES: string[] = [
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
];
export const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
export const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
export const EXCHANGE_PREFIXES: string[] = [
  "Binance",
  "Coinbase",
  "Bybit",
  "Kraken",
  "Bitget",
  "OKX",
  "Bitfinex",
  "Gemini",
];

export function recordsToken(p: ProtocolRec): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

export function setAsideReason(p: ProtocolRec): string | null {
  if (p.category !== null && CONDUIT_CATEGORIES.includes(p.category)) {
    return "conduit category (" + p.category + ")";
  }
  if (VERSION_SUFFIX.test(p.name)) return "version-suffix redeployment";
  if (WRAPPED_WORD.test(p.name)) return "wrapped or staked product name";
  for (const ex of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(ex)) return "exchange house product";
  }
  return null;
}

export interface Universe {
  ranked: ProtocolRec[];
  setAside: { rec: ProtocolRec; reason: string }[];
  traded: ProtocolRec[];
  unpriced: ProtocolRec[];
  pricedPeers: ProtocolRec[];
  cleanedPeers: ProtocolRec[];
  excludedPeers: ProtocolRec[];
}

export function classifyUniverse(snap: Snapshot): Universe {
  const ranked: ProtocolRec[] = [];
  const setAside: { rec: ProtocolRec; reason: string }[] = [];
  const traded: ProtocolRec[] = [];
  const unpriced: ProtocolRec[] = [];
  for (const p of snap.protocols) {
    if (recordsToken(p)) {
      if (p.mcap_usd !== null) traded.push(p);
      else unpriced.push(p);
    } else {
      const reason = setAsideReason(p);
      if (reason !== null) setAside.push({ rec: p, reason });
      else ranked.push(p);
    }
  }
  const pricedPeers = snap.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0,
  );
  const excludedPeers = pricedPeers.filter(
    (p) => p.category !== null && FIT_EXCLUDED_CATEGORIES.includes(p.category),
  );
  const cleanedPeers = pricedPeers.filter(
    (p) => !(p.category !== null && FIT_EXCLUDED_CATEGORIES.includes(p.category)),
  );
  return { ranked, setAside, traded, unpriced, pricedPeers, cleanedPeers, excludedPeers };
}

// ---------------------------------------------------------------------------
// The size curve: log(mcap) = a + b * log(tvl) + offset[category], offsets
// shrunk toward zero with prior strength OFFSET_PRIOR. Solved by alternating
// least squares (closed form for the line given the offsets, shrunk means
// for the offsets given the line) for a fixed number of rounds, so the fit
// is a pure function of the peer set.
// ---------------------------------------------------------------------------

export interface Fit {
  a: number;
  b: number;
  offsets: Map<string, number>;
  n: number;
  withOffsets: boolean;
}

function catKey(p: ProtocolRec): string {
  return p.category === null ? "(uncategorised)" : p.category;
}

export function fitCurve(peers: ProtocolRec[], withOffsets: boolean): Fit {
  const xs = peers.map((p) => Math.log(p.tvl_usd));
  const ys = peers.map((p) => Math.log(p.mcap_usd as number));
  const cats = peers.map(catKey);
  const offsets = new Map<string, number>();
  let a = 0;
  let b = 1;
  const ROUNDS = 200;
  for (let round = 0; round < ROUNDS; round++) {
    // Line given offsets: ordinary least squares of (y - off) on x.
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < peers.length; i++) {
      sx += xs[i];
      sy += ys[i] - (withOffsets ? offsets.get(cats[i]) ?? 0 : 0);
    }
    const mx = sx / peers.length;
    const my = sy / peers.length;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < peers.length; i++) {
      const dx = xs[i] - mx;
      sxy += dx * (ys[i] - (withOffsets ? offsets.get(cats[i]) ?? 0 : 0) - my);
      sxx += dx * dx;
    }
    b = sxx > 0 ? sxy / sxx : 1;
    a = my - b * mx;
    if (!withOffsets) break;
    // Offsets given the line: shrunk mean residual per category.
    const sums = new Map<string, number>();
    const counts = new Map<string, number>();
    for (let i = 0; i < peers.length; i++) {
      const r = ys[i] - a - b * xs[i];
      sums.set(cats[i], (sums.get(cats[i]) ?? 0) + r);
      counts.set(cats[i], (counts.get(cats[i]) ?? 0) + 1);
    }
    offsets.clear();
    for (const [c, s] of sums) {
      offsets.set(c, s / ((counts.get(c) as number) + OFFSET_PRIOR));
    }
  }
  return { a, b, offsets, n: peers.length, withOffsets };
}

export function curveBase(fit: Fit, tvl: number): number {
  return Math.exp(fit.a + fit.b * Math.log(tvl));
}

export function categoryFactor(fit: Fit, p: ProtocolRec): number {
  if (!fit.withOffsets) return 1;
  return Math.exp(fit.offsets.get(catKey(p)) ?? 0);
}

// ---------------------------------------------------------------------------
// The three tilts, each a pure function of the protocol's own record.
// ---------------------------------------------------------------------------

export function momentumTilt(p: ProtocolRec): number {
  if (p.change_7d === null) return 1;
  const g = Math.min(MOMENTUM_MAX, Math.max(MOMENTUM_MIN, p.change_7d / 100));
  return 1 + MOMENTUM_RATE * g;
}

export function maturityTilt(p: ProtocolRec, asOf: string): number {
  const age = ageDays(p, asOf);
  if (age < 0) return 1; // no listing date: exactly 1.0, stated on Method
  return MATURITY_CAP - (MATURITY_CAP - MATURITY_FLOOR) * Math.exp(-age / MATURITY_TAU_DAYS);
}

export function breadthTilt(p: ProtocolRec): number {
  const extra = Math.min(Math.max(p.chains.length - 1, 0), BREADTH_MAX_EXTRA);
  return 1 + BREADTH_PER_CHAIN * extra;
}

export interface TiltSwitches {
  momentum: boolean;
  maturity: boolean;
  breadth: boolean;
}
export const ALL_TILTS: TiltSwitches = { momentum: true, maturity: true, breadth: true };
export const NO_TILTS: TiltSwitches = { momentum: false, maturity: false, breadth: false };

// The official price. The printed decomposition multiplies out to exactly
// this figure: the base is rounded to cents and each factor to 4 decimals
// BEFORE the product is taken, and the dashboard shows those same rounded
// factors, so a reader (or the page itself) recomputing the product lands
// on the same dollar.
export interface Decomposition {
  value: number;
  base: number;
  catFactor: number;
  momentum: number;
  maturity: number;
  breadth: number;
}

export function priceWith(
  fit: Fit,
  p: ProtocolRec,
  asOf: string,
  tilts: TiltSwitches,
): Decomposition {
  const base = roundTo(curveBase(fit, p.tvl_usd), 2);
  const catFactor = roundTo(categoryFactor(fit, p), 4);
  const momentum = roundTo(tilts.momentum ? momentumTilt(p) : 1, 4);
  const maturity = roundTo(tilts.maturity ? maturityTilt(p, asOf) : 1, 4);
  const breadth = roundTo(tilts.breadth ? breadthTilt(p) : 1, 4);
  const value = Math.max(1, Math.round(base * catFactor * momentum * maturity * breadth));
  return { value, base, catFactor, momentum, maturity, breadth };
}

// ---------------------------------------------------------------------------
// Backtest validation. House protocol: every comparison refits on the fit
// side only, prices the test side from its own records, and scores the
// median multiplicative miss, exp(median |log(pred / actual)|), with the
// shares of peers priced within 2x and within 3x alongside.
// ---------------------------------------------------------------------------

export interface Score {
  n: number;
  medianMiss: number;
  within2: number;
  within3: number;
}

export function scorePredictions(preds: number[], actuals: number[]): Score {
  const errs = preds.map((v, i) => Math.abs(Math.log(v / actuals[i])));
  const med = median(errs);
  let w2 = 0;
  let w3 = 0;
  for (const e of errs) {
    if (e <= Math.log(2)) w2++;
    if (e <= Math.log(3)) w3++;
  }
  return {
    n: preds.length,
    medianMiss: Math.exp(med),
    within2: preds.length ? w2 / preds.length : 0,
    within3: preds.length ? w3 / preds.length : 0,
  };
}

export type Variant = "flat" | "curve" | "curveCat" | "full" | "noMom" | "noMat" | "noBre";

export function priceVariant(
  fitPeers: ProtocolRec[],
  p: ProtocolRec,
  asOf: string,
  variant: Variant,
): number {
  if (variant === "flat") {
    const ratios = fitPeers.map((q) => (q.mcap_usd as number) / q.tvl_usd);
    return Math.max(1, Math.round(p.tvl_usd * median(ratios)));
  }
  const fit = fitCurve(fitPeers, variant !== "curve");
  const tilts: TiltSwitches =
    variant === "full"
      ? ALL_TILTS
      : variant === "noMom"
        ? { momentum: false, maturity: true, breadth: true }
        : variant === "noMat"
          ? { momentum: true, maturity: false, breadth: true }
          : variant === "noBre"
            ? { momentum: true, maturity: true, breadth: false }
            : NO_TILTS;
  return priceWith(fit, p, asOf, tilts).value;
}

function cleanOf(peers: ProtocolRec[]): ProtocolRec[] {
  return peers.filter(
    (p) => !(p.category !== null && FIT_EXCLUDED_CATEGORIES.includes(p.category)),
  );
}

// Leave-one-out predictions over a peer set: each peer is priced by a fit
// that never saw it. The fit side is cleaned (CEX/Chain removed) for every
// variant, which is the round-4 change; the held-out peer itself is always
// priced. Fits are computed once per held-out peer and shared across
// variants, so the whole ladder costs two fits per peer.
export function looPredictions(
  peers: ProtocolRec[],
  asOf: string,
  variants: Variant[],
): Map<Variant, number[]> {
  const preds = new Map<Variant, number[]>();
  for (const v of variants) preds.set(v, []);
  for (let i = 0; i < peers.length; i++) {
    const rest = cleanOf(peers.filter((_, j) => j !== i));
    const fitOff = fitCurve(rest, false);
    const fitOn = fitCurve(rest, true);
    const flatPred = Math.max(
      1,
      Math.round(peers[i].tvl_usd * median(rest.map((q) => (q.mcap_usd as number) / q.tvl_usd))),
    );
    for (const v of variants) {
      let value: number;
      if (v === "flat") value = flatPred;
      else if (v === "curve") value = priceWith(fitOff, peers[i], asOf, NO_TILTS).value;
      else if (v === "curveCat") value = priceWith(fitOn, peers[i], asOf, NO_TILTS).value;
      else {
        const tilts: TiltSwitches =
          v === "full"
            ? ALL_TILTS
            : v === "noMom"
              ? { momentum: false, maturity: true, breadth: true }
              : v === "noMat"
                ? { momentum: true, maturity: false, breadth: true }
                : { momentum: true, maturity: true, breadth: false };
        value = priceWith(fitOn, peers[i], asOf, tilts).value;
      }
      (preds.get(v) as number[]).push(value);
    }
  }
  return preds;
}

export function looScores(
  peers: ProtocolRec[],
  asOf: string,
  variants: Variant[],
): Map<Variant, Score> {
  const preds = looPredictions(peers, asOf, variants);
  const actuals = peers.map((p) => p.mcap_usd as number);
  const out = new Map<Variant, Score>();
  for (const v of variants) out.set(v, scorePredictions(preds.get(v) as number[], actuals));
  return out;
}

// A two-way split: fit on one side (cleaned), price the other side whole.
export function splitScore(
  fitSide: ProtocolRec[],
  testSide: ProtocolRec[],
  asOf: string,
  variant: Variant,
): Score {
  const fitPeers = cleanOf(fitSide);
  const preds = testSide.map((p) => priceVariant(fitPeers, p, asOf, variant));
  return scorePredictions(preds, testSide.map((p) => p.mcap_usd as number));
}

export function slugParity(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (Math.imul(h, 31) + slug.charCodeAt(i)) | 0;
  return Math.abs(h) % 2;
}

export function spearman(xs: number[], ys: number[]): number {
  const rank = (vs: number[]): number[] => {
    const order = vs.map((v, i) => [v, i] as [number, number]).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(vs.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[order[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (rx[i] - mx) * (ry[i] - my);
    vx += (rx[i] - mx) ** 2;
    vy += (ry[i] - my) ** 2;
  }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
}

export interface Validation {
  looFull128: Score;
  looCurveCat128: Score;
  looCurve128: Score;
  looFlat128: Score;
  looFull118: Score;
  looNoMom: Score;
  looNoMat: Score;
  looNoBre: Score;
  timeFull: Score;
  timeCurveCat: Score;
  timeNoMom: Score;
  timeNoMat: Score;
  timeNoBre: Score;
  hashA: Score;
  hashB: Score;
  ageSplit: Score;
  spearmanLoo: number;
  top20Overlap: number;
}

export function runValidation(snap: Snapshot, uni: Universe): Validation {
  const asOf = snap.as_of;
  const peers = uni.pricedPeers;
  const allVariants: Variant[] = ["flat", "curve", "curveCat", "full", "noMom", "noMat", "noBre"];
  const looPredsAll = looPredictions(peers, asOf, allVariants);
  const actuals = peers.map((p) => p.mcap_usd as number);
  const ladder = new Map<Variant, Score>();
  for (const v of allVariants) {
    ladder.set(v, scorePredictions(looPredsAll.get(v) as number[], actuals));
  }
  const loo118 = looScores(uni.cleanedPeers, asOf, ["full"]);
  const dated = peers.filter((p) => p.listed_at !== null);
  const timeFit = dated.filter((p) => (p.listed_at as string) < "2024-01-01");
  const timeTest = dated.filter((p) => (p.listed_at as string) >= "2024-01-01");
  const even = peers.filter((p) => slugParity(p.slug) === 0);
  const odd = peers.filter((p) => slugParity(p.slug) === 1);
  const ageFit = dated.filter((p) => (p.listed_at as string) < "2023-01-01");
  const ageTest = dated.filter((p) => (p.listed_at as string) >= "2023-01-01");
  // Rank quality from the full model's leave-one-out predictions.
  const looPreds = looPredsAll.get("full") as number[];
  const topPred = new Set(
    peers.map((p, i) => [looPreds[i], p.slug] as [number, string]).sort((x, y) => y[0] - x[0]).slice(0, 20).map((x) => x[1]),
  );
  const topActual = new Set(
    peers.map((p) => [p.mcap_usd as number, p.slug] as [number, string]).sort((x, y) => y[0] - x[0]).slice(0, 20).map((x) => x[1]),
  );
  let overlap = 0;
  for (const s of topPred) if (topActual.has(s)) overlap++;
  return {
    looFull128: ladder.get("full") as Score,
    looCurveCat128: ladder.get("curveCat") as Score,
    looCurve128: ladder.get("curve") as Score,
    looFlat128: ladder.get("flat") as Score,
    looFull118: loo118.get("full") as Score,
    looNoMom: ladder.get("noMom") as Score,
    looNoMat: ladder.get("noMat") as Score,
    looNoBre: ladder.get("noBre") as Score,
    timeFull: splitScore(timeFit, timeTest, asOf, "full"),
    timeCurveCat: splitScore(timeFit, timeTest, asOf, "curveCat"),
    timeNoMom: splitScore(timeFit, timeTest, asOf, "noMom"),
    timeNoMat: splitScore(timeFit, timeTest, asOf, "noMat"),
    timeNoBre: splitScore(timeFit, timeTest, asOf, "noBre"),
    hashA: splitScore(odd, even, asOf, "full"),
    hashB: splitScore(even, odd, asOf, "full"),
    ageSplit: splitScore(ageFit, ageTest, asOf, "full"),
    spearmanLoo: spearman(looPreds, actuals),
    top20Overlap: overlap,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap uncertainty: resample the cleaned fit peers with replacement,
// refit, reprice every ranked row. The spread of a row's values across
// refits is its P25-P75 band; the spread of its ranks is its rank range.
// Seeded, so the bands are a pure function of the snapshot.
// ---------------------------------------------------------------------------

export interface Band {
  p25: number;
  p75: number;
  rankLo: number;
  rankHi: number;
}

export function bootstrapBands(
  fitPeers: ProtocolRec[],
  rows: ProtocolRec[],
  asOf: string,
): Map<string, Band> {
  const rand = mulberry32(BOOTSTRAP_SEED);
  const values = new Map<string, number[]>();
  const ranks = new Map<string, number[]>();
  for (const r of rows) {
    values.set(r.slug, []);
    ranks.set(r.slug, []);
  }
  for (let rep = 0; rep < BOOTSTRAP_REPS; rep++) {
    const sample: ProtocolRec[] = [];
    for (let i = 0; i < fitPeers.length; i++) {
      sample.push(fitPeers[Math.floor(rand() * fitPeers.length)]);
    }
    const fit = fitCurve(sample, true);
    const priced = rows.map((r) => ({
      slug: r.slug,
      value: priceWith(fit, r, asOf, ALL_TILTS).value,
    }));
    const ordered = [...priced].sort((x, y) => y.value - x.value || (x.slug < y.slug ? -1 : 1));
    ordered.forEach((entry, idx) => {
      (ranks.get(entry.slug) as number[]).push(idx + 1);
    });
    for (const entry of priced) (values.get(entry.slug) as number[]).push(entry.value);
  }
  const out = new Map<string, Band>();
  for (const r of rows) {
    const vs = [...(values.get(r.slug) as number[])].sort((x, y) => x - y);
    const rs = [...(ranks.get(r.slug) as number[])].sort((x, y) => x - y);
    out.set(r.slug, {
      p25: Math.round(quantile(vs, 0.25)),
      p75: Math.round(quantile(vs, 0.75)),
      rankLo: Math.round(quantile(rs, 0.1)),
      rankHi: Math.round(quantile(rs, 0.9)),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Farm economics, netted in dollars. The farmer's expected slice of a launch
// is the airdrop share of implied value times the fraction of the pool the
// ticket buys (ticket / TVL). Against it stand the plan's fees and the
// interest forgone while the ticket is locked. Verdicts:
//   Farm — pays even at the band low (P25 value).
//   Thin — pays at the point estimate only.
//   Skip — the slice does not cover costs even at the point estimate.
// ---------------------------------------------------------------------------

export type Verdict = "Farm" | "Thin" | "Skip";

export interface Economics {
  ticket: number;
  fees: number;
  interest: number;
  grossPoint: number;
  grossLow: number;
  netPoint: number;
  netLow: number;
  breakevenChance: number; // (fees + interest) / grossPoint, as a fraction
  verdict: Verdict;
}

export function ticketFor(tvl: number): number {
  const raw = Math.round(tvl * TICKET_FRACTION * 10) / 10;
  return Math.min(TICKET_MAX, Math.max(TICKET_MIN, raw));
}

const L2_CHAINS = new Set([
  "Arbitrum", "Optimism", "Base", "zkSync Era", "Linea", "Scroll", "Mantle",
  "Blast", "Mode", "Taiko", "Zora", "Polygon zkEVM", "Starknet", "Manta",
  "Fraxtal", "World Chain", "Sonic", "Berachain", "Monad",
]);
const CHEAP_L1 = new Map<string, number>([
  ["Solana", 0.25],
  ["BSC", 0.4],
  ["Polygon", 0.1],
  ["Avalanche", 0.8],
  ["Near", 0.1],
  ["Sui", 0.1],
  ["Aptos", 0.1],
  ["Tron", 0.5],
  ["Fantom", 0.1],
]);

export function homeChain(p: ProtocolRec): string {
  return p.chains.length > 0 ? p.chains[0] : "Ethereum";
}

export function gasPerAction(chain: string): number {
  if (chain === "Ethereum") return 12;
  if (L2_CHAINS.has(chain)) return 0.6;
  const cheap = CHEAP_L1.get(chain);
  if (cheap !== undefined) return cheap;
  return 1.5;
}

export function bridgeFee(chain: string): number {
  return chain === "Ethereum" ? 0 : 18;
}

export function economicsFor(
  p: ProtocolRec,
  value: number,
  bandLow: number,
  planFees: number,
  share: number,
): Economics {
  const ticket = ticketFor(p.tvl_usd);
  const interest = roundTo(ticket * FORGONE_APR * (HOLD_DAYS / 365), 2);
  const grossPoint = (share * value * ticket) / p.tvl_usd;
  const grossLow = (share * bandLow * ticket) / p.tvl_usd;
  const netPoint = grossPoint - planFees - interest;
  const netLow = grossLow - planFees - interest;
  const verdict: Verdict = netLow > 0 ? "Farm" : netPoint > 0 ? "Thin" : "Skip";
  return {
    ticket,
    fees: planFees,
    interest,
    grossPoint: roundTo(grossPoint, 2),
    grossLow: roundTo(grossLow, 2),
    netPoint: roundTo(netPoint, 2),
    netLow: roundTo(netLow, 2),
    breakevenChance: grossPoint > 0 ? (planFees + interest) / grossPoint : Infinity,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// The farm plan: seven day-stamped steps, the same template family for every
// row, specialised by the protocol's category and home chain. Fees and
// minutes are part of the template arithmetic, so the plan's stated totals
// are exactly the fees the economics are netted against.
// ---------------------------------------------------------------------------

export interface PlanStep {
  day: string;
  text: string;
  fee: number;
  minutes: number;
}

export interface Plan {
  steps: PlanStep[];
  totalFee: number;
  totalMinutes: number;
  stopLevel: number;
}

function money(x: number): string {
  return "$" + Math.round(x).toLocaleString("en-US");
}

function coreActions(category: string | null): [string, string] {
  switch (category) {
    case "Dexs":
      return [
        "swap a basket across the five most-traded pairs",
        "add the rest as liquidity in the busiest pair and leave it working",
      ];
    case "Lending":
      return [
        "supply stablecoins as collateral",
        "borrow a small amount against the position and re-supply it, building a borrow record",
      ];
    case "Yield":
    case "Yield Aggregator":
      return [
        "deposit into the flagship vault",
        "split the rest across two more vaults so the activity is not one deposit",
      ];
    case "CDP":
      return [
        "open a vault and mint stablecoins against the collateral",
        "repay part of the mint and mint again, keeping the position active",
      ];
    case "Derivatives":
      return [
        "trade small size across the main perpetual pairs",
        "keep a small hedged position open and adjust it at each check",
      ];
    case "RWA":
      return [
        "complete onboarding and subscribe to the flagship product",
        "add the rest to a second product on the platform",
      ];
    case "Launchpad":
      return [
        "register for the next sale and stake toward it",
        "join the sale queue with the rest of the ticket",
      ];
    case "NFT Marketplace":
      return [
        "buy and re-list floor items in the busiest collections",
        "place collection offers with the rest of the ticket",
      ];
    case "Payments":
      return [
        "route real transfers through the protocol",
        "hold a working balance and transact with it every week",
      ];
    default:
      return [
        "use the protocol's core product with real funds",
        "repeat the core action so the record is a pattern, not a single touch",
      ];
  }
}

export function planFor(p: ProtocolRec, ticket: number): Plan {
  const chain = homeChain(p);
  const gas = gasPerAction(chain);
  const bridge = bridgeFee(chain);
  const [actA, actB] = coreActions(p.category);
  const stopLevel = Math.round(p.tvl_usd * 0.9);
  const steps: PlanStep[] = [
    {
      day: "Day 0",
      text:
        "Set up: create a fresh wallet, fund it on " + chain + " with " + money(ticket) +
        " in stablecoins" + (bridge > 0 ? ", bridging from Ethereum" : "") +
        ", and record the protocol's TVL today (" + money(p.tvl_usd) + ") as the entry mark.",
      fee: roundTo(bridge + gas, 2),
      minutes: 45,
    },
    {
      day: "Day 1",
      text: "Core move: " + actA + " with 60% of the ticket (" + money(ticket * 0.6) + ").",
      fee: roundTo(2 * gas, 2),
      minutes: 30,
    },
    {
      day: "Day 3",
      text: "Second leg: " + actB + " with the remaining 40% (" + money(ticket * 0.4) + ").",
      fee: roundTo(2 * gas, 2),
      minutes: 25,
    },
    {
      day: "Days 7-77",
      text:
        "Weekly loop: repeat the core action and re-check the position once a week for eleven weeks; " +
        "keep every transaction real and sized like the first week's.",
      fee: roundTo(11 * gas, 2),
      minutes: 165,
    },
    {
      day: "Day 42",
      text:
        "Midway re-read: compare the protocol's TVL with the entry mark. If it has fallen below the stop level (" +
        money(stopLevel) + "), exit early instead of farming a shrinking pool.",
      fee: roundTo(gas, 2),
      minutes: 20,
    },
    {
      day: "Day 83",
      text:
        "Stop check: if TVL is under " + money(stopLevel) + " (10% under the entry mark), the plan ends here — " +
        "withdraw on Day 84 regardless of any launch rumour.",
      fee: 0,
      minutes: 10,
    },
    {
      day: "Day 84",
      text:
        "Withdraw: unwind the position in full" + (bridge > 0 ? ", bridge the proceeds back to Ethereum," : "") +
        " and record the final balance against the " + money(ticket) + " ticket.",
      fee: roundTo(bridge > 0 ? 12 : 2 * gas, 2),
      minutes: 30,
    },
  ];
  const totalFee = roundTo(steps.reduce((s, x) => s + x.fee, 0), 2);
  const totalMinutes = steps.reduce((s, x) => s + x.minutes, 0);
  return { steps, totalFee, totalMinutes, stopLevel };
}

export function stepText(step: PlanStep): string {
  return (
    step.day + " — " + step.text +
    " (fees " + money(step.fee) + ", ~" + step.minutes + " min)"
  );
}
