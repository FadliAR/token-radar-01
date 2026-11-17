# Token Launch Radar

Implied launch values for protocols that record no token yet, priced off the
protocols whose tokens already trade — with a farm plan, a dollar-netted
verdict, and an uncertainty band on every row.

[![Token Launch Radar on make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/c/token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/FadliAR/token-radar-01/rank.svg)](https://make.fun/c/token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/FadliAR/token-radar-01/reward.svg)](https://make.fun/c/token-radar-01)

Entry for the [token-radar-01](https://make.fun/c/token-radar-01) competition on make.fun.

## The model

On the traded peers in the snapshot, market cap is fitted as a power law of
TVL — a least-squares line in log-log space — plus a per-category log offset
shrunk toward zero. The fit is cleaned: the CEX and Chain categories are
excluded, because an exchange's or a chain's token price does not read off
the TVL its record tracks, and leaving them in bends the curve for everyone
else. Three hand-set tilts from a protocol's own record then apply:
momentum (40% of its 7-day TVL change, clamped), maturity (how long it has
run tokenless), and breadth (+2% per chain past the first). Fitted tilt
weights were tested and rejected — on this peer count they chase noise and
degrade the out-of-sample splits.

Every candidate also carries:

- a **bootstrap band** (P25–P75 of its value across 200 seeded refits of
  the cleaned peer set) and a P10–P90 rank range;
- **farm economics netted in dollars**: expected airdrop slice (10% share
  of implied value × ticket ÷ TVL) minus the plan's stated fees and forgone
  interest, giving a **Farm / Thin / Skip** verdict that must pay at the
  band low, not just at the point estimate;
- a **seven-step, day-stamped farm plan** with per-step fees and minutes
  and a numeric stop rule (exit if TVL falls 10% under the entry mark).

## Validation

All validation refits on the fit side only. Headline figures (reproduced by
`lib/model.ts` and printed on the dashboard's Method view): leave-one-out
median miss ≈ 3.65× over the 128 priced peers; time split (fit pre-2024,
price 2024+) median miss ≈ 2.35× with 41% of peers inside 2× — the cleaned
fit's gain concentrates exactly where a launch radar needs it, pricing
newer protocols from older ones. The dashboard re-derives every number in
the browser from the shipped data and reports the comparison in its header.

## Layout

- `main.ts` — entrypoint: reads the snapshot, writes `board.json`,
  `dashboard/` and `dossier.json`.
- `lib/model.ts` — the model: universe classification and the set-aside
  ledger, the fitted curve, backtests, bootstrap bands, farm economics and
  plans.
- `dashboard/` — the static judge-facing site (board, per-protocol detail,
  method and evidence), plus the `data.js` the program generates.
- `screenshots/` — three views of the shipped dashboard.
- `vendor/makefun-board.ts` — the competition kit's dossier library,
  byte-for-byte as provided.

## Run

```
MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

Node 22+, standard library only, no network. Deterministic: the same
snapshot produces the same bytes on every run.
