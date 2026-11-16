// Launch Radar's model: one frozen snapshot of the protocol universe in, one ranked board out.
//
// The idea in one paragraph. A protocol that records no token has no price, but it does not stand
// alone: the same snapshot carries 144 protocols whose tokens already trade, and each of those pairs
// a market cap with a TVL. Version 3.0 FITS the market's answer instead of only tabulating it: a
// power-law size curve, ln(market cap) on ln(TVL), is regressed over the traded protocols, with a
// per-category offset shrunk toward zero in proportion to how few peers the category has. Size
// matters — a dollar of TVL in a $20M protocol is not priced like a dollar in a $2B one — and the
// curve is what carries that. The category-median model of version 2.1 is kept beside it, and the
// two are raced out of sample on every run: the comparables are split in half by a hash of their
// slugs, each model is built on one half alone and asked to price the other, and the dashboard
// prints both errors, so the model's claim is a measurement, not an assertion. The fitted value is
// then tilted by the protocol's own seven-day TVL momentum, by how long it has run with no token,
// and by how many chains it spans. Nothing is priced from a name: every number below is a function
// of the snapshot's ten fields, and the dashboard shows each row's arithmetic so a reader can
// check it.
//
// The board ranks pre-token candidates only. Protocols whose token already trades are never ranked:
// they are the evidence base (the comparables), shown apart with the market's own figures.

/** One protocol record: exactly the ten fields the sealed snapshot carries. */
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

/** The snapshot document as the house froze it. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** The model's constants, stated on the dashboard so the arithmetic is never a secret. */
export interface RadarConstants {
  /** A peer ratio is winsorized into [ratio_lo, ratio_hi] before any median is taken. */
  ratio_lo: number;
  ratio_hi: number;
  /** Prior strength of the market-wide median when a category's own median is shrunk toward it. */
  shrink_prior: number;
  /** Seven-day growth is clamped to [growth_lo, growth_hi] per cent before it tilts a value. */
  growth_lo: number;
  growth_hi: number;
  /** The momentum tilt: implied value moves this fraction of the clamped growth. */
  momentum_weight: number;
  /** Maturity runs from maturity_base (listed today) toward maturity_base + maturity_gain. */
  maturity_base: number;
  maturity_gain: number;
  /** The maturity curve's time constant, in days: at this age the gain is ~63% earned. */
  maturity_tau_days: number;
  /** Each chain past the first adds this fraction, for at most breadth_cap extra chains. */
  breadth_per_chain: number;
  breadth_cap: number;
}

export const CONSTANTS: RadarConstants = {
  ratio_lo: 0.01,
  ratio_hi: 4,
  shrink_prior: 6,
  growth_lo: -60,
  growth_hi: 120,
  momentum_weight: 0.4,
  maturity_base: 0.75,
  maturity_gain: 0.45,
  maturity_tau_days: 540,
  breadth_per_chain: 0.02,
  breadth_cap: 10,
};

/** The model's version label, printed on the dashboard and in board.json. */
export const MODEL_VERSION = 'curve-4.0';

/** Why a snapshot cannot be scored. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Whole days from the listing date to the snapshot date; null when either is unusable. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** The median of a non-empty list, computed on a sorted copy so callers keep their order. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

// ------------------------------------------------------------ the comparables

/** A protocol whose token already trades and whose record carries a market cap: a priced peer. */
export interface Comparable {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  /** mcap / TVL after winsorizing into the model's band. */
  ratio: number;
  change_7d: number | null;
  listed_at: string | null;
  n_chains: number;
}

/** What the market pays for a dollar of TVL in one category, as this snapshot records it. */
export interface CategoryRate {
  category: string;
  /** How many priced peers the category has in the snapshot. */
  peers: number;
  /** The peers' median ratio, before shrinkage. */
  median_ratio: number;
  /** The multiple the model actually applies: the median shrunk toward the market-wide median. */
  multiple: number;
}

/** The whole evidence base: every priced peer, the market-wide median, and each category's rate. */
export interface MarketRates {
  global_median: number;
  comparables: Comparable[];
  by_category: Map<string, CategoryRate>;
}

/** A protocol records no token when all three token fields are empty. */
export function recordsNoToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Read the market's rates off the snapshot. Only protocols with a market cap and a positive TVL can
 * price a peer; each ratio is winsorized so a single absurd record (a famous name on a sliver of
 * tracked TVL) cannot carry a whole category. A category's multiple is its median pulled toward the
 * market-wide median with prior strength CONSTANTS.shrink_prior: six phantom peers at the market
 * rate, so a category with one peer stays near the market and a category with fifteen speaks for
 * itself. A category with no priced peer at all trades at the market-wide median.
 */
export function marketRates(snapshot: Snapshot, k: RadarConstants = CONSTANTS): MarketRates {
  const comparables: Comparable[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    comparables.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      ratio: round4(clamp(p.mcap_usd / p.tvl_usd, k.ratio_lo, k.ratio_hi)),
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      n_chains: p.chains.length,
    });
  }
  const globalMedian = comparables.length > 0 ? median(comparables.map((c) => c.ratio)) : 0;
  const ratiosByCategory = new Map<string, number[]>();
  for (const c of comparables) {
    const key = c.category ?? '';
    const list = ratiosByCategory.get(key);
    if (list === undefined) ratiosByCategory.set(key, [c.ratio]);
    else list.push(c.ratio);
  }
  const byCategory = new Map<string, CategoryRate>();
  for (const [category, ratios] of ratiosByCategory) {
    const med = median(ratios);
    const multiple = (ratios.length * med + k.shrink_prior * globalMedian) / (ratios.length + k.shrink_prior);
    byCategory.set(category, { category, peers: ratios.length, median_ratio: round4(med), multiple: round4(multiple) });
  }
  return { global_median: round4(globalMedian), comparables, by_category: byCategory };
}

/** The rate a category trades at; a category with no priced peer gets the market-wide median. */
export function rateFor(rates: MarketRates, category: string | null): CategoryRate {
  return (
    rates.by_category.get(category ?? '') ?? {
      category: category ?? '',
      peers: 0,
      median_ratio: rates.global_median,
      multiple: rates.global_median,
    }
  );
}

// ------------------------------------------------------------ the fitted size curve

/**
 * The fitted model: ln(market cap) = intercept + slope × ln(TVL) + a per-category offset.
 * The offsets are the categories' mean residuals after the curve, each shrunk toward zero by
 * n / (n + shrink_prior), the same prior strength the median model uses, so a category with two
 * peers whispers and one with twenty speaks. A category the fit never saw prices on the curve
 * alone (offset 0).
 */
