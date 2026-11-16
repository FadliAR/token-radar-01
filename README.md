# token-radar-01 — Launch Radar (v3 candidate, model curve-4.0)
[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/FadliAR/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/FadliAR/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Entry candidate for make.fun's token-radar-01 bounty: "Build the best token launch radar"
($1,325 in USDC, escrowed on Solana). **Status: prepared, NOT submitted** — the standing entry
is v2 (curve-3.0) in `../token-radar-01-v2/`; this directory is the v3 candidate. See
`GAP-ANALYSIS.md` for why it exists and `BACKTEST.md` for the v2-vs-v3 evidence.

**Launch Radar** ranks the 198 pre-token protocols in the competition's frozen DefiLlama
snapshot (758 protocols, as of 2026-11-14) by implied launch value, and nets a farm verdict in
dollars for every row. Everything is derived from the snapshot's own figures; nothing is
fetched live and no name is priced by hand.

## The model (lib/model.ts, curve-4.0)

- A power-law size curve, ln(market cap) on ln(TVL), fitted by least squares over **118
  cleaned traded peers** (of 128 positively priced: CEX and Chain tokens are kept out of the
  fit — their prices are not read off a protocol's TVL), with per-category log offsets shrunk
  toward zero by n/(n+6).
- Three tilts from each protocol's own record: 7-day momentum, tokenless maturity, chain
  breadth.
- **Uncertainty**: 200 seeded bootstrap refits give every row a P25–P75 value band and a
  P10–P90 rank range.
- **Farm economics**: slice = 10% of implied value × ticket ÷ TVL (ticket $250–$5,000 scaled
  to the pool), minus fees summed from a seven-step day-stamped plan, minus 4%-a-year forgone
  interest. Verdicts: **Farm** (pays even at the band's low end), **Thin** (pays at the point
  estimate only), **Skip** (does not cover costs) — 98 / 20 / 80 on this snapshot.
- **Validation, printed in full on the dashboard's Method view**: leave-one-out ladder
  (×3.53 median miss for the full model vs ×4.83 for a flat multiple), a time split
  (fit pre-2024 → price 2024+: ×2.48), the slug-hash split in both directions against the
  v3.0 recipe, and an age split.
- The dashboard **recomputes the whole model in the browser** (fit, bootstrap, economics)
  and reports the match against board.json: 198/198 on all four figure classes.

## Run

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
node tools/backtest.mjs   # v2 vs v3 under identical protocols (needs ../token-radar-01-v2/)
```

A run is a pure function of the snapshot: two runs produce byte-identical board.json,
data.js and dossier.json.

Proposed submission title: "Launch Radar — comps-fitted size curve (time-split ×2.48,
leave-one-out ×3.53), 198 pre-token protocols with bootstrap bands and farm verdicts
netted at the band's low end".
