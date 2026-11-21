"use strict";
// Token Launch Radar dashboard. Renders window.RADAR (data.js, written by
// main.ts) and re-derives every row's implied value, band and verdict from
// the shipped coefficients, so the page checks its own board in the
// browser. The farm plan generator below mirrors lib/model.ts template
// for template; the board's plans and the page's plans are one text.

const PLAN = {
  Dexs: [6, "swap a basket of pairs and hold a small liquidity position"],
  Lending: [10, "supply collateral, borrow conservatively and repay on schedule"],
  CDP: [12, "open a small vault, mint the stablecoin and keep collateral well above liquidation"],
  Yield: [7, "deposit into the flagship vault and roll the position as epochs turn"],
  "Yield Aggregator": [7, "deposit into two vaults and rotate between them monthly"],
  Derivatives: [14, "trade small perpetual positions with tight stops and low leverage"],
  Perps: [14, "trade small perpetual positions with tight stops and low leverage"],
  "Risk Curators": [9, "allocate to a curated vault and follow the curator's rebalances"],
  "Onchain Capital Allocator": [9, "allocate to a curated vault and follow the curator's rebalances"],
  RWA: [11, "buy a small position in the flagship real-world asset pool"],
  "Basis Trading": [13, "run a small delta-neutral basis position and rebalance weekly"],
  "Staking Pool": [5, "stake a modest amount and restake the rewards as they land"],
  Services: [8, "use the paid service tier once a month and keep invoices"],
  "Launchpad": [10, "join one launch allocation with a small ticket and hold the result"],
  "NFT Lending": [9, "lend against one blue-chip NFT at a conservative loan-to-value"],
  "Options": [12, "buy one small defined-risk option structure per month"],
  "Prediction Market": [8, "take small positions on liquid markets and settle them out"],
  "Chain": [8, "bridge in, use the native apps and keep gas in the chain token"],
};
const DEFAULT_PLAN = [8, "use the core product the way a real user would"];
const VERDICTS = ["Farm", "Thin", "Skip"];

const M = window.RADAR.m;
const rows = window.RADAR.r.map((r) => ({
  slug: r[0], name: r[1], rank: r[2], value: r[3], lo: r[4], hi: r[5],
  tvl: r[6], change: r[7], age: r[8], nChains: r[9], firstChain: r[10],
  category: M.cats[r[11]], verdict: r[12], reward: r[13], cost: r[14], wl: r[15] === 1,
}));

function planFor(category) { return PLAN[category] || DEFAULT_PLAN; }
function stakeTier(tvl) { return Math.max(100, Math.min(5000, Math.round(tvl * 0.00002))); }
function round3sig(v) {
  if (v <= 0) return 0;
  const d = Math.pow(10, Math.floor(Math.log10(v)) - 2);
  return Math.round(v / d) * d;
}
function farmSteps(r) {
  const plan = planFor(r.category);
  const stake = stakeTier(r.tvl);
  const weekly = plan[0];
  const total = weekly * M.weeks + (r.nChains > 1 ? 15 : 0);
  const weeks = M.weeks;
  return [
    `Start on ${r.firstChain}: open ${r.name} in a fresh wallet, bookmark the official app and keep $${stake} of working capital ready for the first session.`,
    `Make a first real deposit of about $${stake} and ${plan[1]}; a position you would be content to hold is the whole point of week one.`,
    `Repeat the core activity weekly for ${weeks} weeks; expected fees and gas come to about $${weekly} a week, roughly $${total} across the full campaign.`,
    r.nChains > 1
      ? `Spread activity across ${r.name}'s ${r.nChains} chains over the campaign; breadth is cheap evidence of a real user and the bridge budget is already in the $${total}.`
      : `Stay on ${r.firstChain} and deepen the position instead of spreading thin; add a second product inside ${r.name} from week four if one exists.`,
    `Join ${r.name}'s governance and community channels, vote on every proposal you can and keep screenshots and transaction hashes of each week's activity.`,
    `Review monthly against the radar: the implied value is $${r.value.toLocaleString("en-US")} with a band of $${r.lo.toLocaleString("en-US")} to $${r.hi.toLocaleString("en-US")}; if TVL falls for three straight weeks, pause new deposits.`,
    `If a token launches, claim in the first window, then sell or hedge in tranches rather than all at once; the band low, not the headline value, is the number to plan around.`,
  ];
}
function recompute(r) {
  const c = r.change === "" ? 0 : Math.max(-30, Math.min(60, r.change));
  const logv = M.a + M.b * Math.log(r.tvl)
    + (M.mom * c) / 100
    + M.mat * Math.log1p(r.age / 365)
    + M.br * Math.log(Math.max(1, r.nChains));
  const value = Math.round(Math.exp(logv));
  const lo = round3sig(value * Math.exp(M.q05));
  const hi = round3sig(value * Math.exp(M.q95));
  const weekly = planFor(r.category)[0];
  const cost = weekly * M.weeks + (r.nChains > 1 ? 15 : 0);
  const reward = Math.round(lo * M.alloc * M.share);
  const ratio = cost > 0 ? reward / cost : 0;
  const verdict = ratio >= 3 ? 0 : ratio >= 1 ? 1 : 2;
  return { value, lo, hi, cost, reward, verdict };
}

