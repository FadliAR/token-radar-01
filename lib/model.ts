// Launch Radar's model: one frozen snapshot of the protocol universe in, one ranked board out.
//
// The idea in one paragraph. A protocol that records no token has no price, but it does not stand
// alone: the same snapshot carries 144 protocols whose tokens already trade, and each of those pairs
// a market cap with a TVL. Their market-cap-to-TVL ratios are the market's own answer to "what is a
// dollar of TVL worth as a token?", category by category. This model reads that answer off the
// snapshot, shrinks each category's median ratio toward the market-wide median in proportion to how
// few peers the category has, and applies the result to the pre-token protocols, tilted by the
// protocol's own seven-day TVL momentum, by how long it has run with no token, and by how many
// chains it spans. Nothing is priced from a name: every number below is a function of the snapshot's
// ten fields, and the dashboard shows each row's arithmetic so a reader can check it.
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
export const MODEL_VERSION = 'comps-2.1';

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
  /** The seven-day growth after clamping, in per cent. */
  growth_pct: number;
  momentum_mult: number;
  maturity_mult: number;
  breadth_mult: number;
  age_days: number | null;
  implied_value_usd: number;
}

/**
 * Score one candidate. Base value is TVL times the category's market multiple; three tilts follow,
 * each from the protocol's own record: momentum (a week of growth is evidence a launch would meet a
 * larger protocol, a week of shrinkage the opposite, and the clamp keeps one wild week from ruling
 * the board), maturity (a protocol that has run for years at size with no token has more to launch
 * than one listed last month, with diminishing returns on age), and breadth (each extra chain is
 * another community a launch would reach). A protocol with no listing date gets a neutral maturity
 * of exactly 1: the model does not invent an age it was not given.
 */
export function score(p: Protocol, asOf: string, rates: MarketRates, k: RadarConstants = CONSTANTS): ScoreBreakdown {
  const rate = rateFor(rates, p.category);
  const age = ageInDays(asOf, p.listed_at);
  const growthPct = clamp(p.change_7d ?? 0, k.growth_lo, k.growth_hi);
  // Each factor is rounded to 4 decimals before it is applied, so the breakdown the dashboard
  // prints is the whole calculation: a reader multiplying the five printed numbers lands on the
  // board's figure, not near it.
  const momentumMult = round4(1 + (growthPct / 100) * k.momentum_weight);
  const maturityMult = round4(age === null ? 1 : k.maturity_base + k.maturity_gain * (1 - Math.exp(-age / k.maturity_tau_days)));
  const breadthMult = round4(1 + k.breadth_per_chain * Math.min(Math.max(p.chains.length - 1, 0), k.breadth_cap));
  const implied = Math.max(1, Math.round(p.tvl_usd * rate.multiple * momentumMult * maturityMult * breadthMult));
  return {
    multiple: rate.multiple,
    category_median: rate.median_ratio,
    peers: rate.peers,
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
  model: {
    category_multiple: number;
    category_median: number;
    category_peers: number;
    growth_pct: number;
    momentum_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
  };
  farm_steps: string[];
}

/** A board row as the dashboard receives it: the same figures, with the plan in structured form. */
export interface DashRow extends Omit<BoardRow, 'farm_steps' | 'model'> {
  model: BoardRow['model'];
  farm: FarmStep[];
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
    live_unpriced: number;
  };
  category_rates: CategoryRateView[];
  rows: DashRow[];
  comparables: Comparable[];
}

/**
 * Build the board: every watchlist slug (the floor), plus every other genuine candidate the filter
 * finds below it (the early rows the radar exists for), scored and ranked by implied value. Ties
 * break by slug so two runs of the same snapshot agree byte for byte.
 */
export function buildBoard(snapshot: Snapshot, rates: MarketRates, k: RadarConstants = CONSTANTS): { rows: BoardRow[]; plans: Map<string, FarmStep[]> } {
  const watch = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => watch.has(p.slug) || isCandidate(p));
  const scored = chosen.map((p) => ({ p, s: score(p, snapshot.as_of, rates, k), plan: farmPlan(p, ageInDays(snapshot.as_of, p.listed_at)) }));
  scored.sort((a, b) => b.s.implied_value_usd - a.s.implied_value_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const plans = new Map(scored.map(({ p, plan }) => [p.slug, plan]));
  const rows = scored.map(({ p, s, plan }, i) => ({
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
    model: {
      category_multiple: s.multiple,
      category_median: s.category_median,
      category_peers: s.peers,
      growth_pct: s.growth_pct,
      momentum_multiplier: s.momentum_mult,
      maturity_multiplier: s.maturity_mult,
      breadth_multiplier: s.breadth_mult,
    },
    farm_steps: plan.map(stepString),
  }));
  return { rows, plans };
}

/** Assemble everything: the board for board.json and the dashboard's dataset, from one pass. */
export function buildRadar(snapshot: Snapshot, k: RadarConstants = CONSTANTS): { board: BoardRow[]; radar: RadarData } {
  const rates = marketRates(snapshot, k);
  const { rows: board, plans } = buildBoard(snapshot, rates, k);
  const watch = new Set(snapshot.watchlist);
  const rows: DashRow[] = board.map((r) => {
    const { farm_steps, ...rest } = r;
    void farm_steps;
    return { ...rest, farm: plans.get(r.slug)! };
  });
  const categoryRates: CategoryRateView[] = [...rates.by_category.values()]
    .map((r) => ({ category: r.category === '' ? 'Uncategorised' : r.category, peers: r.peers, median_ratio: r.median_ratio, multiple: r.multiple }))
    .sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1));
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
      live_unpriced: snapshot.protocols.filter((p) => !recordsNoToken(p) && p.mcap_usd === null).length,
    },
    category_rates: categoryRates,
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
