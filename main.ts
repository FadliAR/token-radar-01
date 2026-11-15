// Launch Radar — a token-radar-01 entry (Node 22, standard library only).
//
// What a run does, in order:
//   1. read the sealed snapshot (default /input/snapshot.json; --input <file|dir> overrides),
//   2. score every launch candidate with the comparables model in lib/model.ts,
//   3. refuse to write anything if the board fails the gate's own shape checks,
//   4. write /output/board.json and /output/data.js (the dashboard's dataset),
//   5. copy this repository's dashboard/ and screenshots/ into /output,
//   6. write /output/dossier.json last, with the vendored buildDossier, because the scorer
//      rebuilds that file from the rest of /output and compares it byte for byte.
//
// The run is a pure function of the snapshot and this repository: no clock, no randomness, no
// network, so the grader's two runs produce identical bytes.
//
// Local run, from the repository root:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path to the kit>/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoDir = fileURLToPath(new URL('.', import.meta.url));

/** The gate's caps, as the rules state them: the dossier's text cap shapes bytes, the rest refuse. */
const DOSSIER_TEXT_MAX = 65_536;
const SCREENSHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_LIMITS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of --name in argv (either "--name v" or "--name=v"), or the fallback. */
function flag(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < args.length) return args[at + 1]!;
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

function fail(message: string, code: number): never {
  process.stderr.write(`launch radar: ${message}\n`);
  process.exit(code);
}

const inputArg = flag('input', '/input');
const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  fail(`no snapshot at ${snapshotPath} — pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model produced a board the gate refuses: ${issue}`, 1);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ model: radar.model_version, rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy a flat directory's regular files, skipping dotfiles; returns the names copied. */
function copyFlat(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

const dashFiles = copyFlat(join(repoDir, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyFlat(join(repoDir, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3 || shots.length > 4) {
  fail(`screenshots/ holds ${shots.length} images — the entry hands in 3 or 4: the board, a detail view, a filtered view`, 1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`, 1);
}

// Written last on purpose: the dossier summarises the dashboard and screenshots beside it.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, { text_max_bytes: DOSSIER_TEXT_MAX, screenshots: SCREENSHOT_LIMITS, dashboard: DASHBOARD_LIMITS }),
);

process.stdout.write(
  `launch radar: ${snapshot.protocols.length} protocols read, ${radar.counts.comparables} priced peers, ` +
    `${board.length} candidates ranked (${radar.counts.early} below the watchlist floor)\n` +
    `launch radar: wrote board.json, data.js, dashboard/ (${dashFiles.length} files), screenshots/ (${shots.length} images), dossier.json\n`,
);
