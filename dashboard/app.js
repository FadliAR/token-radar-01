"use strict";
// Token Launch Radar dashboard. Everything below either renders DATA (the
// file main.ts generated from the snapshot) or re-derives the board from it:
// the fit, every price, every verdict, every farm plan and the bootstrap
// bands are recomputed here from the shipped peer and row inputs, and the
// header badge reports how the recomputation compares with the shipped
// board. Field layouts — p (traded peers): [tvl, mcap, catIdx, ageDays,
// change7d, nChains]; r (board rows): [slug, name, catIdx, tvl, change7d,
// ageDays, nChains, homeChain, watch, value, p25, p75, rankLo, rankHi,
// verdictIdx]; s (set-asides): [name, catIdx, tvl, kindIdx].

const M = DATA.m;
const CATS = M.cats;
const EXCLUDED = { CEX: 1, Chain: 1 };
const VERDICTS = ["Farm", "Thin", "Skip"];

// ---- model mirror: the same arithmetic as lib/model.ts, in the same order
function roundTo(x, dp) { const f = 10 ** dp; return Math.round(x * f) / f; }
function roundSig3(x) {
  if (x === 0) return 0;
  const d = Math.ceil(Math.log10(Math.abs(x)));
  return roundTo(x, 3 - d);
}
function money(x) { return "$" + Math.round(x).toLocaleString("en-US"); }
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = q * (sorted.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function median(xs) { return quantile([...xs].sort((a, b) => a - b), 0.5); }
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
function fitCurve(peers, withOffsets) {
  const xs = peers.map((p) => Math.log(p.tvl));
  const ys = peers.map((p) => Math.log(p.mcap));
  const offsets = new Map();
  let a = 0, b = 1;
  for (let round = 0; round < 200; round++) {
    let sx = 0, sy = 0;
    for (let i = 0; i < peers.length; i++) sx += xs[i], sy += ys[i] - (withOffsets ? offsets.get(peers[i].cat) || 0 : 0);
    const mx = sx / peers.length, my = sy / peers.length;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < peers.length; i++) {
      const dx = xs[i] - mx;
      sxy += dx * (ys[i] - (withOffsets ? offsets.get(peers[i].cat) || 0 : 0) - my);
      sxx += dx * dx;
    }
    b = sxx > 0 ? sxy / sxx : 1;
    a = my - b * mx;
    if (!withOffsets) break;
    const sums = new Map(), counts = new Map();
    for (let i = 0; i < peers.length; i++) {
      const r = ys[i] - a - b * xs[i];
      sums.set(peers[i].cat, (sums.get(peers[i].cat) || 0) + r);
      counts.set(peers[i].cat, (counts.get(peers[i].cat) || 0) + 1);
    }
    offsets.clear();
    for (const [c, s] of sums) offsets.set(c, s / (counts.get(c) + 6));
  }
  return { a, b, offsets };
}
function priceRow(fit, tvl, catName, chg, age, nch) {
  const base = roundTo(Math.exp(fit.a + fit.b * Math.log(tvl)), 2);
  const catFactor = roundTo(Math.exp(fit.offsets.get(catName) || 0), 4);
  const momentum = roundTo(chg === null ? 1 : 1 + 0.4 * Math.min(1.2, Math.max(-0.6, chg / 100)), 4);
  const maturity = roundTo(age < 0 ? 1 : 1.2 - 0.45 * Math.exp(-age / 540), 4);
  const breadth = roundTo(1 + 0.02 * Math.min(Math.max(nch - 1, 0), 10), 4);
  const value = Math.max(1, Math.round(base * catFactor * momentum * maturity * breadth));
  return { value, base, catFactor, momentum, maturity, breadth };
}
const L2 = new Set(["Arbitrum", "Optimism", "Base", "zkSync Era", "Linea", "Scroll", "Mantle",
  "Blast", "Mode", "Taiko", "Zora", "Polygon zkEVM", "Starknet", "Manta", "Fraxtal",
  "World Chain", "Sonic", "Berachain", "Monad"]);