export interface FittedCurve {
  intercept: number;
  slope: number;
  /** Category → shrunk log offset; an absent category has offset 0. */
  offsets: Map<string, number>;
  /** How many traded protocols the fit was built on. */
  peers: number;
}

/** Least squares of ln(mcap) on ln(TVL) over the given comparables, plus shrunk category offsets. */
export function fitCurve(comparables: Comparable[], k: RadarConstants = CONSTANTS): FittedCurve {
  const pts = comparables.filter((c) => c.tvl_usd > 0 && c.mcap_usd > 0);
  if (pts.length === 0) return { intercept: 0, slope: 1, offsets: new Map(), peers: 0 };
  const xs = pts.map((c) => Math.log(c.tvl_usd));
  const ys = pts.map((c) => Math.log(c.mcap_usd));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const slope = sxx > 0 ? sxy / sxx : 1;
  const intercept = my - slope * mx;
  const residByCategory = new Map<string, number[]>();
  for (let i = 0; i < pts.length; i++) {
    const key = pts[i]!.category ?? '';
    const resid = ys[i]! - (intercept + slope * xs[i]!);
    const list = residByCategory.get(key);
    if (list === undefined) residByCategory.set(key, [resid]);
    else list.push(resid);
  }
  const offsets = new Map<string, number>();
  for (const [category, resids] of residByCategory) {
    const mean = resids.reduce((a, b) => a + b, 0) / resids.length;
    offsets.set(category, round4(mean * (resids.length / (resids.length + k.shrink_prior))));
  }
  return { intercept: round4(intercept), slope: round4(slope), offsets, peers: pts.length };
}

/** The curve's price for one TVL in one category, before the momentum/maturity/breadth tilts. */
export function curveValue(fit: FittedCurve, tvl: number, category: string | null): number {
  if (tvl <= 0) return 0;
  const offset = fit.offsets.get(category ?? '') ?? 0;
  return Math.exp(fit.intercept + fit.slope * Math.log(tvl) + offset);
}

/**
 * Categories whose tokens are not priced off the protocol's own TVL, kept out of the FIT (they stay
 * in the traded view and in the median model): an exchange's token prices the exchange's order flow,
 * not the TVL its record happens to track, and a chain's token prices the whole network. Fitting the
 * size curve through them bends it toward prices no launch candidate could inherit.
 */
export const FIT_EXCLUDED_CATEGORIES = new Set(['CEX', 'Chain']);

/** The comparables the size curve is actually fitted on: positively priced, minus the exclusions above. */
export function fitComparables(comparables: Comparable[]): Comparable[] {
  return comparables.filter((c) => c.mcap_usd > 0 && c.tvl_usd > 0 && !FIT_EXCLUDED_CATEGORIES.has(c.category ?? ''));
}

// ------------------------------------------------------------ the out-of-sample race

/** One model's out-of-sample showing: how wrong its prices were on protocols it never fitted. */
export interface ModelRaceEntry {
  /** Test protocols priced. */
  n: number;
  /** Median absolute log error, as a ×/÷ factor: 2.0 means the typical price was off twofold. */
  median_factor: number;
  /** Share of test prices that landed within a factor of two of the recorded market cap. */
  within_2x: number;
}

/** The race's result, printed on the dashboard: the fitted curve against the median model. */
export interface ModelValidation {
  fit_n: number;
  test_n: number;
  curve: ModelRaceEntry;
  median_model: ModelRaceEntry;
}

/** A stable split of a slug into the fit half or the test half: FNV-1a over the slug, parity bit. */
function inFitHalf(slug: string): boolean {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2 === 0;
}

/** The three tilts, shared by both models so the race isolates the pricing core, not the trimmings. */
function tilts(p: Protocol, asOf: string, k: RadarConstants): number {
  const age = ageInDays(asOf, p.listed_at);
  const growthPct = clamp(p.change_7d ?? 0, k.growth_lo, k.growth_hi);
  const momentum = 1 + (growthPct / 100) * k.momentum_weight;
  const maturity = age === null ? 1 : k.maturity_base + k.maturity_gain * (1 - Math.exp(-age / k.maturity_tau_days));
  const breadth = 1 + k.breadth_per_chain * Math.min(Math.max(p.chains.length - 1, 0), k.breadth_cap);
  return momentum * maturity * breadth;
}

function raceEntry(errors: number[]): ModelRaceEntry {
  if (errors.length === 0) return { n: 0, median_factor: 0, within_2x: 0 };
  const med = median(errors);
  const within = errors.filter((e) => e <= Math.log(2)).length / errors.length;
  return { n: errors.length, median_factor: round4(Math.exp(med)), within_2x: round4(within) };
}

/**
 * Race the two pricing cores out of sample. The comparables split by slug hash into a fit half and
 * a test half; each model is built on the fit half alone (median rates with shrinkage, or the
 * fitted curve), then prices every test-half protocol from its TVL and category, with the same
 * tilts applied to both. The error is |ln(predicted / recorded)|. Deterministic: the split and
 * the fits are pure functions of the snapshot.
 */
export function validateModels(snapshot: Snapshot, k: RadarConstants = CONSTANTS): ModelValidation {
  const all = marketRates(snapshot, k).comparables;
  const fitHalf = all.filter((c) => inFitHalf(c.slug));
  const testHalf = all.filter((c) => !inFitHalf(c.slug));
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const fitRates: MarketRates = marketRates({ ...snapshot, protocols: snapshot.protocols.filter((p) => fitHalf.some((c) => c.slug === p.slug)) }, k);
  const fit = fitCurve(fitHalf, k);
  const curveErrors: number[] = [];
  const medianErrors: number[] = [];
  for (const c of testHalf) {
    const p = bySlug.get(c.slug);
    if (p === undefined) continue;
    const t = tilts(p, snapshot.as_of, k);
    const curvePred = curveValue(fit, p.tvl_usd, p.category) * t;
    const medianPred = p.tvl_usd * rateFor(fitRates, p.category).multiple * t;
    if (curvePred > 0) curveErrors.push(Math.abs(Math.log(curvePred / c.mcap_usd)));
    if (medianPred > 0) medianErrors.push(Math.abs(Math.log(medianPred / c.mcap_usd)));
  }
  return { fit_n: fitHalf.length, test_n: testHalf.length, curve: raceEntry(curveErrors), median_model: raceEntry(medianErrors) };
}

// ------------------------------------------------------------ the v4 validation suite

/** One model's out-of-sample showing in the wider suite: both of the race's metrics, plus within-3x. */
export interface ValidationRow {
  model: string;
  n: number;
  median_factor: number;
  within_2x: number;
  within_3x: number;
}

