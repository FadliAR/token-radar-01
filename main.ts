// main.ts — Token Launch Radar entrypoint.
//
// Reads the snapshot the harness provides, prices every pre-token protocol
// in it with the model in lib/model.ts, and writes the three artefacts:
//   board.json    the ranked candidate board (the graded output)
//   dashboard/    the judge-facing site (static files + generated data.js)
//   dossier.json  the sealed evidence bundle, via the kit's buildDossier
//
// Node standard library only, no network, deterministic: the same snapshot
// produces the same bytes on every run.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";
import {
  AIRDROP_SHARE,
  CONDUIT_CATEGORIES,
  VERSION_SUFFIX,
  WRAPPED_WORD,
  ageDays,
  bootstrapBands,
  classifyUniverse,
  economicsFor,
  fitCurve,
  fnv1a,
  homeChain,
  planFor,
  priceWith,
  roundTo,
  runValidation,
  stepText,
  ticketFor,
  ALL_TILTS,
  type ProtocolRec,
  type Score,
  type Snapshot,
} from "./lib/model.ts";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const inputPath =
  argValue("--input") ??
  (process.env.MAKEFUN_INPUT_DIR ? join(process.env.MAKEFUN_INPUT_DIR, "snapshot.json") : "/input/snapshot.json");
const outputDir = argValue("--output") ?? process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const here = dirname(fileURLToPath(import.meta.url));

const snap = JSON.parse(readFileSync(inputPath, "utf8")) as Snapshot;
const asOf = snap.as_of;
const watch = new Set(snap.watchlist);

const uni = classifyUniverse(snap);
const fit = fitCurve(uni.cleanedPeers, true);

// Price the board: implied value from the full model, ranked descending,
// slug as the deterministic tie-break.
const priced = uni.ranked.map((p) => ({
  rec: p,
  dec: priceWith(fit, p, asOf, ALL_TILTS),
}));
priced.sort((x, y) => y.dec.value - x.dec.value || (x.rec.slug < y.rec.slug ? -1 : 1));

const bands = bootstrapBands(uni.cleanedPeers, uni.ranked, asOf);

// Economics and verdicts per row, at the stated 10% share and at half of it.
interface Row {
  rec: ProtocolRec;
  rank: number;
  value: number;
  band: { p25: number; p75: number; rankLo: number; rankHi: number };
  steps: string[];
  verdict: string;
  econ: ReturnType<typeof economicsFor>;
}
const rows: Row[] = priced.map((entry, i) => {
  const band = bands.get(entry.rec.slug) as Row["band"];
  const plan = planFor(entry.rec, ticketFor(entry.rec.tvl_usd));
  const econ = economicsFor(entry.rec, entry.dec.value, band.p25, plan.totalFee, AIRDROP_SHARE);
  return {
    rec: entry.rec,
    rank: i + 1,
    value: entry.dec.value,
    band,
    steps: plan.steps.map(stepText),
    verdict: econ.verdict,
    econ,
  };
});
const counts = { Farm: 0, Thin: 0, Skip: 0 };
const countsHalf = { Farm: 0, Thin: 0, Skip: 0 };
for (const row of rows) {
  counts[row.verdict as keyof typeof counts]++;
  const plan = planFor(row.rec, ticketFor(row.rec.tvl_usd));
  const half = economicsFor(row.rec, row.value, row.band.p25, plan.totalFee, AIRDROP_SHARE / 2);
  countsHalf[half.verdict as keyof typeof countsHalf]++;
}

const validation = runValidation(snap, uni);

// ---------------------------------------------------------------------------
// board.json
// ---------------------------------------------------------------------------

mkdirSync(outputDir, { recursive: true });
const board = {
  ranked: rows.map((row) => ({
    slug: row.rec.slug,
    name: row.rec.name,
    rank: row.rank,
    implied_value: row.value,
    farm_steps: row.steps,
  })),
};
writeFileSync(join(outputDir, "board.json"), JSON.stringify(board, null, 2) + "\n");

// ---------------------------------------------------------------------------
// dashboard/: copy the static site, then generate its data file.
// ---------------------------------------------------------------------------

const dashOut = join(outputDir, "dashboard");
mkdirSync(dashOut, { recursive: true });
for (const f of ["index.html", "app.css", "app.js"]) {
  copyFileSync(join(here, "dashboard", f), join(dashOut, f));
}