const CHEAP = { Solana: 0.25, BSC: 0.4, Polygon: 0.1, Avalanche: 0.8, Near: 0.1, Sui: 0.1, Aptos: 0.1, Tron: 0.5, Fantom: 0.1 };
function gasPerAction(chain) {
  if (chain === "Ethereum") return 12;
  if (L2.has(chain)) return 0.6;
  return CHEAP[chain] !== undefined ? CHEAP[chain] : 1.5;
}
function ticketFor(tvl) {
  const raw = Math.round(tvl * 0.0001 * 10) / 10;
  return Math.min(5000, Math.max(250, raw));
}
function coreActions(category) {
  switch (category) {
    case "Dexs": return ["swap a basket across the five most-traded pairs",
      "add the rest as liquidity in the busiest pair and leave it working"];
    case "Lending": return ["supply stablecoins as collateral",
      "borrow a small amount against the position and re-supply it, building a borrow record"];
    case "Yield": case "Yield Aggregator": return ["deposit into the flagship vault",
      "split the rest across two more vaults so the activity is not one deposit"];
    case "CDP": return ["open a vault and mint stablecoins against the collateral",
      "repay part of the mint and mint again, keeping the position active"];
    case "Derivatives": return ["trade small size across the main perpetual pairs",
      "keep a small hedged position open and adjust it at each check"];
    case "RWA": return ["complete onboarding and subscribe to the flagship product",
      "add the rest to a second product on the platform"];
    case "Launchpad": return ["register for the next sale and stake toward it",
      "join the sale queue with the rest of the ticket"];
    case "NFT Marketplace": return ["buy and re-list floor items in the busiest collections",
      "place collection offers with the rest of the ticket"];
    case "Payments": return ["route real transfers through the protocol",
      "hold a working balance and transact with it every week"];
    default: return ["use the protocol's core product with real funds",
      "repeat the core action so the record is a pattern, not a single touch"];
  }
}
function planFor(tvl, catName, chain, ticket) {
  const gas = gasPerAction(chain);
  const bridge = chain === "Ethereum" ? 0 : 18;
  const ab = coreActions(catName);
  const stopLevel = Math.round(tvl * 0.9);
  const steps = [
    { day: "Day 0", fee: roundTo(bridge + gas, 2), minutes: 45,
      text: "Set up: create a fresh wallet, fund it on " + chain + " with " + money(ticket) +
        " in stablecoins" + (bridge > 0 ? ", bridging from Ethereum" : "") +
        ", and record the protocol's TVL today (" + money(tvl) + ") as the entry mark." },
    { day: "Day 1", fee: roundTo(2 * gas, 2), minutes: 30,
      text: "Core move: " + ab[0] + " with 60% of the ticket (" + money(ticket * 0.6) + ")." },
    { day: "Day 3", fee: roundTo(2 * gas, 2), minutes: 25,
      text: "Second leg: " + ab[1] + " with the remaining 40% (" + money(ticket * 0.4) + ")." },
    { day: "Days 7-77", fee: roundTo(11 * gas, 2), minutes: 165,
      text: "Weekly loop: repeat the core action and re-check the position once a week for eleven weeks; " +
        "keep every transaction real and sized like the first week's." },
    { day: "Day 42", fee: roundTo(gas, 2), minutes: 20,
      text: "Midway re-read: compare the protocol's TVL with the entry mark. If it has fallen below the stop level (" +
        money(stopLevel) + "), exit early instead of farming a shrinking pool." },
    { day: "Day 83", fee: 0, minutes: 10,
      text: "Stop check: if TVL is under " + money(stopLevel) + " (10% under the entry mark), the plan ends here — " +
        "withdraw on Day 84 regardless of any launch rumour." },
    { day: "Day 84", fee: roundTo(bridge > 0 ? 12 : 2 * gas, 2), minutes: 30,
      text: "Withdraw: unwind the position in full" + (bridge > 0 ? ", bridge the proceeds back to Ethereum," : "") +
        " and record the final balance against the " + money(ticket) + " ticket." },
  ];
  const totalFee = roundTo(steps.reduce((s, x) => s + x.fee, 0), 2);
  const totalMinutes = steps.reduce((s, x) => s + x.minutes, 0);
  return { steps, totalFee, totalMinutes, stopLevel };
}
function stepText(s) { return s.day + " — " + s.text + " (fees " + money(s.fee) + ", ~" + s.minutes + " min)"; }
function econFor(tvl, value, bandLow, fees, share) {
  const ticket = ticketFor(tvl);
  const interest = roundTo(ticket * 0.04 * (84 / 365), 2);
  const grossPoint = share * value * ticket / tvl;
  const grossLow = share * bandLow * ticket / tvl;
  const netPoint = grossPoint - fees - interest;
  const netLow = grossLow - fees - interest;
  return {
    ticket, fees, interest,
    grossPoint: roundTo(grossPoint, 2), grossLow: roundTo(grossLow, 2),
    netPoint: roundTo(netPoint, 2), netLow: roundTo(netLow, 2),
    breakeven: grossPoint > 0 ? (fees + interest) / grossPoint : Infinity,
    verdict: netLow > 0 ? "Farm" : netPoint > 0 ? "Thin" : "Skip",
  };
}