/** Everything the dashboard's method view prints: leave-one-out, a time split, both hash splits, an age split. */
export interface ValidationSuite {
  loo: ValidationRow[];
  time_split: { fit_n: number; test_n: number; rows: ValidationRow[] };
  hash_a: ValidationRow[];
  hash_b: ValidationRow[];
  age_split: { young: ValidationRow; old: ValidationRow };
}

function metricsOf(errors: number[], model: string): ValidationRow {
  if (errors.length === 0) return { model, n: 0, median_factor: 0, within_2x: 0, within_3x: 0 };
  return {
    model,
    n: errors.length,
    median_factor: round4(Math.exp(median(errors))),
    within_2x: round4(errors.filter((e) => e <= Math.log(2)).length / errors.length),
    within_3x: round4(errors.filter((e) => e <= Math.log(3)).length / errors.length),
  };
}

/** A pricing core under test: build it on a fit set of comparables, then price any protocol. */
type CoreBuilder = (fitSet: Comparable[]) => (p: Protocol) => number;

function coreFlat(fitSet: Comparable[]): (p: Protocol) => number {
  const med = fitSet.length > 0 ? median(fitSet.map((c) => c.ratio)) : 0;
  return (p) => p.tvl_usd * med;
}
function coreCurve(fitSet: Comparable[], offsets: boolean, withTilts: boolean, asOf: string, k: RadarConstants): (p: Protocol) => number {
  const fit = fitCurve(fitSet, k);
  const use: FittedCurve = offsets ? fit : { intercept: fit.intercept, slope: fit.slope, offsets: new Map(), peers: fit.peers };
  return (p) => curveValue(use, p.tvl_usd, p.category) * (withTilts ? tilts(p, asOf, k) : 1);
}

/**
 * The wider battery, all of it on the cleaned comparables (positively priced, no CEX, no Chain):
 * leave-one-out for the whole ladder from a flat multiple to the full model; a time split that fits
 * only tokens listed before 2024 and prices the ones listed since; the slug-hash split in both
 * directions, the full model against the version-3.0 recipe (fit on every priced peer, CEX and
 * Chain included); and the full model's leave-one-out errors split by the test token's age.
 */
export function validateV3(snapshot: Snapshot, k: RadarConstants = CONSTANTS): ValidationSuite {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const all = marketRates(snapshot, k).comparables;
  const priced = all.filter((c) => c.mcap_usd > 0 && c.tvl_usd > 0);
  const clean = fitComparables(all);
  const asOf = snapshot.as_of;
  const full: CoreBuilder = (fitSet) => coreCurve(fitSet, true, true, asOf, k);
  const v3Style: CoreBuilder = (fitSet) => {
    void fitSet;
    return coreCurve(priced, true, true, asOf, k);
  };
  void v3Style;
  const ladder: { name: string; build: CoreBuilder }[] = [
    { name: 'flat multiple', build: (f) => coreFlat(f) },
    { name: 'size curve', build: (f) => coreCurve(f, false, false, asOf, k) },
    { name: 'curve + category', build: (f) => coreCurve(f, true, false, asOf, k) },
    { name: 'full model (curve + category + tilts)', build: (f) => coreCurve(f, true, true, asOf, k) },
  ];
  const err = (build: CoreBuilder, fitSet: Comparable[], testSet: Comparable[]): number[] => {
    const price = build(fitSet);
    const out: number[] = [];
    for (const c of testSet) {
      const p = bySlug.get(c.slug);
      if (p === undefined) continue;
      const pred = price(p);
      if (pred > 0 && c.mcap_usd > 0) out.push(Math.abs(Math.log(pred / c.mcap_usd)));
    }
    return out;
  };
  // Leave-one-out over the clean set, for every rung of the ladder.
  const loo: ValidationRow[] = ladder.map(({ name, build }) => {
    const errors: number[] = [];
    for (let i = 0; i < clean.length; i++) {
      const fitSet = clean.filter((_, j) => j !== i);
      errors.push(...err(build, fitSet, [clean[i]!]));
    }
    return metricsOf(errors, name);
  });
  // Age split of the full model's leave-one-out errors.
  const youngErr: number[] = [];
  const oldErr: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const age = ageInDays(asOf, clean[i]!.listed_at);
    const e = err(full, clean.filter((_, j) => j !== i), [clean[i]!]);
    if (age === null) continue;
    (age < 548 ? youngErr : oldErr).push(...e);
  }
  // Time split: fit the past, price the future.
  const past = clean.filter((c) => (c.listed_at ?? '9999') < '2024-01-01');
  const future = clean.filter((c) => (c.listed_at ?? '0000') >= '2024-01-01');
  const timeRows = ladder.map(({ name, build }) => metricsOf(err(build, past, future), name));
  // Hash splits in both directions: the full model fitted on the clean half, against the v3.0
  // recipe fitted on every priced peer in the same half.
  const hashRows = (fitHalfPriced: Comparable[], testHalfPriced: Comparable[]): ValidationRow[] => {
    const cleanFit = fitHalfPriced.filter((c) => clean.some((x) => x.slug === c.slug));
    const cleanTest = testHalfPriced.filter((c) => clean.some((x) => x.slug === c.slug));
    return [
      metricsOf(err(full, cleanFit, cleanTest), 'full model, clean fit'),
      metricsOf(err((f) => coreCurve(f, true, true, asOf, k), fitHalfPriced, cleanTest), 'v3.0 recipe, all priced peers'),
    ];
  };
  const hA = priced.filter((c) => inFitHalf(c.slug));
  const hB = priced.filter((c) => !inFitHalf(c.slug));
  return {
    loo,
    time_split: { fit_n: past.length, test_n: future.length, rows: timeRows },
    hash_a: hashRows(hA, hB),
    hash_b: hashRows(hB, hA),
    age_split: { young: metricsOf(youngErr, 'listed under 18 months ago'), old: metricsOf(oldErr, 'listed 18+ months ago') },
  };
}

// ------------------------------------------------------------ bootstrap bands

/** mulberry32: a tiny seeded generator, identical in Node and in the browser, so the bands reproduce. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One row's uncertainty: the value band and the rank range over bootstrap refits of the curve. */
export interface BandInfo {
  lo: number;
  hi: number;
  rank_lo: number;
  rank_hi: number;
}

const BOOTSTRAP_SEED = 0xc0ffee;
export const BOOTSTRAP_REPS = 200;

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(q * sortedAsc.length)));
  return sortedAsc[idx]!;
}

/**
 * Refit the curve 200 times on resamples (with replacement) of the cleaned comparables and re-price
 * the whole board each time. A row's band is the middle half of its refit prices; its rank range is
 * the P10-P90 of its refit ranks. The tilts are the row's own and do not move between refits: what
 * the band measures is the curve's uncertainty, which is the part the snapshot cannot settle.
 */