const categories: string[] = [];
const catIndex = new Map<string, number>();
const catOf = (p: ProtocolRec): number => {
  const name = p.category === null ? "(uncategorised)" : p.category;
  let idx = catIndex.get(name);
  if (idx === undefined) {
    idx = categories.length;
    categories.push(name);
    catIndex.set(name, idx);
  }
  return idx;
};
const scoreRow = (label: string, s: Score): [string, number, number, number, number] => [
  label,
  roundTo(s.medianMiss, 2),
  Math.round(s.within2 * 100),
  Math.round(s.within3 * 100),
  s.n,
];
const asideKind = (p: ProtocolRec): number => {
  if (p.category !== null && CONDUIT_CATEGORIES.includes(p.category)) return 0;
  if (VERSION_SUFFIX.test(p.name)) return 1;
  if (WRAPPED_WORD.test(p.name)) return 2;
  return 3;
};
const planHash = fnv1a(rows.map((row) => row.steps.join("\n")).join("\n"));
const data = {
  m: {
    asOf,
    source: snap.source,
    floor: snap.floor_usd,
    fitN: uni.cleanedPeers.length,
    peerN: uni.pricedPeers.length,
    a: roundTo(fit.a, 6),
    b: roundTo(fit.b, 6),
    ledger: {
      ranked: uni.ranked.length,
      setAside: uni.setAside.length,
      traded: uni.traded.length,
      unpriced: uni.unpriced.length,
      total: snap.protocols.length,
    },
    excluded: uni.excludedPeers.map((p) => [p.name, p.category]),
    counts,
    countsHalf,
    ladder: [
      scoreRow("Flat multiple (median cap/TVL x TVL)", validation.looFlat128),
      scoreRow("Size curve only", validation.looCurve128),
      scoreRow("Size curve + category offsets", validation.looCurveCat128),
      scoreRow("Full model (curve + offsets + tilts)", validation.looFull128),
      scoreRow("Full model, cleaned peers only", validation.looFull118),
    ],
    splits: [
      scoreRow("Time split (fit pre-2024, test 2024+)", validation.timeFull),
      scoreRow("Hash split A (fit odd, test even)", validation.hashA),
      scoreRow("Hash split B (fit even, test odd)", validation.hashB),
      scoreRow("Age split (fit pre-2023, test 2023+)", validation.ageSplit),
    ],
    ablations: [
      ["No momentum tilt", roundTo(validation.looNoMom.medianMiss, 2), roundTo(validation.timeNoMom.medianMiss, 2)],
      ["No maturity tilt", roundTo(validation.looNoMat.medianMiss, 2), roundTo(validation.timeNoMat.medianMiss, 2)],
      ["No breadth tilt", roundTo(validation.looNoBre.medianMiss, 2), roundTo(validation.timeNoBre.medianMiss, 2)],
      ["No tilts at all", roundTo(validation.looCurveCat128.medianMiss, 2), roundTo(validation.timeCurveCat.medianMiss, 2)],
    ],
    spearman: roundTo(validation.spearmanLoo, 3),
    top20: validation.top20Overlap,
    planHash,
    cats: categories,
  },
  p: uni.pricedPeers.map((p) => [
    p.tvl_usd,
    p.mcap_usd,
    catOf(p),
    ageDays(p, asOf),
    p.change_7d,
    p.chains.length,
  ]),
  r: rows.map((row) => [
    row.rec.slug,
    row.rec.name,
    catOf(row.rec),
    row.rec.tvl_usd,
    row.rec.change_7d,
    ageDays(row.rec, asOf),
    row.rec.chains.length,
    homeChain(row.rec),
    watch.has(row.rec.slug) ? 1 : 0,
    row.value,
    row.band.p25,
    row.band.p75,
    row.band.rankLo,
    row.band.rankHi,
    row.verdict === "Farm" ? 0 : row.verdict === "Thin" ? 1 : 2,
  ]),
  s: uni.setAside.map((entry) => [
    entry.rec.name,
    catOf(entry.rec),
    entry.rec.tvl_usd,
    asideKind(entry.rec),
  ]),
};
const dataJs =
  "// Generated by main.ts at build time from the snapshot: the shipped data\n" +
  "// the dashboard renders and re-derives its numbers from. m = meta and\n" +
  "// validation, p = traded fit peers, r = ranked board rows, s = set-asides.\n" +
  "const DATA = " +
  JSON.stringify(data) +
  ";\n";
writeFileSync(join(dashOut, "data.js"), dataJs);

// ---------------------------------------------------------------------------
// screenshots/ and the dossier.
// ---------------------------------------------------------------------------

const shotsOut = join(outputDir, "screenshots");
mkdirSync(shotsOut, { recursive: true });
const shotsSrc = join(here, "screenshots");
if (existsSync(shotsSrc)) {
  for (const f of readdirSync(shotsSrc)) {
    if (f.endsWith(".jpg")) copyFileSync(join(shotsSrc, f), join(shotsOut, f));
  }
}
writeFileSync(join(outputDir, "dossier.json"), buildDossier(outputDir, { text_max_bytes: 65536 }));

console.log(
  "board rows " + rows.length +
    " | fit peers " + uni.cleanedPeers.length + " of " + uni.pricedPeers.length +
    " | verdicts Farm " + counts.Farm + " Thin " + counts.Thin + " Skip " + counts.Skip +
    " | LOO miss " + roundTo(validation.looFull128.medianMiss, 2) + "x" +
    " | time split " + roundTo(validation.timeFull.medianMiss, 2) + "x",
);