// ---- recompute: fit from the shipped peers, reprice and re-judge every row
const PEERS = DATA.p.map((p) => ({ tvl: p[0], mcap: p[1], cat: CATS[p[2]], age: p[3], chg: p[4], nch: p[5] }));
const CLEAN = PEERS.filter((p) => !EXCLUDED[p.cat]);
const FIT = fitCurve(CLEAN, true);
const ROWS = DATA.r.map((r) => {
  const cat = CATS[r[2]];
  const dec = priceRow(FIT, r[3], cat, r[4], r[5], r[6]);
  const plan = planFor(r[3], cat, r[7], ticketFor(r[3]));
  const econ = econFor(r[3], dec.value, r[10], plan.totalFee, 0.1);
  return { r, cat, dec, plan, econ };
});
const valueMatch = ROWS.filter((x) => x.dec.value === x.r[9]).length;
const verdictMatch = ROWS.filter((x) => x.econ.verdict === VERDICTS[x.r[14]]).length;
const planHashOk = fnv1a(ROWS.map((x) => x.plan.steps.map(stepText).join("\n")).join("\n")) === M.planHash;
const fitOk = roundTo(FIT.a, 6) === M.a && roundTo(FIT.b, 6) === M.b;

function bootstrapCheck(done) {
  const rand = mulberry32(20261114);
  const vals = new Map(), ranks = new Map();
  for (const x of ROWS) { vals.set(x.r[0], []); ranks.set(x.r[0], []); }
  let rep = 0;
  const chunk = () => {
    const until = Math.min(rep + 25, 200);
    for (; rep < until; rep++) {
      const sample = [];
      for (let i = 0; i < CLEAN.length; i++) sample.push(CLEAN[Math.floor(rand() * CLEAN.length)]);
      const fit = fitCurve(sample, true);
      const priced = ROWS.map((x) => ({
        slug: x.r[0],
        value: priceRow(fit, x.r[3], x.cat, x.r[4], x.r[5], x.r[6]).value,
      }));
      const ordered = [...priced].sort((p, q) => q.value - p.value || (p.slug < q.slug ? -1 : 1));
      ordered.forEach((e, i) => ranks.get(e.slug).push(i + 1));
      for (const e of priced) vals.get(e.slug).push(e.value);
    }
    if (rep < 200) { setTimeout(chunk, 0); return; }
    let ok = 0;
    for (const x of ROWS) {
      const vs = [...vals.get(x.r[0])].sort((p, q) => p - q);
      const rs = [...ranks.get(x.r[0])].sort((p, q) => p - q);
      if (roundSig3(quantile(vs, 0.25)) === x.r[10] && roundSig3(quantile(vs, 0.75)) === x.r[11] &&
          Math.round(quantile(rs, 0.1)) === x.r[12] && Math.round(quantile(rs, 0.9)) === x.r[13]) ok++;
    }
    done(ok);
  };
  chunk();
}