export function bootstrapBands(
  scored: { p: Protocol; s: ScoreBreakdown }[],
  cleanComps: Comparable[],
  k: RadarConstants = CONSTANTS,
  reps: number = BOOTSTRAP_REPS,
): Map<string, BandInfo> {
  const rng = mulberry32(BOOTSTRAP_SEED);
  const values = new Map<string, number[]>();
  const ranks = new Map<string, number[]>();
  for (const { p } of scored) {
    values.set(p.slug, []);
    ranks.set(p.slug, []);
  }
  for (let r = 0; r < reps; r++) {
    const sample: Comparable[] = [];
    for (let i = 0; i < cleanComps.length; i++) sample.push(cleanComps[Math.floor(rng() * cleanComps.length)]!);
    const fit = fitCurve(sample, k);
    const priced = scored.map(({ p, s }) => ({
      slug: p.slug,
      v: curveValue(fit, p.tvl_usd, p.category) * s.momentum_mult * s.maturity_mult * s.breadth_mult,
    }));
    priced.sort((a, b) => b.v - a.v || (a.slug < b.slug ? -1 : 1));
    priced.forEach((row, i) => {
      values.get(row.slug)!.push(row.v);
      ranks.get(row.slug)!.push(i + 1);
    });
  }
  const out = new Map<string, BandInfo>();
  for (const { p, s } of scored) {
    const vs = [...values.get(p.slug)!].sort((a, b) => a - b);
    const rs = [...ranks.get(p.slug)!].sort((a, b) => a - b);
    out.set(p.slug, {
      lo: Math.max(1, Math.round(quantile(vs, 0.25) || s.implied_value_usd)),
      hi: Math.max(1, Math.round(quantile(vs, 0.75) || s.implied_value_usd)),
      rank_lo: Math.round(quantile(rs, 0.1)),
      rank_hi: Math.round(quantile(rs, 0.9)),
    });
  }
  return out;
}

// ------------------------------------------------------------ who gets ranked

/** Categories that are conduits or wrappers of an asset that already trades, per the house's own watchlist reasoning. */
const CONDUIT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A name ending in a version marker is a later deployment of a protocol, not a new launch. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole words that mark a wrapped or staked product of someone else's asset. */
const WRAPPER_WORD = /\b(wrapped|staked|staking)\b/i;

/** Names that begin with an exchange's name are that exchange's product, not an independent launch. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Whether a pre-token protocol is a genuine launch candidate: not a conduit or wrapper of a token
 * that already trades, not a versioned redeployment, not an exchange's house product. This mirrors
 * the reasoning the house applied to its watchlist, applied here to the whole snapshot so the radar
 * can find candidates below the watchlist's floor. Watchlist slugs themselves are always ranked:
 * the board's coverage of them is the gate's row, never a judgement call.
 */
export function isCandidate(p: Protocol): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && CONDUIT_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPER_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return false;
  return true;
}

// ------------------------------------------------------------ scoring

/** One protocol's implied value, with every factor that produced it, for the detail view. */
export interface ScoreBreakdown {
  /** The category multiple applied (already shrunk toward the market median). */
  multiple: number;
  /** The category's own median peer ratio, before shrinkage. */
  category_median: number;
  /** How many priced peers the category has in the snapshot. */
  peers: number;
  /** The fitted curve's price for this protocol's TVL, as a multiple of that TVL. */
  curve_multiple: number;
  /** The category's shrunk log offset in the fitted curve (0 when the fit never saw it). */
  category_offset: number;
  /** The seven-day growth after clamping, in per cent. */
  growth_pct: number;
  momentum_mult: number;
  maturity_mult: number;
  breadth_mult: number;
  age_days: number | null;
  implied_value_usd: number;
}

/**
 * Score one candidate. Base value is the fitted size curve's price for the protocol's TVL in its
 * category; three tilts follow,
 * each from the protocol's own record: momentum (a week of growth is evidence a launch would meet a
 * larger protocol, a week of shrinkage the opposite, and the clamp keeps one wild week from ruling
 * the board), maturity (a protocol that has run for years at size with no token has more to launch
 * than one listed last month, with diminishing returns on age), and breadth (each extra chain is
 * another community a launch would reach). A protocol with no listing date gets a neutral maturity
 * of exactly 1: the model does not invent an age it was not given.
 */
export function score(p: Protocol, asOf: string, rates: MarketRates, fit: FittedCurve, k: RadarConstants = CONSTANTS): ScoreBreakdown {
  const rate = rateFor(rates, p.category);
  const age = ageInDays(asOf, p.listed_at);
  const growthPct = clamp(p.change_7d ?? 0, k.growth_lo, k.growth_hi);
  // Each factor is rounded to 4 decimals before it is applied, so the breakdown the dashboard
  // prints is the whole calculation: a reader multiplying the five printed numbers lands on the
  // board's figure, not near it.
  const momentumMult = round4(1 + (growthPct / 100) * k.momentum_weight);
  const maturityMult = round4(age === null ? 1 : k.maturity_base + k.maturity_gain * (1 - Math.exp(-age / k.maturity_tau_days)));
  const breadthMult = round4(1 + k.breadth_per_chain * Math.min(Math.max(p.chains.length - 1, 0), k.breadth_cap));
  // The base price comes from the fitted size curve, not the category median: the curve is the
  // core that won the out-of-sample race the dashboard prints. The category median stays in the
  // breakdown so a reader can compare the two cores on every row.
  const base = curveValue(fit, p.tvl_usd, p.category);
  const implied = Math.max(1, Math.round(base * momentumMult * maturityMult * breadthMult));
  return {
    multiple: rate.multiple,
    category_median: rate.median_ratio,
    peers: rate.peers,
    curve_multiple: p.tvl_usd > 0 ? round4(base / p.tvl_usd) : 0,
    category_offset: round4(fit.offsets.get(p.category ?? '') ?? 0),
    growth_pct: round4(growthPct),
    momentum_mult: momentumMult,
    maturity_mult: maturityMult,
    breadth_mult: breadthMult,
    age_days: age,
    implied_value_usd: implied,
  };
}

// ------------------------------------------------------------ farm plans

/** One farm step as the dashboard shows it: the action, what it costs, how long it takes. */
export interface FarmStep {
  action: string;
  cost: string;
  time: string;
}

/** A farm step as board.json carries it: one string, action then cost then time. */
export function stepString(step: FarmStep): string {
  return `${step.action} Cost: ${step.cost}. Time: ${step.time}.`;
}