let okCount = 0;
for (const r of rows) {
  const x = recompute(r);
  if (x.value === r.value && x.lo === r.lo && x.hi === r.hi
    && x.cost === r.cost && x.reward === r.reward && x.verdict === r.verdict) okCount++;
}
const badge = document.getElementById("recompute-badge");
badge.textContent = `recomputed ${okCount}/${rows.length} rows in your browser — value, band and verdict reproduced from the shipped coefficients`;
if (okCount === rows.length) badge.classList.add("ok");

const money = (v) => "$" + v.toLocaleString("en-US");
const L = M.ledger, B = M.bt;
document.getElementById("stats").innerHTML = [
  [L.total, "protocols in snapshot"],
  [L.ranked, "ranked on the board"],
  [rows.filter((r) => r.wl).length, "watchlist covered"],
  [L.traded, "already trade a token"],
  [L.setAside, "wrapped / staked set aside"],
  [`${B.timeMedian}×`, "time-split median miss"],
  [`${B.timeWithin2}%`, "time-split within 2×"],
  [`${B.looMedian}×`, "leave-one-out median miss"],
].map(([v, s]) => `<div class="stat"><b>${v}</b><span>${s}</span></div>`).join("");
document.getElementById("model-line").textContent =
  `Fitted on ${M.n} token-bearing comparables (CEX and Chain categories excluded): log(market cap) = ${M.a} + ${M.b} × log(TVL), with small tilts for seven-day momentum (${M.mom}), maturity (${M.mat}) and chain breadth (${M.br}). Backtest: fit on the ${B.nTrain} comparables listed before 2024 and tested on ${B.nTest} later ones gives a median miss of ${B.timeMedian}× with ${B.timeWithin2}% within 2×; leave-one-out over ${B.looN} gives ${B.looMedian}× and a Spearman rank correlation of ${B.looSpearman}. Verdicts assume ${M.alloc * 100}% of supply reaches the community and a farmer's expected share of that is ${M.share * 100}%: Farm when the expected reward at the band low is at least 3× the ${M.weeks}-week cost, Thin when it merely covers it.`;

let verdictFilter = "all";
let sortKey = "rank";
const tbody = document.getElementById("rows");
const detail = document.getElementById("detail");