// ---- rendering (browser only)
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmt$(x) {
  const v = Math.round(x);
  return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US");
}
function fmt2(x) { return (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const KIND = ["Conduit category", "Version-suffix redeployment", "Wrapped/staked product name", "Exchange house product"];
const bySlug = new Map(ROWS.map((x) => [x.r[0], x]));
const bandLo = Math.min(...ROWS.map((x) => x.r[10]));
const bandHi = Math.max(...ROWS.map((x) => x.r[11]));
function bandPos(x) {
  return (Math.log(x) - Math.log(bandLo)) / (Math.log(bandHi) - Math.log(bandLo)) * 100;
}
function bandHtml(x) {
  const l = bandPos(x.r[10]), w = Math.max(1.5, bandPos(x.r[11]) - l), d = bandPos(x.r[9]);
  return '<div class="track"><div class="box" style="left:' + l.toFixed(1) + "%;width:" + w.toFixed(1) +
    '%"></div><div class="dot" style="left:' + d.toFixed(1) + '%"></div></div>' +
    '<span class="bandtxt">' + fmt$(x.r[10]) + " – " + fmt$(x.r[11]) + "</span>";
}
function stripHtml() {
  const s = [
    [M.ledger.ranked, "pre-token candidates ranked"],
    [M.fitN + " of " + M.peerN, "traded peers in the fit (cleaned)"],
    [M.splits[0][1].toFixed(2) + "x", "time-split median miss (fit pre-2024)"],
    [M.ladder[3][1].toFixed(2) + "x", "leave-one-out median miss"],
    [M.counts.Farm + " / " + M.counts.Thin + " / " + M.counts.Skip, "verdicts Farm / Thin / Skip"],
  ];
  return s.map((x) => '<div class="stat"><b>' + x[0] + "</b><span>" + x[1] + "</span></div>").join("");
}
function renderBoard() {
  document.getElementById("strip").innerHTML = stripHtml();
  const q = document.getElementById("q").value.trim().toLowerCase();
  const fc = document.getElementById("fcat").value;
  const fv = document.getElementById("fver").value;
  const fw = document.getElementById("fwatch").checked;
  const shown = ROWS.filter((x) =>
    (!q || x.r[1].toLowerCase().includes(q) || x.r[0].includes(q)) &&
    (!fc || x.cat === fc) && (!fv || x.econ.verdict === fv) && (!fw || x.r[8] === 1));
  document.getElementById("count").textContent = "Showing " + shown.length + " of " + ROWS.length;
  document.getElementById("rows").innerHTML = shown.map((x) => {
    const rank = ROWS.indexOf(x) + 1;
    return "<tr data-slug=\"" + x.r[0] + "\"><td>" + rank + "</td><td><span class=\"name\">" + esc(x.r[1]) +
      (x.r[8] ? " <span class=\"star\">★</span>" : "") + "</span><br><span class=\"slug\">" + x.r[0] +
      "</span></td><td>" + esc(x.cat) + "</td><td class=\"num\">" + fmt$(x.r[3]) + "</td><td class=\"num\">" +
      (x.r[4] === null ? "—" : (x.r[4] > 0 ? "+" : "") + x.r[4].toFixed(1)) + "</td><td class=\"num\"><b>" +
      fmt$(x.r[9]) + "</b></td><td class=\"bandcell\">" + bandHtml(x) + "</td><td>" + x.r[12] + "–" + x.r[13] +
      "</td><td><span class=\"chip " + x.econ.verdict + "\">" + x.econ.verdict + "</span></td></tr>";
  }).join("");
  for (const tr of document.querySelectorAll("#rows tr")) {
    tr.addEventListener("click", () => { location.hash = "#detail=" + tr.dataset.slug; });
  }
}
function renderDetail(slug) {
  const x = bySlug.get(slug);
  const el = document.getElementById("view-detail");
  if (!x) { el.innerHTML = "<p>Unknown protocol.</p>"; return; }
  const rank = ROWS.indexOf(x) + 1;
  const d = x.dec, e = x.econ;
  const ageTxt = x.r[5] < 0 ? "no listing date (tilt exactly 1.0)" : x.r[5] + " days";
  const rowsKv = [
    ["Curve base — exp(" + M.a + " + " + M.b + " × ln TVL " + fmt$(x.r[3]) + ")", fmt2(d.base)],
    ["× Category factor (" + esc(x.cat) + ")", "× " + d.catFactor.toFixed(4)],
    ["× Momentum (7d TVL change " + (x.r[4] === null ? "not recorded (tilt 1.0)" : x.r[4].toFixed(1) + "%") + ")", "× " + d.momentum.toFixed(4)],
    ["× Maturity (age " + ageTxt + ")", "× " + d.maturity.toFixed(4)],
    ["× Breadth (" + x.r[6] + (x.r[6] === 1 ? " chain" : " chains") + ")", "× " + d.breadth.toFixed(4)],
    ["= Implied launch value", fmt$(x.r[9])],
  ];
  const econKv = [
    ["Ticket (0.01% of TVL, clamped $250–$5,000)", fmt$(e.ticket)],
    ["Expected slice at the point estimate (10% share)", fmt2(e.grossPoint)],
    ["Expected slice at the band low (P25 " + fmt$(x.r[10]) + ")", fmt2(e.grossLow)],
    ["Plan fees (7 steps, " + esc(x.r[7]) + ")", "-" + fmt2(e.fees)],
    ["Forgone interest (4% APR, 84 days)", "-" + fmt2(e.interest)],
    ["Net at the point estimate", fmt2(e.netPoint)],
    ["Net at the band low", fmt2(e.netLow)],
    ["Break-even launch chance", (e.breakeven * 100).toFixed(1) + "%"],
    ["Verdict", '<span class="chip ' + e.verdict + '">' + e.verdict + "</span>"],
  ];
  el.innerHTML =
    '<p><a class="back" href="#board">← Back to the board</a></p>' +
    "<h2>" + esc(x.r[1]) + (x.r[8] ? ' <span class="star">★</span>' : "") + "</h2>" +
    '<p class="sub">Rank ' + rank + " of " + ROWS.length + " · " + esc(x.cat) + " · TVL " + fmt$(x.r[3]) +
    " · home chain " + esc(x.r[7]) + "</p>" +
    '<p class="big">Implied value ' + fmt$(x.r[9]) + "</p>" +
    '<div class="bandcell" style="max-width:520px">' + bandHtml(x) + "</div>" +
    "<p>Bootstrap band P25–P75 " + fmt$(x.r[10]) + " – " + fmt$(x.r[11]) +
    "; rank range P10–P90: " + x.r[12] + "–" + x.r[13] + " (200 seeded refits).</p>" +
    "<h3>How the number is built</h3><table class=\"kv\">" +
    rowsKv.map((kv) => "<tr><td>" + kv[0] + "</td><td class=\"num\">" + kv[1] + "</td></tr>").join("") +
    "</table><p class=\"note\">The printed factors are the model's own rounded factors; their product is exactly the board figure.</p>" +
    "<h3>Farm economics, netted</h3><table class=\"kv\">" +
    econKv.map((kv) => "<tr><td>" + kv[0] + "</td><td class=\"num\">" + kv[1] + "</td></tr>").join("") +
    "</table>" +
    "<h3>The farm plan (" + x.plan.steps.length + " steps, fees " + fmt2(x.plan.totalFee) +
    ", ~" + x.plan.totalMinutes + " min over 84 days)</h3><ol class=\"plan\">" +
    x.plan.steps.map((s) => "<li>" + esc(stepText(s)) + "</li>").join("") + "</ol>";
}
function scoreTable(head, rows) {
  return "<table><thead><tr>" + head.map((h) => "<th>" + h + "</th>").join("") + "</tr></thead><tbody>" +
    rows + "</tbody></table>";
}
function renderMethod() {
  const el = document.getElementById("view-method");
  const ladder = M.ladder.map((s) =>
    '<tr class="static"><td>' + s[0] + "</td><td class=\"num\">" + s[1].toFixed(2) + "x</td><td class=\"num\">" +
    s[2] + "%</td><td class=\"num\">" + s[3] + "%</td><td class=\"num\">" + s[4] + "</td></tr>").join("");
  const splits = M.splits.map((s) =>
    '<tr class="static"><td>' + s[0] + "</td><td class=\"num\">" + s[1].toFixed(2) + "x</td><td class=\"num\">" +
    s[2] + "%</td><td class=\"num\">" + s[3] + "%</td><td class=\"num\">" + s[4] + "</td></tr>").join("");
  const abl = M.ablations.map((s) =>
    '<tr class="static"><td>' + s[0] + "</td><td class=\"num\">" + s[1].toFixed(2) + "x</td><td class=\"num\">" +
    s[2].toFixed(2) + "x</td></tr>").join("");
  const led = [
    ["Ranked candidates (this board)", M.ledger.ranked],
    ["Set aside (rules below)", M.ledger.setAside],
    ["Already traded (token + market cap recorded)", M.ledger.traded],
    ["Token recorded, no market cap", M.ledger.unpriced],
    ["Snapshot total", M.ledger.total],
  ];
  const ledger = led.map((kv) =>
    '<tr class="static"><td>' + kv[0] + "</td><td class=\"num\">" + kv[1] + "</td></tr>").join("");
  const aside = DATA.s.map((s) =>
    '<tr class="static"><td>' + esc(s[0]) + "</td><td>" + esc(CATS[s[1]]) + "</td><td class=\"num\">" +
    fmt$(s[2]) + "</td><td>" + KIND[s[3]] + "</td></tr>").join("");
  el.innerHTML =
    "<h2>Method</h2>" +
    "<p>The board prices each pre-token protocol off the protocols whose tokens already trade. " +
    "On the traded peers, market cap is fitted as a power law of TVL — a least-squares line in log-log " +
    "space, log(cap) = " + M.a + " + " + M.b + " × log(TVL) — plus a per-category log offset shrunk toward " +
    "zero with prior strength 6. Three hand-set tilts from the protocol's own record then apply: momentum " +
    "(40% of its 7-day TVL change, clamped −60%…+120%; a missing change reads as 1.0), maturity (0.75 rising " +
    "toward 1.20 with a 540-day constant; no listing date reads as exactly 1.0), and breadth (+2% per chain " +
    "past the first, capped at ten). Fitted tilt weights were tested and rejected: on 118 fit points they " +
    "chase noise and degrade the out-of-sample splits.</p>" +
    "<h3>The cleaned fit set</h3>" +
    "<p>The fit uses " + M.fitN + " of the " + M.peerN + " positively priced peers. Excluded: the CEX and Chain " +
    "categories — an exchange's or a chain's token price does not read off the TVL its record tracks, and leaving " +
    "them in bends the curve for everyone else. The excluded peers, still priced as test cases in every split: " +
    M.excluded.map((e) => esc(e[0]) + " (" + esc(e[1]) + ")").join(", ") + ".</p>" +
    "<h3>Validation — every figure refits on the fit side only</h3>" +
    scoreTable(["Leave-one-out ladder (128 priced peers)", "Median miss", "Within 2x", "Within 3x", "n"], ladder) +
    "<p></p>" +
    scoreTable(["Out-of-sample splits (full model)", "Median miss", "Within 2x", "Within 3x", "n"], splits) +
    "<p></p>" +
    scoreTable(["Tilt ablations", "LOO miss", "Time-split miss"], abl) +
    "<p>Rank quality of the leave-one-out predictions: Spearman " + M.spearman +
    "; top-20 overlap with the actual largest caps " + M.top20 + "/20. Reading: the cleaned fit's gain " +
    "concentrates where it should — pricing newer protocols from older ones (the time split) — while " +
    "leave-one-out, which mostly tests same-era pricing, is unchanged. The tilts are within noise on " +
    "leave-one-out and earn their keep on the time split; the ablation table shows both, not just the flattering one.</p>" +
    "<h3>The ledger — every protocol in the snapshot, accounted for</h3>" +
    scoreTable(["Class", "Count"], ledger) +
    "<p>Set-aside rules, applied to protocols recording no token: conduit categories (Bridge, Canonical Bridge, " +
    "Liquid Staking, Liquid Restaking, Restaked BTC, CEX); names ending in a version marker (V2, v3, 2.0…); " +
    "names containing the whole words wrapped, staked or staking; names beginning with an exchange's name " +
    "(Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex, Gemini). These are conduits, redeployments and " +
    "house products, not independent launch candidates. The full set-aside ledger:</p>" +
    scoreTable(["Set-aside protocol", "Category", "TVL", "Reason"], aside) +
    "<h3>Verdicts and farm economics</h3>" +
    "<p>A farmer's expected slice of a launch is 10% of implied value times the fraction of the pool the ticket " +
    "buys (ticket ÷ TVL; ticket = 0.01% of TVL clamped to $250–$5,000). Against the slice stand the plan's fees " +
    "and 4% APR forgone interest over the 84-day plan. <b>Farm</b>: net positive even at the band low (P25). " +
    "<b>Thin</b>: net positive at the point estimate only. <b>Skip</b>: the slice does not cover costs. " +
    "Counts at the stated 10% share: Farm " + M.counts.Farm + ", Thin " + M.counts.Thin + ", Skip " + M.counts.Skip +
    ". Sensitivity — the same verdicts recomputed at half the share (5%): Farm " + M.countsHalf.Farm +
    ", Thin " + M.countsHalf.Thin + ", Skip " + M.countsHalf.Skip + ".</p>" +
    "<p>Fee schedule behind every plan: gas per action — Ethereum $12, major L2s $0.60, Solana $0.25, BSC $0.40, " +
    "Polygon $0.10, Avalanche $0.80, other chains $1.50; bridge leg off Ethereum $18 in, $12 back. The stop rule " +
    "in every plan is numeric: exit if TVL falls 10% under the entry mark, with the dollar level printed in the plan.</p>" +
    "<h3>Peer scatter — the fit against the record</h3><div id=\"scatter\"></div>" +
    "<p>Traded peers (blue; hollow = excluded from the fit), the fitted curve, and the board's implied values " +
    "(green) on the same axes. The vertical spread around the curve is the honest uncertainty the bands report.</p>";
  renderScatter();
}
function renderScatter() {
  const el = document.getElementById("scatter");
  if (!el) return;
  const W = 720, H = 440, L = 70, R = 14, T = 12, B = 42;
  const xs = [...PEERS.map((p) => p.tvl), ...ROWS.map((x) => x.r[3])];
  const lo = Math.log10(Math.min(...xs)), hi = Math.log10(Math.max(...xs));
  const ys = [...PEERS.map((p) => p.mcap), ...ROWS.map((x) => x.r[9])];
  const ylo = Math.log10(Math.min(...ys)), yhi = Math.log10(Math.max(...ys));
  const X = (v) => L + (Math.log10(v) - lo) / (hi - lo) * (W - L - R);
  const Y = (v) => T + (yhi - Math.log10(v)) / (yhi - ylo) * (H - T - B);
  let s = '<svg width="' + W + '" height="' + H + '" role="img">';
  s += '<rect x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '" fill="#161b22" stroke="#2a3240"/>';
  const t0 = Math.min(...xs), t1 = Math.max(...xs);
  const v0 = Math.exp(FIT.a + FIT.b * Math.log(t0)), v1 = Math.exp(FIT.a + FIT.b * Math.log(t1));
  s += '<line x1="' + X(t0).toFixed(1) + '" y1="' + Y(v0).toFixed(1) + '" x2="' + X(t1).toFixed(1) +
    '" y2="' + Y(v1).toFixed(1) + '" stroke="#e3b341" stroke-width="1.5"/>';
  for (const x of ROWS) {
    s += '<circle cx="' + X(x.r[3]).toFixed(1) + '" cy="' + Y(x.r[9]).toFixed(1) + '" r="2.4" fill="#4cc38a" opacity="0.75"/>';
  }
  for (const p of PEERS) {
    const ex = EXCLUDED[p.cat];
    s += '<circle cx="' + X(p.tvl).toFixed(1) + '" cy="' + Y(p.mcap).toFixed(1) + '" r="3" ' +
      (ex ? 'fill="none" stroke="#f47067"' : 'fill="#6cb6ff" opacity="0.8"') + "/>";
  }
  s += '<text x="' + L + '" y="' + (H - 22) + '">TVL ' + fmt$(Math.min(...xs)) + '</text>';
  s += '<text x="' + (W - R - 90) + '" y="' + (H - 22) + '">' + fmt$(Math.max(...xs)) + "</text>";
  s += '<text x="6" y="' + (T + 10) + '">cap / value</text>';
  s += '<text x="6" y="' + (H - B) + '">' + fmt$(Math.min(...ys)) + "</text>";
  el.innerHTML = s + "</svg>";
}
function route() {
  const h = location.hash || "#board";
  const board = document.getElementById("view-board");
  const detail = document.getElementById("view-detail");
  const method = document.getElementById("view-method");
  board.hidden = detail.hidden = method.hidden = true;
  document.getElementById("nav-board").className = "";
  document.getElementById("nav-method").className = "";
  if (h.startsWith("#detail=")) {
    detail.hidden = false;
    renderDetail(h.slice("#detail=".length));
  } else if (h === "#method") {
    method.hidden = false;
    document.getElementById("nav-method").className = "on";
    renderMethod();
  } else {
    board.hidden = false;
    document.getElementById("nav-board").className = "on";
    renderBoard();
  }
}
if (typeof document !== "undefined") {
  const sel = document.getElementById("fcat");
  for (const c of [...new Set(ROWS.map((x) => x.cat))].sort()) {
    const o = document.createElement("option");
    o.textContent = c;
    sel.appendChild(o);
  }
  document.getElementById("subline").textContent =
    "Snapshot " + M.asOf + " (" + M.source + "), TVL floor " + fmt$(M.floor) + " — " +
    M.ledger.ranked + " pre-token candidates priced off " + M.fitN + " cleaned traded peers.";
  for (const id of ["q", "fcat", "fver", "fwatch"]) {
    document.getElementById(id).addEventListener("input", renderBoard);
  }
  window.addEventListener("hashchange", route);
  route();
  const badge = document.getElementById("badge");
  const syncTxt = "Recomputed in this browser from the shipped data — fit " +
    (fitOk ? "matches" : "DOES NOT match") + " the shipped coefficients; " +
    valueMatch + "/" + ROWS.length + " implied values and " + verdictMatch + "/" + ROWS.length +
    " verdicts reproduce; farm-plan checksum " + (planHashOk ? "matches" : "DOES NOT match") + ".";
  badge.textContent = syncTxt + " Checking bootstrap bands (200 seeded refits)…";
  bootstrapCheck((ok) => {
    badge.textContent = syncTxt + " Bootstrap bands and rank ranges match on " + ok + "/" + ROWS.length + " rows.";
  });
}
if (typeof document === "undefined" && typeof module !== "undefined") {
  module.exports = { ROWS, FIT, valueMatch, verdictMatch, planHashOk, fitOk, bootstrapCheck };
}