/** Working capital for one farm position, scaled to the protocol's size: bigger pools absorb more. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 500;
  if (tvl >= 250_000_000) return 250;
  if (tvl >= 50_000_000) return 150;
  if (tvl >= 15_000_000) return 75;
  return 40;
}

const CHEAP_L2 = new Set([
  'Arbitrum', 'Base', 'Optimism', 'Linea', 'Scroll', 'zkSync Era', 'Mantle', 'Mode', 'Blast',
  'Taiko', 'Unichain', 'Ink', 'BOB', 'Hemi', 'Katana', 'Soneium', 'World Chain', 'Zora',
]);

/** What one on-chain action costs on a chain, in plain words a farmer can budget with. */
function gasNote(chain: string): string {
  if (chain === 'Ethereum') return 'about $8 of ETH gas on Ethereum mainnet';
  if (chain === 'Solana') return 'a few cents of SOL in fees';
  if (chain === 'Bitcoin') return 'about $2 of BTC network fees';
  if (CHEAP_L2.has(chain)) return `about $0.50 of gas on ${chain}`;
  if (chain === 'Binance' || chain === 'BNB Chain') return 'about $0.30 of BNB in gas';
  return `about $1 of gas on ${chain}`;
}

/** How long a position should run, from the protocol's age: younger records need a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 540) return 60;
  return 30;
}

/** The two moves that make a farmer a real user of a protocol, by what the protocol is. */
function coreMoves(category: string | null, name: string, chain: string, capital: number): { first: string; second: string } {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return {
      first: `Supply $${capital} of USDC to ${name} on ${chain} as collateral and leave the position open.`,
      second: `Borrow about $${Math.round(capital / 3)} of USDC against that collateral, repay it after a week, and repeat the loop once so the account shows both sides of the market.`,
    };
  }
  if (c.includes('dex') || c.includes('liquidity manager')) {
    return {
      first: `Provide $${capital} of liquidity to the busiest USDC pair on ${name} on ${chain} and keep the LP position open.`,
      second: `Route two or three small swaps a week through ${name} itself rather than an aggregator, so the volume is recorded on the protocol.`,
    };
  }
  if (c.includes('derivative') || c.includes('option') || c.includes('perpetual')) {
    return {
      first: `Deposit $${capital} of USDC as margin on ${name} and open one small long and one small short so the account is delta-neutral.`,
      second: `Roll both hedges once a week: close, re-open at the new price, and keep the total margin near $${capital}.`,
    };
  }
  if (c.includes('basis')) {
    return {
      first: `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain}; the vault runs the hedge leg itself.`,
      second: `Check the vault's funding and share price weekly, and add $${Math.round(capital / 4)} more after the first month if the position is behaving.`,
    };
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield') || c.includes('leveraged farm') || c === 'farm') {
    return {
      first: `Deposit $${capital} of USDC into the flagship vault of ${name} on ${chain} and hold the vault shares in the same wallet.`,
      second: `Once a month, withdraw a small slice and deposit it back, so the account shows continuing use rather than one parked deposit.`,
    };
  }
  if (c.includes('rwa')) {
    return {
      first: `Complete ${name}'s onboarding on ${chain} and mint $${capital} of its yield-bearing asset.`,
      second: `Hold the asset to accrue, and make one further mint of $${Math.round(capital / 4)} after a month to show a second, separate purchase.`,
    };
  }
  if (c.includes('stable') || c.includes('algo-stable')) {
    return {
      first: `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`,
      second: `Provide $${Math.round(capital / 2)} of that stable asset to its main liquidity pool so the position earns and is visible on-chain.`,
    };
  }
  if (c.includes('staking') || c.includes('restak')) {
    return {
      first: `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token in the same wallet.`,
      second: `Claim and re-stake the rewards once a month rather than selling them, so the staked balance only grows.`,
    };
  }
  if (c.includes('insurance')) {
    return {
      first: `Buy $${capital} of cover from ${name} on ${chain} for a position you actually hold elsewhere.`,
      second: `Renew the cover when it lapses instead of letting the policy history end after one term.`,
    };
  }
  if (c.includes('prediction')) {
    return {
      first: `Fund $${capital} on ${name} and take a position in two or three of its most liquid markets.`,
      second: `Settle each market as it resolves and re-enter the next one, keeping a continuous record of participation.`,
    };
  }
  return {
    first: `Use ${name}'s core product on ${chain} with $${capital}: make the deposit, trade or transfer the product is built for, and leave the position open.`,
    second: `Repeat the core action on a second week with a smaller amount, so the account shows a pattern of use and not a single visit.`,
  };
}

/** A small deterministic variant from the slug, so twin protocols do not read as photocopies. */
function variantOf(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) % 997;
  return h % 2;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. Every figure in the
 * plan comes from the protocol's own record — its category picks the moves, its first chain picks
 * the gas budget, its TVL picks the working capital, its age picks the hold — and no protocol's
 * name is ever special-cased.
 */
export function farmPlan(p: Protocol, age: number | null): FarmStep[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const gas = gasNote(chain);
  const moves = coreMoves(p.category, p.name, chain, capital);
  const v = variantOf(p.slug);
  const steps: FarmStep[] = [
    {
      action:
        v === 0
          ? `Set up a fresh wallet for ${p.name} alone, fund it from your main wallet, and keep its seed phrase offline.`
          : `Create a dedicated wallet for this farm, separate from your main funds, and store its seed phrase on paper.`,
      cost: gas,
      time: '10 minutes',
    },
    { action: moves.first, cost: `$${capital} of working capital plus ${gas}`, time: '20 minutes to set up' },
    { action: moves.second, cost: `about $${Math.max(2, Math.round(capital / 25))} a month in fees and gas`, time: '15 minutes a month' },
    {
      action:
        secondChain !== null
          ? `Open a second, smaller position on ${secondChain}, where ${p.name} also runs: $${Math.round(capital / 2)} is enough to count as a multichain user.`
          : v === 0
            ? `Make one qualifying action on ${p.name} every week — a deposit, a swap, a vote or a claim — and never let a week pass empty.`
            : `Return to ${p.name} weekly for one small qualifying action, such as topping up the position or voting, so every week shows activity.`,
      cost: gasNote(secondChain ?? chain),
      time: '10 minutes a week',
    },
    {
      action: `Hold the position for at least ${hold} days, across more than one monthly snapshot, and check the protocol's own points or rewards page before withdrawing anything.`,
      cost: `the $${capital} stays committed for the hold`,
      time: `${hold} days`,
    },
    {
      action: `Keep a farm log — wallet, dates, amounts, transaction hashes — and claim any future distribution only from a link the protocol itself publishes; never pay a fee to claim.`,
      cost: 'nothing to keep the log, and never pay to claim',
      time: '5 minutes a week',
    },
  ];
  return steps;
}

