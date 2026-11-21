// Token launch radar — round 5 entrypoint.
//
// Reads the frozen DefiLlama snapshot, builds the ranked board with
// lib/model.ts, and writes board.json, the dashboard (with its data
// file), the screenshots and dossier.json into the output directory.
//
// Round 5 exists because round 4's board was written under the wrong
// shape (a `ranked` wrapper and an `implied_value` field) and the sealed
// gate, which reads `rows` and `implied_value_usd`, read zero rows. The
// boardIssue() self-check below validates the exact gate contract before
// anything is written and stops the program cold if the shape drifts.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoard, FARM, TILTS, type Snapshot } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const inputDir = argValue("--input") ?? process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = argValue("--output") ?? process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const here = dirname(fileURLToPath(import.meta.url));

export interface GateRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

// The gate contract, checked against the exact object we are about to
// write. Returns a description of the first problem, or null when the
// board is exactly the shape the gate reads.
export function boardIssue(
  board: { rows: GateRow[] },
  watchlist: string[],
  slugs: Set<string>,
): string | null {
  if (!board || !Array.isArray(board.rows)) return "board is not an object with a rows array";
  const rows = board.rows;
  if (rows.length < 100 || rows.length > 4000) return `rows length ${rows.length} outside 100..4000`;
  const seen = new Set<string>();
  let prev = Number.POSITIVE_INFINITY;
  let allEqual = true;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!slugs.has(r.slug)) return `row ${i}: slug ${r.slug} not in snapshot`;
    if (seen.has(r.slug)) return `row ${i}: slug ${r.slug} repeated`;
    seen.add(r.slug);
    if (!r.name || typeof r.name !== "string") return `row ${i}: empty name`;
    if (r.rank !== i + 1) return `row ${i}: rank ${r.rank}, expected ${i + 1}`;
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
      return `row ${i}: implied_value_usd ${r.implied_value_usd} not a positive whole number <= 1e14`;
    }
    if (r.implied_value_usd > prev) return `row ${i}: implied_value_usd rises with rank`;
    if (i > 0 && r.implied_value_usd !== rows[0].implied_value_usd) allEqual = false;
    prev = r.implied_value_usd;
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `row ${i}: farm_steps count outside 3..12`;
    }
    for (const s of r.farm_steps) {
      const t = typeof s === "string" ? s.trim().length : 0;
      if (t < 20 || t > 600) return `row ${i}: farm step of ${t} trimmed chars`;
    }
  }
  if (rows.length > 1 && allEqual) return "all implied values equal: not a ranking";
  for (const slug of watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} missing from board`;
  }
  return null;
}

function main(): void {
  const snap = JSON.parse(readFileSync(join(inputDir, "snapshot.json"), "utf8")) as Snapshot;
  const board = buildBoard(snap);
  const slugs = new Set(snap.protocols.map((p) => p.slug));

  const gateBoard = {
    rows: board.rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      rank: r.rank,
      implied_value_usd: r.value,
      farm_steps: r.farm_steps,
    })),
  };
  const issue = boardIssue(gateBoard, snap.watchlist, slugs);
  if (issue) {
    console.error(`board self-check failed: ${issue}`);
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "board.json"), JSON.stringify(gateBoard, null, 1) + "\n");

  // Dashboard: copy the page, then write its data file beside it. The
  // data is compact (short keys, categories as indices) so the whole
  // dashboard source stays under the dossier's 65,536-byte text cap.
  const dashOut = join(outputDir, "dashboard");
  mkdirSync(dashOut, { recursive: true });
  cpSync(join(here, "dashboard"), dashOut, { recursive: true });
  const cats: string[] = [];
  for (const r of board.rows) if (!cats.includes(r.category)) cats.push(r.category);
  const verdictCode = { Farm: 0, Thin: 1, Skip: 2 } as const;
  const watch = new Set(snap.watchlist);
  const data = {
    m: {
      asOf: snap.as_of,
      a: board.fit.a,
      b: board.fit.b,
      n: board.fit.n,
      q05: board.fit.q05,
      q95: board.fit.q95,
      mom: TILTS.mom,
      mat: TILTS.mat,
      br: TILTS.breadth,
      alloc: FARM.allocShare,
      share: FARM.farmerShare,
      weeks: FARM.weeks,
      ledger: board.ledger,
      bt: board.backtest,
      cats,
    },
    r: board.rows.map((r) => [
      r.slug, r.name, r.rank, r.value, r.lo, r.hi, r.tvl,
      r.change7d === null ? "" : r.change7d,
      r.ageDays, r.nChains, r.firstChain, cats.indexOf(r.category),
      verdictCode[r.verdict], r.rewardUsd, r.costUsd, watch.has(r.slug) ? 1 : 0,
    ]),
  };
  writeFileSync(join(dashOut, "data.js"), "window.RADAR=" + JSON.stringify(data) + ";\n");

  const shotsOut = join(outputDir, "screenshots");
  mkdirSync(shotsOut, { recursive: true });
  cpSync(join(here, "screenshots"), shotsOut, { recursive: true });

  // buildDossier returns the dossier's bytes; write them to
  // dossier.json ourselves, exactly as returned.
  const finish = (result: unknown): void => {
    const dossierPath = join(outputDir, "dossier.json");
    if (result instanceof Uint8Array) {
      writeFileSync(dossierPath, result);
    } else if (typeof result === "string" && !existsSync(dossierPath)) {
      writeFileSync(dossierPath, result);
    }
    if (!existsSync(dossierPath)) {
      console.error("buildDossier produced no dossier.json");
      process.exit(1);
    }
    console.log(`board rows: ${board.rows.length}`);
  };
  const dossier = buildDossier(outputDir, { text_max_bytes: 65536 });
  if (dossier && typeof (dossier as { then?: unknown }).then === "function") {
    (dossier as unknown as Promise<unknown>).then(finish, (err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    finish(dossier);
  }
}

main();
