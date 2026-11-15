# token-radar-01 — Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/FadliAR/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/FadliAR/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Entry for make.fun's [token-radar-01 bounty](https://make.fun/bounty/token-radar-01):
"Build the best token launch radar" ($1,325 in USDC, escrowed on Solana).

**Launch Radar** ranks protocols that record no token yet by what a launch
could be worth, and shows a reader how to farm each one. It reads the
competition's frozen DefiLlama snapshot (758 protocols, fetched 2026-11-14)
and derives everything from that file's own figures — no name is priced by
hand, and nothing is fetched live.

## The model (lib/model.ts, version comps-2.1)

A pre-token protocol has no price, but the same snapshot carries 144
protocols whose tokens already trade, each pairing a market cap with a TVL.
Their market-cap-to-TVL ratios are the market's own answer to "what is a
dollar of TVL worth as a token?", category by category:

- Each peer ratio is winsorized to 0.01–4×, so one outlier cannot carry a
  category.
- A category's multiple is its **median ratio shrunk toward the market-wide
  median (0.17×)** with a prior of six phantom peers: a category with one
  priced peer stays near the market rate, a category with fifteen speaks for
  itself. A category with no priced peer uses the market-wide median.
- A candidate's implied value is its TVL × its category multiple, tilted by
  three factors from its own record: 7-day TVL momentum (growth clamped to
  −60%…+120%, weight 0.4), maturity (0.75 rising toward 1.20 with tokenless
  age on a saturating curve; a protocol with no listing date is neutral), and
  breadth (+2% per extra chain, capped at ten).
- Every factor is rounded to four decimals before it is applied, so the
  breakdown printed in a protocol's detail view multiplies out to exactly
  the figure board.json carries.

The board covers all 40 watchlist protocols (TVL ≥ $50M, no token on
record) and adds every other genuine launch candidate the same filter finds
below that floor — 198 rows in all. Exchanges, bridges, liquid-staking and
other wrappers of assets that already trade, and versioned redeployments,
are not launch candidates and are never ranked. Protocols whose token
already trades are shown apart, in the dashboard's Comparables view, as the
evidence base the multiples come from.

Each row carries a six-step farm plan generated from the protocol's own
category, chains, TVL and age: the moves a real user would make, with an
indicative cost and a time for every step.

## The dashboard (dashboard/)

A static, offline page — no framework, no network: a sortable, filterable
board (search, category, chain, TVL band, watchlist-only), a detail drawer
per protocol with its full derivation and farm plan, and the comparables
view. The three screenshots are real renders of it.

## Running it

Node 22.18+, standard library only:

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
```

A run writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and
`dossier.json` (built with the vendored `vendor/makefun-board.ts`) into the
output directory, deterministically: two runs of the same snapshot produce
identical bytes.