// ------------------------------------------------------------ v4 plans and farm economics

/** The stated economics every verdict is netted under; printed on the dashboard, never hidden. */
export const ECON = {
  /** Share of a launch assumed to reach depositors, the figure the top of this field states. */
  airdrop_share: 0.1,
  /** What idle dollars earn instead: the T-bill rate the forgone income is charged at. */
  tbill_rate: 0.04,
};

/** One on-chain action's fee in dollars, the numeric twin of gasNote's words. */
export function gasUsd(chain: string): number {
  if (chain === 'Ethereum') return 8;
  if (chain === 'Solana') return 0.05;
  if (chain === 'Bitcoin') return 2;
  if (CHEAP_L2.has(chain)) return 0.5;
  if (chain === 'Binance' || chain === 'BNB Chain') return 0.3;
  return 1;
}

/** The ticket a farm position takes, scaled to the pool: bigger books absorb bigger positions. */
export function ticketFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 5000;
  if (tvl >= 250_000_000) return 2500;
  if (tvl >= 50_000_000) return 1000;
  if (tvl >= 15_000_000) return 500;
  return 250;
}

const fmtUsd = (v: number): string =>
  Math.abs(v) < 100 ? `$${v.toFixed(2)}` : `$${Math.round(v).toLocaleString('en-US')}`;

/** One dated step of a v4 farm plan: when, what, what it costs in dollars, how long hands-on. */
export interface PlanStep {
  day: string;
  action: string;
  cost: string;
  time: string;
  /** Fees only (gas, bridge) in dollars; working capital is not a fee. Contingent steps carry 0. */
  fee_usd: number;
  /** Hands-on minutes; contingent steps carry 0 and say so. */
  minutes: number;
}

/** A plan step as board.json carries it: one string, day then action then cost then time. */
export function planStepString(step: PlanStep): string {
  return `${step.day}: ${step.action} Cost: ${step.cost}. Time: ${step.time}.`;
}

/** The whole farm arithmetic for one row, every figure derived from the row's own record. */
export interface FarmEconomics {
  ticket_usd: number;
  hold_days: number;
  fees_usd: number;
  forgone_usd: number;
  minutes: number;
  slice_usd: number;
  slice_low_usd: number;
  net_usd: number;
  net_low_usd: number;
  net_per_hour: number;
  /** (fees + forgone) / slice, in per cent: how likely a launch has to be for the farm to break even. */
  breakeven_pct: number;
}

/**
 * A protocol's v4 farm plan: seven dated steps. Day 0 sets up, day 1 and day 3 make the two core
 * moves (the category picks them, as before), weekly checks keep the position live, a midway step
 * re-reads the rewards terms, a stop rule exits if the book shrinks 10% under today's TVL, and the
 * last day withdraws. Every step carries its fee in dollars and its minutes, and the economics
 * below are summed from these same steps — the plan and the verdict can never drift apart.
 */
export function farmPlanV3(p: Protocol, age: number | null, s: ScoreBreakdown, bandLo: number): { steps: PlanStep[]; econ: FarmEconomics } {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const gas = gasUsd(chain);
  const ticket = ticketFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const weeks = Math.max(1, Math.round(hold / 7));
  const bridge = chain === 'Ethereum' ? 0 : 1;
  const moves = coreMoves(p.category, p.name, chain, ticket);
  const v = variantOf(p.slug);
  const stopLevel = Math.round(p.tvl_usd * 0.9);
  const steps: PlanStep[] = [
    {
      day: 'Day 0',
      action:
        v === 0
          ? `Set up a fresh wallet for ${p.name} alone, fund it from your main wallet, and keep its seed phrase offline.`
          : `Create a dedicated wallet for this farm, separate from your main funds, and store its seed phrase on paper.`,
      cost: bridge > 0 ? `${fmtUsd(bridge)} bridge leg to ${chain}` : 'no bridge leg — the position opens on Ethereum',
      time: '20 minutes',
      fee_usd: bridge,
      minutes: 20,
    },
    {
      day: 'Day 1',
      action: moves.first,
      cost: `${fmtUsd(ticket)} of working capital plus ${fmtUsd(gas)} of gas`,
      time: '30 minutes',
      fee_usd: gas,
      minutes: 30,
    },
    {
      day: 'Day 3',
      action: moves.second,
      cost: `${fmtUsd(gas)} of gas`,
      time: '20 minutes',
      fee_usd: gas,
      minutes: 20,
    },
    {
      day: `Days 7–${hold}`,
      action: `Check ${p.name}'s TVL and its own rewards page once a week (${weeks} checks): the position only counts while it stays live, and the terms of a launch are announced there first.`,
      cost: 'nothing',
      time: `10 minutes a week, ${weeks * 10} minutes in all`,
      fee_usd: 0,
      minutes: weeks * 10,
    },
    {
      day: `Day ${Math.round(hold / 2)}`,
      action: `Midway re-read: confirm the rewards or points terms still match day 1, and top the position back up to ${fmtUsd(ticket)} if redemptions or price moves shrank it.`,
      cost: `${fmtUsd(gas)} of gas if you top up`,
      time: '15 minutes',
      fee_usd: gas,
      minutes: 15,
    },
    {
      day: 'Any day',
      action: `Stop rule: if ${p.name}'s TVL falls under ${fmtUsd(stopLevel)} — 10% below today's ${fmtUsd(p.tvl_usd)} — withdraw everything; a token priced off a shrinking book is worth less than the gas to claim it.`,
      cost: `${fmtUsd(2 * gas)} of gas to exit, only if the rule fires`,
      time: '20 minutes, only if the rule fires',
      fee_usd: 0,
      minutes: 0,
    },
    {
      day: `Day ${hold}`,
      action: `Withdraw the position in full, and claim any distribution only from a link ${p.name} itself publishes; never pay a fee to claim. Keep the farm log — wallet, dates, amounts, hashes — either way.`,
      cost: `${fmtUsd(2 * gas)} of gas`,
      time: '25 minutes',
      fee_usd: 2 * gas,
      minutes: 25,
    },
  ];
  const fees = steps.reduce((a, st) => a + st.fee_usd, 0);
  const minutes = steps.reduce((a, st) => a + st.minutes, 0);
  const forgone = (ticket * ECON.tbill_rate * hold) / 365;
  const slice = p.tvl_usd > 0 ? (ECON.airdrop_share * s.implied_value_usd * ticket) / p.tvl_usd : 0;
  const sliceLow = p.tvl_usd > 0 ? (ECON.airdrop_share * bandLo * ticket) / p.tvl_usd : 0;
  const net = slice - fees - forgone;
  const netLow = sliceLow - fees - forgone;
  const econ: FarmEconomics = {
    ticket_usd: ticket,
    hold_days: hold,
    fees_usd: round4(fees),
    forgone_usd: round4(forgone),
    minutes,
    slice_usd: round4(slice),
    slice_low_usd: round4(sliceLow),
    net_usd: round4(net),
    net_low_usd: round4(netLow),
    net_per_hour: round4(minutes > 0 ? net / (minutes / 60) : 0),
    breakeven_pct: round4(slice > 0 ? ((fees + forgone) / slice) * 100 : 999),
  };
  return { steps, econ };
}

