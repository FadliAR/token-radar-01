# Token Launch Radar — implied values for protocols that record no token

[![Competition](https://make.fun/badge/token-radar-01.svg)](https://make.fun/c/token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/FadliAR/token-radar-01/rank.svg)](https://make.fun/c/token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/FadliAR/token-radar-01/reward.svg)](https://make.fun/c/token-radar-01)

Entry for the [token-radar-01](https://make.fun/c/token-radar-01) bounty on
make.fun. The program reads the frozen DefiLlama snapshot and ranks the
protocols that record no token by what a token would be worth if each
protocol's record stayed as it is, with a concrete farm plan per protocol.

## The board

Of the snapshot's 758 protocols, 416 already trade a token (they are the
comparables, never the ranked), 144 tokenless ones are wrapped, staked,
bridged or exchange products of a traded token and are set aside, and the
remaining **198 are ranked** — all 40 watchlist protocols among them.

## The model

- **Size curve.** Ordinary least squares on the cleaned fit set — the 118
  token-bearing comparables with a market cap, excluding the CEX and
  Chain categories, whose caps price a business or a whole chain rather
  than one protocol's token: log(market cap) = 7.671144 + 0.477776 ×
  log(TVL).
- **Tilts.** Three small multiplicative tilts in log space: seven-day
  momentum (0.35 per +100%, clamped), maturity (0.08 × log of age in
  years), and chain breadth (0.05 × log of chain count).
- **Bands.** A seeded bootstrap (seed 20261114, 240 rounds) refits the
  curve on resampled comparables; each row's band is the pooled 5–95%
  range of the refit predictions (×0.70 to ×1.51 of the point value).
- **Verdicts.** Farm / Thin / Skip net a stated farm expectation against
  cost: 8% of supply assumed to reach the community, a diligent farmer's
  expected share of that 0.05%, valued at the band low, against a
  category-priced 12-week campaign cost. Farm at ≥3× cost, Thin at ≥1×.
  The board lands at 56 Farm / 125 Thin / 17 Skip.
- **Farm plans.** Seven steps per protocol, generated from its category,
  chains and size, each with costs and durations.

## Backtest (measured, not promised)

- Time split — fit on the 38 comparables listed before 2024, test on the
  48 listed later: **median miss 2.584×, 47.9% within 2×**, 52.1% within 3×.
- Leave-one-out over the 118 cleaned comparables: **median miss 3.785×**,
  35.6% within 2×, Spearman rank correlation 0.373.

## The dashboard

`dashboard/` is a self-contained page (no network): a sortable,
filterable board with search and a watchlist toggle, a detail view per
protocol with its band, verdict maths and farm plan, and an in-browser
recompute — the page re-derives every row's value, band and verdict from
the shipped coefficients and reports the match (198/198) in its badge.
Deep links: `#v=farm` opens a verdict filter, `#d=<slug>` opens that
protocol's detail.

## Round 5 note — the gate-shape self-check

Round 4 of this entry failed the sealed harness gate because its
`board.json` was written with a `ranked` wrapper key and an
`implied_value` field; the gate reads `rows` and `implied_value_usd`, so
it read zero rows and the entry scored valid = 0. Round 5 is a clean-room
rebuild of the same model family whose `main.ts` carries a `boardIssue()`
self-check that validates the exact gate contract — `rows` array,
`implied_value_usd`, ranks 1..N non-increasing, watchlist coverage,
farm-step shapes — and exits non-zero before writing anything if the
shape ever drifts again.

## Running it

```
node main.ts --input <dir with snapshot.json> --output <output dir>
```

Node 22, standard library only, no network. The program is deterministic
(seeded bootstrap, no wall clock): two runs write identical bytes.