function visible() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  const wlOnly = document.getElementById("wl-only").checked;
  const out = rows.filter((r) =>
    (verdictFilter === "all" || r.verdict === Number(verdictFilter))
    && (!wlOnly || r.wl)
    && (q === "" || r.name.toLowerCase().includes(q) || r.category.toLowerCase().includes(q) || r.slug.includes(q)));
  const key = { rank: "rank", value: "value", tvl: "tvl", lo: "lo" }[sortKey];
  if (key) out.sort((x, y) => (sortKey === "rank" ? x.rank - y.rank : y[key] - x[key]));
  if (sortKey === "change") out.sort((x, y) => (y.change === "" ? -1e9 : y.change) - (x.change === "" ? -1e9 : x.change));
  return out;
}
function render() {
  const out = visible();
  tbody.innerHTML = out.map((r) => {
    const ch = r.change === "" ? "—" : `<span class="${r.change >= 0 ? "pos" : "neg"}">${r.change >= 0 ? "+" : ""}${r.change.toFixed(2)}%</span>`;
    return `<tr data-slug="${r.slug}"><td>${r.rank}</td>`
      + `<td class="name">${r.name}${r.wl ? '<span class="wl-dot">watchlist</span>' : ""}</td>`
      + `<td>${r.category}</td><td>${money(r.tvl)}</td><td>${ch}</td>`
      + `<td><b>${money(r.value)}</b></td><td>${money(r.lo)} – ${money(r.hi)}</td>`
      + `<td><span class="pill ${VERDICTS[r.verdict].toLowerCase()}">${VERDICTS[r.verdict]}</span></td></tr>`;
  }).join("");
  document.getElementById("count").textContent = `${out.length} of ${rows.length} protocols shown`;
  for (const tr of tbody.querySelectorAll("tr")) {
    tr.addEventListener("click", () => openDetail(tr.dataset.slug));
  }
}
let noScroll = false;
function openDetail(slug) {
  const r = rows.find((x) => x.slug === slug);
  if (!r) return;
  const steps = farmSteps(r).map((s) => `<li>${s}</li>`).join("");
  detail.hidden = false;
  detail.innerHTML = `<h2>${r.name}</h2>`
    + `<p class="sub">${r.category} · first tracked on ${r.firstChain} · ${r.nChains} chain${r.nChains > 1 ? "s" : ""} · ${r.age} days with no token recorded${r.wl ? " · on the watchlist" : ""}</p>`
    + `<div class="big">${money(r.value)} implied value</div>`
    + `<dl>`
    + `<div><dt>Band (bootstrap 5–95%)</dt><dd>${money(r.lo)} – ${money(r.hi)}</dd></div>`
    + `<div><dt>TVL</dt><dd>${money(r.tvl)}</dd></div>`
    + `<div><dt>7-day change</dt><dd>${r.change === "" ? "not reported" : r.change.toFixed(2) + "%"}</dd></div>`
    + `<div><dt>Verdict</dt><dd>${VERDICTS[r.verdict]} — expected reward ${money(r.reward)} at the band low vs ${money(r.cost)} of farming cost over ${M.weeks} weeks</dd></div>`
    + `</dl><h3>Farm plan</h3><ol>${steps}</ol>`;
  if (!noScroll) detail.scrollIntoView({ block: "start" });
}
document.getElementById("q").addEventListener("input", render);
document.getElementById("sort").addEventListener("change", (e) => { sortKey = e.target.value; render(); });
document.getElementById("wl-only").addEventListener("change", render);
document.getElementById("verdict-filter").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  verdictFilter = b.dataset.v;
  for (const x of e.currentTarget.querySelectorAll("button")) x.classList.toggle("on", x === b);
  render();
});
render();
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get("v")) {
  const code = { farm: "0", thin: "1", skip: "2" }[hash.get("v")];
  if (code !== undefined) {
    verdictFilter = code;
    for (const x of document.querySelectorAll("#verdict-filter button")) {
      x.classList.toggle("on", x.dataset.v === code);
    }
    render();
  }
}
if (hash.get("d")) {
  // A deep link to one protocol opens in a focused detail mode: the
  // panel sits at the top, the board one click of "All verdicts" away.
  noScroll = true;
  document.body.classList.add("detail-mode");
  openDetail(hash.get("d"));
}