/**
 * The v4 verdict, netted in dollars under the stated assumptions: Farm only when the farm still
 * pays at the low end of the row's own value band; Thin when it pays at the point estimate but
 * not at the low end; Skip when it does not pay at all.
 */
export function econVerdict(e: FarmEconomics): { verdict: DashRow['verdict']; reason: string } {
  if (e.net_low_usd > 0) {
    return {
      verdict: 'Farm',
      reason: `nets ${fmtUsd(e.net_usd)} if a token launches, and still ${fmtUsd(e.net_low_usd)} at the band's low end — the fees and the forgone interest are covered either way`,
    };
  }
  if (e.net_usd > 0) {
    return {
      verdict: 'Thin',
      reason: `nets ${fmtUsd(e.net_usd)} at the point estimate but ${fmtUsd(e.net_low_usd)} at the band's low end — a small position only, sized so the low end cannot hurt`,
    };
  }
  return {
    verdict: 'Skip',
    reason: `the plausible slice of ${fmtUsd(e.slice_usd)} does not cover ${fmtUsd(e.fees_usd)} of fees plus ${fmtUsd(e.forgone_usd)} of forgone interest — break-even needs a ${Math.round(e.breakeven_pct)}% launch chance`,
  };
}

// ------------------------------------------------------------ the board

/** One row of board.json: the ranked candidate and everything the gate asks of a row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  token_status: 'pre-token';
  implied_value_usd: number;
  /** The middle half of this row's prices over 200 bootstrap refits of the curve. */
  band_lo_usd: number;
  band_hi_usd: number;
  /** The P10–P90 of this row's rank over the same refits. */
  rank_p10: number;
  rank_p90: number;
  model: {
    category_multiple: number;
    category_median: number;
    category_peers: number;
    curve_multiple: number;
    category_offset: number;
    growth_pct: number;
    momentum_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
  };
  farm_steps: string[];
}

/** A board row as the dashboard receives it: the same figures, with the plan in structured form. */
/** A traded peer shown beside a candidate in the detail view: the market's own figures. */
export interface PeerView {
  name: string;
  tvl_usd: number;
  mcap_usd: number;
  /** The peer's recorded market cap per dollar of TVL. */
  multiple: number;
}

export interface DashRow extends Omit<BoardRow, 'farm_steps' | 'model'> {
  model: BoardRow['model'];
  farm: FarmStep[];
  /** The v4 dated plan the economics are summed from. */
  plan: PlanStep[];
  /** The farm arithmetic for this row, netted under the stated assumptions. */
  econ: FarmEconomics;
  /** The five traded peers nearest this row's TVL, for the detail view. */
  peers: PeerView[];
  /** The radar's own call on the row, netted in dollars: farm it, thin position, or skip it. */
  verdict: 'Farm' | 'Thin' | 'Skip';
  /** Why the verdict is what it is, in one line a reader can check against the row. */
  verdict_reason: string;
}

/**
 * The verdict on one scored candidate, from its own record: the size of the prize if a token
 * comes (the implied value), the direction of its week, and how long it has run. A shrinking
 * protocol is never a Farm however large it is: farming a melting book buys a share of less.
 */
export function verdictFor(s: { implied_value_usd: number; growth_pct: number }): { verdict: DashRow['verdict']; reason: string } {
  if (s.implied_value_usd >= 25_000_000 && s.growth_pct >= -5) {
    return { verdict: 'Farm', reason: `implied $${Math.round(s.implied_value_usd / 1e6)}M and a week that is not shrinking — worth a position now` };
  }
  if (s.implied_value_usd >= 10_000_000 && s.growth_pct >= -25) {
    return { verdict: 'Watch', reason: 'real size, but the week or the scale does not yet earn a full position — one small qualifying action, then reassess' };
  }
  return { verdict: 'Skip', reason: 'small implied value or a shrinking week — the gas and the hold cost more than the plausible share' };
}

/** A category's rate as the dashboard's model panel shows it. */
export interface CategoryRateView {
  category: string;
  peers: number;
  median_ratio: number;
  multiple: number;
}

/** Everything the dashboard renders: meta, the model, the board, and the evidence base. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  constants: RadarConstants;
  global_median: number;
  counts: {
    protocols: number;
    watchlist: number;
    board: number;
    early: number;
    comparables: number;
    /** Priced peers with a positive cap: the set the v3.0 recipe fitted on. */
    priced: number;
    /** The cleaned set the v4 curve is fitted on (priced, minus CEX and Chain). */
    fit_comparables: number;
    live_unpriced: number;
  };
  category_rates: CategoryRateView[];
  /** The fitted size curve the board's prices come from. */
  fit: { intercept: number; slope: number; peers: number };
  /** The out-of-sample race between the fitted curve and the median model, run on this snapshot. */
  validation: ModelValidation;
  /** The wider v4 battery: leave-one-out ladder, time split, both hash directions, age split. */
  validation3: ValidationSuite;
  /** Why each pre-token protocol that is not on the board was set aside, with counts. */
  set_aside: { reason: string; count: number }[];
  /** The stated farm-economics assumptions every verdict is netted under. */
  econ_constants: typeof ECON;
  verdict_counts: { Farm: number; Thin: number; Skip: number };
  /** The cleaned fit set's slugs, in snapshot order: the browser's recompute resamples exactly this list. */
  fit_order: string[];
  rows: DashRow[];
  comparables: Comparable[];
}

/**
 * Build the board: every watchlist slug (the floor), plus every other genuine candidate the filter
 * finds below it (the early rows the radar exists for), scored and ranked by implied value. Ties
 * break by slug so two runs of the same snapshot agree byte for byte.
 */
export function buildBoard(snapshot: Snapshot, rates: MarketRates, fit: FittedCurve, k: RadarConstants = CONSTANTS): { rows: BoardRow[]; plans: Map<string, PlanStep[]>; econs: Map<string, FarmEconomics> } {
  const watch = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => watch.has(p.slug) || isCandidate(p));
  const scored = chosen.map((p) => ({ p, s: score(p, snapshot.as_of, rates, fit, k) }));
  scored.sort((a, b) => b.s.implied_value_usd - a.s.implied_value_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const bands = bootstrapBands(scored, fitComparables(rates.comparables), k);
  const plans = new Map<string, PlanStep[]>();
  const econs = new Map<string, FarmEconomics>();
  const rows = scored.map(({ p, s }, i) => {
    const band = bands.get(p.slug) ?? { lo: s.implied_value_usd, hi: s.implied_value_usd, rank_lo: i + 1, rank_hi: i + 1 };
    const { steps, econ } = farmPlanV3(p, s.age_days, s, band.lo);
    plans.set(p.slug, steps);
    econs.set(p.slug, econ);
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: s.age_days,
      on_watchlist: watch.has(p.slug),
      token_status: 'pre-token',
      implied_value_usd: s.implied_value_usd,
      band_lo_usd: band.lo,
      band_hi_usd: band.hi,
      rank_p10: band.rank_lo,
      rank_p90: band.rank_hi,
      model: {
        category_multiple: s.multiple,
        category_median: s.category_median,
        category_peers: s.peers,
        curve_multiple: s.curve_multiple,
        category_offset: s.category_offset,
        growth_pct: s.growth_pct,
        momentum_multiplier: s.momentum_mult,
        maturity_multiplier: s.maturity_mult,
        breadth_multiplier: s.breadth_mult,
      },
      farm_steps: steps.map(planStepString),
    };
  });
  return { rows, plans, econs };
}

/** Assemble everything: the board for board.json and the dashboard's dataset, from one pass. */
export function buildRadar(snapshot: Snapshot, k: RadarConstants = CONSTANTS): { board: BoardRow[]; radar: RadarData } {
  const rates = marketRates(snapshot, k);
  const clean = fitComparables(rates.comparables);
  const fit = fitCurve(clean, k);
  const { rows: board, plans, econs } = buildBoard(snapshot, rates, fit, k);
  const watch = new Set(snapshot.watchlist);
  const priced = rates.comparables.filter((c) => c.mcap_usd > 0 && c.tvl_usd > 0);
  const peersFor = (tvl: number): PeerView[] =>
    [...clean]
      .sort((a, b) => Math.abs(Math.log(a.tvl_usd / tvl)) - Math.abs(Math.log(b.tvl_usd / tvl)))
      .slice(0, 5)
      .map((c) => ({ name: c.name, tvl_usd: c.tvl_usd, mcap_usd: c.mcap_usd, multiple: round4(c.mcap_usd / c.tvl_usd) }));
  const rows: DashRow[] = board.map((r) => {
    const { farm_steps, ...rest } = r;
    void farm_steps;
    const econ = econs.get(r.slug)!;
    const v = econVerdict(econ);
    const plan = plans.get(r.slug)!;
    return {
      ...rest,
      farm: plan.map((st) => ({ action: st.action, cost: st.cost, time: st.time })),
      plan,
      econ,
      peers: peersFor(r.tvl_usd),
      verdict: v.verdict,
      verdict_reason: v.reason,
    };
  });
  const categoryRates: CategoryRateView[] = [...rates.by_category.values()]
    .map((r) => ({ category: r.category === '' ? 'Uncategorised' : r.category, peers: r.peers, median_ratio: r.median_ratio, multiple: r.multiple }))
    .sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1));
  // The set-aside ledger: every pre-token protocol that is neither watchlist nor candidate, with
  // the first reason the candidate filter refuses it. The counts must sum to the gap between the
  // record-no-token universe and the board, and the dashboard prints them so they can be checked.
  const asideCounts = new Map<string, number>();
  for (const p of snapshot.protocols) {
    if (!recordsNoToken(p) || watch.has(p.slug) || isCandidate(p)) continue;
    let reason = 'another filter reason';
    if (p.category !== null && CONDUIT_CATEGORIES.has(p.category)) reason = `conduit or wrapper category (${p.category})`;
    else if (VERSION_SUFFIX.test(p.name)) reason = 'name carries a version suffix — a redeployment, not a launch';
    else if (WRAPPER_WORD.test(p.name)) reason = 'name marks a wrapped or staked product of another asset';
    else if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) reason = "name begins with an exchange's name — a house product";
    asideCounts.set(reason, (asideCounts.get(reason) ?? 0) + 1);
  }
  const setAside = [...asideCounts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    constants: k,
    global_median: rates.global_median,
    counts: {
      protocols: snapshot.protocols.length,
      watchlist: snapshot.watchlist.length,
      board: board.length,
      early: board.filter((r) => !watch.has(r.slug)).length,
      comparables: rates.comparables.length,
      priced: priced.length,
      fit_comparables: clean.length,
      live_unpriced: snapshot.protocols.filter((p) => !recordsNoToken(p) && p.mcap_usd === null).length,
    },
    category_rates: categoryRates,
    fit: { intercept: fit.intercept, slope: fit.slope, peers: fit.peers },
    validation: validateModels(snapshot, k),
    validation3: validateV3(snapshot, k),
    set_aside: setAside,
    econ_constants: ECON,
    verdict_counts: {
      Farm: rows.filter((r) => r.verdict === 'Farm').length,
      Thin: rows.filter((r) => r.verdict === 'Thin').length,
      Skip: rows.filter((r) => r.verdict === 'Skip').length,
    },
    fit_order: clean.map((c) => c.slug),
    rows,
    comparables: [...rates.comparables].sort(
      (a, b) => (a.category ?? '') < (b.category ?? '') ? -1 : (a.category ?? '') > (b.category ?? '') ? 1 : b.ratio - a.ratio,
    ),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape this model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json carries no as_of date');
  if (typeof o.source !== 'string' || o.source.length === 0) throw new SnapshotError('snapshot.json carries no source');
  if (!isNum(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json carries no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json carries no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json carries no watchlist of slugs');
  }
  const protocols: Protocol[] = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || !isNum(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: isNum(p.change_7d) ? p.change_7d : null,
      mcap_usd: isNum(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/**
 * Why a board is not one the gate will take, or null. Mirrors the gate's own rows — coverage,
 * ranks exactly 1..N, value never rising as rank ascends, not one shared value, every farm step
 * within its length — so a bad board fails here, in the open, instead of at the scorer.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `${r.slug} appears twice`;
    seen.add(r.slug);
  }
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not a protocol in the snapshot`;
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is missing or doubled`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} is worth more than rank ${i}`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row carries the same implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** The dashboard's dataset as one script: window.RADAR, no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
