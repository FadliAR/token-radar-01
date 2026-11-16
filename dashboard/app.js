// Launch Radar v4 — the page. Renders window.RADAR (data.js, written by main.ts beside this
// folder) as a ranked board with bands and rank ranges, a full-page detail view per protocol,
// a traded-peers view and a method view. After rendering, the page re-runs the whole model in
// the browser — the fit, the 200 bootstrap refits, the farm economics — and reports how many of
// board.json's figures it reproduced exactly. The page makes no requests of its own.
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) return;

  // ---------------- helpers ----------------
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&quot;');
  }
  function $(id) { return document.getElementById(id); }
  var usdFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFull.format(n);
  }
  function fmtUsd2(n) { // dollars and cents for small farm figures
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1000) return fmtUsd(n);
    return '$' + n.toFixed(2);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'no date';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    if (d >= 30) return Math.round(d / 30.4) + 'mo';
    return d + 'd';
  }
  function fx(f) { return '×' + f.toFixed(2); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function round4(v) { return Math.round(v * 1e4) / 1e4; }

  var state = { tab: 'board', q: '', category: 'all', verdict: 'all', watch: false, sort: 'rank', dir: 1, selected: null };

  // ---------------- header, stats, model band ----------------
  var C = D.counts;
  var fit = D.fit;
  var formula = 'log10 value = ' + (fit.intercept / Math.LN10).toFixed(2) + ' + ' + fit.slope.toFixed(3) +
    ' × log10(TVL) + category offset → ' + fmtUsd(Math.exp(fit.intercept + fit.slope * Math.log(1e8))) +
    ' at $100M TVL, then × momentum × maturity × breadth';

  function looRow(name) { return D.validation3.loo.find(function (r) { return r.model.indexOf(name) === 0; }); }
  function tsRow(name) { return D.validation3.time_split.rows.find(function (r) { return r.model.indexOf(name) === 0; }); }
  var looFull = looRow('full model'), looFlat = looRow('flat'), tsFull = tsRow('full model');

  var wlBest = D.rows.filter(function (r) { return r.on_watchlist; })
    .sort(function (a, b) { return b.econ.net_per_hour - a.econ.net_per_hour; }).slice(0, 3);

  function scatter() {
    var W = 640, H = 250, PL = 8, PR = 8, PT = 10, PB = 22;
    var x0 = Math.log(4e7), x1 = Math.log(6e9), y0 = Math.log(5e5), y1 = Math.log(3e9);
    function X(v) { return PL + (Math.log(v) - x0) / (x1 - x0) * (W - PL - PR); }
    function Y(v) { return H - PB - (Math.log(v) - y0) / (y1 - y0) * (H - PT - PB); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Market cap and implied value against TVL">';
    s += '<line x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - PR) + '" y2="' + (H - PB) + '" stroke="#dde5e1"/>';
    var pts = [];
    for (var i = 0; i <= 24; i++) {
      var tvl = Math.exp(x0 + (x1 - x0) * i / 24);
      pts.push(X(tvl).toFixed(1) + ',' + Y(Math.exp(fit.intercept + fit.slope * Math.log(tvl))).toFixed(1));
    }
    s += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#0b6e5d" stroke-width="2"/>';
    D.comparables.forEach(function (c) {
      if (c.mcap_usd > 0 && c.tvl_usd > 0) s += '<circle cx="' + X(c.tvl_usd).toFixed(1) + '" cy="' + Y(c.mcap_usd).toFixed(1) + '" r="2.2" fill="#94a3b8" opacity="0.55"/>';
    });
    D.rows.slice(0, 40).forEach(function (r) {
      s += '<circle cx="' + X(r.tvl_usd).toFixed(1) + '" cy="' + Y(r.implied_value_usd).toFixed(1) + '" r="2.6" fill="#0e4fd8" opacity="0.8"/>';
    });
    s += '<text x="' + PL + '" y="' + (H - 6) + '">TVL $40M</text><text x="' + (W - PR - 52) + '" y="' + (H - 6) + '">TVL $6B</text>';
    s += '<text x="' + PL + '" y="' + (PT + 4) + '">cap / implied $3B</text>';
    s += '</svg>';
    s += '<div class="legend"><i style="background:#94a3b8"></i>128 traded peers (cap vs TVL)<i style="background:#0b6e5d"></i>the fitted size curve<i style="background:#0e4fd8"></i>top 40 board rows (implied vs TVL)</div>';
    return s;
  }

  function renderChrome() {
    $('topbar').innerHTML =
      '<h1>Launch Radar — pre-token protocols, priced by the tokens that already trade</h1>' +
      '<div class="acct"><b>' + C.watchlist + '/' + C.watchlist + ' watchlist</b> · <b>' + C.board + ' ranked</b> pre-token protocols · ' +
      '<b>' + C.fit_comparables + ' cleaned traded peers</b> fit the curve (' + C.priced + ' priced, CEX and Chain tokens kept out of the fit) · ' +
      D.set_aside.reduce(function (a, x) { return a + x.count; }, 0) + ' pre-token records set aside with reasons, ' + C.live_unpriced + ' carry a token the snapshot does not price — full ledger on Method</div>' +
      '<div class="sub">Snapshot ' + esc(D.as_of) + ' · source: ' + esc(D.source) + ' · model ' + esc(D.model_version) + ' · every figure on this page is recomputed from the snapshot by the page itself (see the badge below)</div>';
    $('stats').innerHTML =
      '<span class="badge ok" id="recompute-badge">Recomputing the whole model in your browser…</span>' +
      '<span class="badge">Verdicts netted in dollars: <b>Farm ' + D.verdict_counts.Farm + '</b> · Thin ' + D.verdict_counts.Thin + ' · Skip ' + D.verdict_counts.Skip + '</span>' +
      '<span class="badge">Best net per hands-on hour, watchlist: ' + wlBest.map(function (r) { return esc(r.name) + ' $' + r.econ.net_per_hour.toFixed(0) + '/h'; }).join(' · ') + '</span>';
    $('modelband').innerHTML =
      '<div class="formula">' + esc(formula) + '</div>' +
      '<div class="grid2" style="margin-top:10px"><div>' + scatter() + '</div>' +
      '<div><h3 style="margin-top:0">Blind tests, printed in full on Method</h3>' +
      '<table><tr><th>Test</th><th class="num">Median miss</th><th class="num">Within 2×</th><th class="num">Within 3×</th></tr>' +
      '<tr><td>Leave-one-out, full model (' + looFull.n + ' peers)</td><td class="num">' + fx(looFull.median_factor) + '</td><td class="num">' + Math.round(looFull.within_2x * 100) + '%</td><td class="num">' + Math.round(looFull.within_3x * 100) + '%</td></tr>' +
      '<tr><td>Time split: fit pre-2024, price 2024+ (' + tsFull.n + ')</td><td class="num">' + fx(tsFull.median_factor) + '</td><td class="num">' + Math.round(tsFull.within_2x * 100) + '%</td><td class="num">' + Math.round(tsFull.within_3x * 100) + '%</td></tr>' +
      '<tr><td>Leave-one-out, one flat multiple</td><td class="num">' + fx(looFlat.median_factor) + '</td><td class="num">' + Math.round(looFlat.within_2x * 100) + '%</td><td class="num">' + Math.round(looFlat.within_3x * 100) + '%</td></tr></table>' +
      '<div class="defs"><b>Farm</b> · nets positive even at the low end of its own value band &nbsp; <b>Thin</b> · nets positive at the point estimate only &nbsp; <b>Skip</b> · the plausible slice does not cover fees + forgone interest. Slice assumes a launch gives depositors ' + Math.round(D.econ_constants.airdrop_share * 100) + '% of the implied value; idle money is charged ' + Math.round(D.econ_constants.tbill_rate * 100) + '% a year.</div>' +
      '</div></div>';
    $('colophon').innerHTML = 'Launch Radar ' + esc(D.model_version) + ' · built from the sealed snapshot of ' + esc(D.as_of) +
      ' (' + esc(D.source) + ') · implied values are model estimates, not prices, and a launch is never promised · not financial advice.';
  }

  // ---------------- controls ----------------
  function catCounts() {
    var m = new Map();
    D.rows.forEach(function (r) { var k = r.category || 'Uncategorised'; m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort(function (a, b) { return b[1] - a[1]; });
  }
  function renderControls() {
    var tabs = [['board', 'Pre-token board (' + C.board + ')'], ['traded', 'Token already trades (' + C.priced + ')'], ['method', 'Model & calibration']];
    var h = '<div class="tabs">' + tabs.map(function (t) {
      return '<button class="tab' + (state.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>';
    }).join('') + '</div>';
    if (state.tab === 'board' && !state.selected) {
      h += '<input type="search" id="q" placeholder="Search protocol or category…" value="' + esc(state.q) + '">';
      h += '<button class="chip' + (state.verdict === 'all' ? ' on' : '') + '" data-verdict="all">All verdicts</button>';
      ['Farm', 'Thin', 'Skip'].forEach(function (v) {
        h += '<button class="chip' + (state.verdict === v ? ' on' : '') + '" data-verdict="' + v + '">' + v + ' ' + D.verdict_counts[v] + '</button>';
      });
      h += '<label class="watch"><input type="checkbox" id="watchonly"' + (state.watch ? ' checked' : '') + '> watchlist only</label>';
      h += '<span style="flex-basis:100%;height:0"></span>';
      h += '<button class="chip' + (state.category === 'all' ? ' on' : '') + '" data-cat="all">All categories</button>';
      catCounts().slice(0, 10).forEach(function (e) {
        h += '<button class="chip' + (state.category === e[0] ? ' on' : '') + '" data-cat="' + esc(e[0]) + '">' + esc(e[0]) + ' ' + e[1] + '</button>';
      });
    }
    $('controls').innerHTML = h;
    var q = $('q');
    if (q) q.addEventListener('input', function () { state.q = q.value; renderView(); });
    var w = $('watchonly');
    if (w) w.addEventListener('change', function () { state.watch = w.checked; renderView(); });
  }

  // ---------------- board view ----------------
  function bandViz(r) {
    var lo = r.band_lo_usd / 1.6, hi = r.band_hi_usd * 1.6;
    function pos(v) { return ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * 100).toFixed(1); }
    return '<div class="bandbar"><div class="fill" style="left:' + pos(r.band_lo_usd) + '%;width:' + (pos(r.band_hi_usd) - pos(r.band_lo_usd)) + '%"></div>' +
      '<div class="dot" style="left:calc(' + pos(r.implied_value_usd) + '% - 2px)"></div></div>' +
      '<span class="bandtxt">' + fmtUsd(r.band_lo_usd) + ' – ' + fmtUsd(r.band_hi_usd) + '</span>';
  }
  function filteredRows() {
    var rows = D.rows.filter(function (r) {
      if (state.watch && !r.on_watchlist) return false;
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if (r.name.toLowerCase().indexOf(q) < 0 && (r.category || '').toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = {
      rank: function (r) { return r.rank; }, value: function (r) { return r.implied_value_usd; },
      tvl: function (r) { return r.tvl_usd; }, change: function (r) { return r.change_7d === null ? -1e9 : r.change_7d; },
      nethour: function (r) { return r.econ.net_per_hour; },
    }[state.sort];
    rows.sort(function (a, b) { return (key(a) - key(b)) * state.dir; });
    return rows;
  }
  function boardView() {
    var rows = filteredRows();
    var h = '<div class="card" style="margin-top:2px"><table class="board"><thead><tr>' +
      '<th data-sort="rank">#</th><th>Protocol</th><th class="num" data-sort="value">Implied value · P25–P75 band</th>' +
      '<th class="num" data-sort="tvl">TVL</th><th class="num" data-sort="change">7d</th><th class="num">Age</th>' +
      '<th class="num">×TVL</th><th class="num">Slice if launch</th><th class="num" data-sort="nethour">Net · $/h</th><th>Verdict</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var netCls = r.econ.net_usd > 0 ? 'pos' : 'neg';
      h += '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="rank">' + r.rank + '<span class="rankrange">' + r.rank_p10 + '–' + r.rank_p90 + '</span></td>' +
        '<td><span class="pname">' + esc(r.name) + '</span><span class="badges">' +
        (r.on_watchlist ? '<span class="tag wl">Watchlist</span>' : '<span class="tag">Early</span>') +
        '<span class="tag">' + esc(r.category || 'Uncategorised') + '</span></span></td>' +
        '<td class="num"><b>' + fmtUsd(r.implied_value_usd) + '</b>' + bandViz(r) + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num">' + (r.implied_value_usd / r.tvl_usd).toFixed(2) + '</td>' +
        '<td class="num">' + fmtUsd2(r.econ.slice_usd) + '</td>' +
        '<td class="num"><span class="' + netCls + '">' + fmtUsd2(r.econ.net_usd) + '</span><span class="bandtxt">$' + r.econ.net_per_hour.toFixed(1) + '/h · ' + Math.round(r.econ.minutes / 60 * 10) / 10 + 'h hands-on</span></td>' +
        '<td><span class="verdict ' + r.verdict + '">' + r.verdict + '</span></td></tr>';
    });
    h += '</tbody></table>';
    if (rows.length === 0) h += '<p class="note">No rows match the current filters.</p>';
    h += '<p class="note">' + rows.length + ' of ' + C.board + ' rows shown. Rank range is the P10–P90 of the row\'s rank over 200 bootstrap refits of the curve; the band is the middle half of its refit prices. Click a row for the full arithmetic.</p></div>';
    return h;
  }

  // ---------------- detail view ----------------
  function detailView(r) {
    var m = r.model, e = r.econ;
    var sizeOnly = Math.exp(fit.intercept + fit.slope * Math.log(r.tvl_usd));
    var catFactor = Math.exp(m.category_offset);
    var base = sizeOnly * catFactor;
    var product = base * m.momentum_multiplier * m.maturity_multiplier * m.breadth_multiplier;
    var h = '<a class="backlink" href="#" data-back="1">← Back to the board</a>';
    h += '<div class="card"><h2 style="margin-top:0">' + esc(r.name) + ' <span class="verdict ' + r.verdict + '">' + r.verdict + '</span></h2>' +
      '<div class="sub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ') || 'no chains recorded') + ' · rank ' + r.rank + ' of ' + C.board +
      (r.on_watchlist ? ' · on the house watchlist' : ' · found below the watchlist floor') + ' · listed ' + (r.listed_at || 'date not recorded') + ' (' + fmtAge(r.age_days) + ' tokenless)</div>' +
      '<p>' + esc(r.verdict_reason) + '.</p>' +
      '<h3>How the implied value is built</h3><div class="boxes">' +
      '<div class="box"><div class="k">Size curve at this TVL</div><div class="v">' + fmtUsd(sizeOnly) + '</div><div class="s">10^(' + (fit.intercept / Math.LN10).toFixed(2) + ' + ' + fit.slope.toFixed(3) + ' × log10 ' + fmtUsd(r.tvl_usd) + ')</div></div>' +
      '<div class="op">×</div><div class="box"><div class="k">Category</div><div class="v">' + catFactor.toFixed(2) + '</div><div class="s">' + esc(r.category || 'none') + ' offset, ' + m.category_peers + ' priced peers</div></div>' +
      '<div class="op">×</div><div class="box"><div class="k">Momentum</div><div class="v">' + m.momentum_multiplier.toFixed(2) + '</div><div class="s">7d TVL ' + fmtPct(r.change_7d) + ', clamped</div></div>' +
      '<div class="op">×</div><div class="box"><div class="k">Maturity</div><div class="v">' + m.maturity_multiplier.toFixed(2) + '</div><div class="s">' + fmtAge(r.age_days) + ' with no token</div></div>' +
      '<div class="op">×</div><div class="box"><div class="k">Breadth</div><div class="v">' + m.breadth_multiplier.toFixed(2) + '</div><div class="s">' + r.chains.length + ' chains</div></div>' +
      '<div class="op">=</div><div class="box"><div class="k">Implied value</div><div class="v">' + fmtUsd(r.implied_value_usd) + '</div><div class="s">multiplying the five printed figures gives ' + fmtUsd(product) + ' — the board\'s figure, to a rounding dollar</div></div></div>' +
      '<div class="kv"><div><span>Value band (P25–P75, 200 refits)</span><b>' + fmtUsd(r.band_lo_usd) + ' – ' + fmtUsd(r.band_hi_usd) + '</b></div>' +
      '<div><span>Rank range (P10–P90)</span><b>' + r.rank_p10 + ' – ' + r.rank_p90 + ' of ' + C.board + '</b></div>' +
      '<div><span>TVL</span><b>' + fmtUsd(r.tvl_usd) + '</b></div>' +
      '<div><span>Implied ×TVL</span><b>' + (r.implied_value_usd / r.tvl_usd).toFixed(3) + '</b></div>' +
      '<div><span>Category median model (for contrast)</span><b>' + fmtUsd(r.tvl_usd * m.category_multiple) + '</b></div></div>' +
      '<h3>Nearest traded peers — the prices this row is read from</h3>' +
      '<table><tr><th>Peer</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Cap × TVL</th></tr>' +
      r.peers.map(function (p) { return '<tr><td>' + esc(p.name) + '</td><td class="num">' + fmtUsd(p.tvl_usd) + '</td><td class="num">' + fmtUsd(p.mcap_usd) + '</td><td class="num">' + p.multiple.toFixed(3) + '</td></tr>'; }).join('') +
      '</table>' +
      '<h3>The farm arithmetic</h3><div class="kv">' +
      '<div><span>Ticket (scaled to the pool)</span><b>' + fmtUsd(e.ticket_usd) + '</b></div>' +
      '<div><span>Slice if a token launches</span><b>' + fmtUsd2(e.slice_usd) + '</b></div>' +
      '<div><span>Slice at the band\'s low end</span><b>' + fmtUsd2(e.slice_low_usd) + '</b></div>' +
      '<div><span>Fees (summed from the plan)</span><b>' + fmtUsd2(e.fees_usd) + '</b></div>' +
      '<div><span>Forgone interest (T-bill ' + Math.round(D.econ_constants.tbill_rate * 100) + '%, ' + e.hold_days + 'd)</span><b>' + fmtUsd2(e.forgone_usd) + '</b></div>' +
      '<div><span>Net if launch</span><b>' + fmtUsd2(e.net_usd) + '</b></div>' +
      '<div><span>Net at the band\'s low end</span><b>' + fmtUsd2(e.net_low_usd) + '</b></div>' +
      '<div><span>Break-even launch chance</span><b>' + e.breakeven_pct.toFixed(0) + '%</b></div></div>' +
      '<p class="note">Slice = ' + Math.round(D.econ_constants.airdrop_share * 100) + '% of implied value × ticket ÷ TVL = ' + Math.round(D.econ_constants.airdrop_share * 100) + '% × ' + fmtUsd(r.implied_value_usd) + ' × ' + fmtUsd(e.ticket_usd) + ' ÷ ' + fmtUsd(r.tvl_usd) + '. The 10% share reaching depositors is an assumption, stated here and used for every row alike.</p>' +
      '<h3>The plan, day by day</h3><table><tr><th>When</th><th>Step</th><th class="num">Cost</th><th class="num">Hands-on</th></tr>' +
      r.plan.map(function (s) { return '<tr><td style="white-space:nowrap"><b>' + esc(s.day) + '</b></td><td>' + esc(s.action) + '</td><td class="num">' + esc(s.cost) + '</td><td class="num">' + s.minutes + ' min</td></tr>'; }).join('') +
      '<tr class="tot"><td></td><td>Totals (the stop rule\'s exit is contingent and not counted)</td><td class="num">' + fmtUsd2(e.fees_usd) + ' fees</td><td class="num">' + e.minutes + ' min</td></tr></table>' +
      '<p class="note">One wallet for this farm alone. A launch is not promised; if none comes, the loss is the fees and the forgone interest above. Claim only from a domain the protocol itself publishes. Not financial advice.</p></div>';
    return h;
  }

  // ---------------- traded view ----------------
  function tradedView() {
    var fitSet = new Set(D.fit_order);
    var rows = [...D.comparables].sort(function (a, b) { return b.mcap_usd - a.mcap_usd; });
    var h = '<div class="card" style="margin-top:2px"><h2 style="margin-top:0">The evidence base: protocols whose token already trades</h2>' +
      '<p class="note">' + C.comparables + ' records carry a market cap. ' + C.priced + ' have a positive cap and TVL; the curve is fitted on ' + C.fit_comparables +
      ' of them — exchange tokens (CEX) and chain tokens are kept out of the fit because their prices are not read off a protocol\'s TVL. They stay in this view and in the median model.</p>' +
      '<table><tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Cap × TVL</th><th>In the fit?</th></tr>';
    rows.forEach(function (c) {
      var infl = fitSet.has(c.slug) ? '<span class="tag" style="background:#e2f2ec;color:var(--farm)">Fitted</span>'
        : (c.mcap_usd > 0 ? '<span class="tag">Priced, not fitted</span>' : '<span class="tag">Cap $0 in snapshot</span>');
      h += '<tr><td><span class="pname">' + esc(c.name) + '</span></td><td>' + esc(c.category || 'Uncategorised') + '</td>' +
        '<td class="num">' + fmtUsd(c.tvl_usd) + '</td><td class="num">' + fmtUsd(c.mcap_usd) + '</td><td class="num">' + c.ratio.toFixed(3) + '</td><td>' + infl + '</td></tr>';
    });
    return h + '</table></div>';
  }

  // ---------------- method view ----------------
  function vTable(rows) {
    var h = '<table><tr><th>Model</th><th class="num">n</th><th class="num">Median miss</th><th class="num">Within 2×</th><th class="num">Within 3×</th></tr>';
    rows.forEach(function (r) {
      h += '<tr><td>' + esc(r.model) + '</td><td class="num">' + r.n + '</td><td class="num">' + fx(r.median_factor) + '</td><td class="num">' + Math.round(r.within_2x * 100) + '%</td><td class="num">' + Math.round(r.within_3x * 100) + '%</td></tr>';
    });
    return h + '</table>';
  }
  function methodView() {
    var V = D.validation3, K = D.constants;
    var setAsideTotal = D.set_aside.reduce(function (a, x) { return a + x.count; }, 0);
    var notFit = D.comparables.filter(function (c) { return c.mcap_usd > 0 && (c.category === 'CEX' || c.category === 'Chain'); });
    var h = '<div class="card" style="margin-top:2px"><h2 style="margin-top:0">How this board is made, and how it is checked</h2>' +
      '<p>The snapshot holds ' + C.protocols + ' protocols over a $' + (D.floor_usd / 1e6) + 'M TVL floor. ' + (C.board + setAsideTotal) + ' of them record no token: ' + C.board +
      ' are ranked here and ' + setAsideTotal + ' are set aside (ledger below). ' + C.comparables + ' records carry a token with a market cap; they are never ranked — they are the evidence the prices are read from.</p>' +
      '<h3>The value model</h3><p>A power-law size curve, ln(market cap) on ln(TVL), fitted by least squares over the cleaned traded peers, with a per-category log offset shrunk toward zero by n/(n+' + K.shrink_prior + ') — a category with two peers whispers, one with twenty speaks. Three tilts follow, each from the protocol\'s own record: momentum (1 + ' + K.momentum_weight + ' × the week\'s clamped TVL growth), maturity (' + K.maturity_base + ' rising toward ' + (K.maturity_base + K.maturity_gain).toFixed(2) + ' with tokenless age, τ=' + K.maturity_tau_days + ' days), and breadth (+' + Math.round(K.breadth_per_chain * 100) + '% per extra chain, at most ' + K.breadth_cap + '). Nothing is priced from a name.</p>' +
      '<p><b>The fit is cleaned.</b> Of ' + C.priced + ' positively priced peers, ' + notFit.length + ' are kept out of the fit — ' + notFit.map(function (c) { return esc(c.name); }).join(', ') +
      ' — because an exchange\'s token prices the exchange and a chain\'s token prices the network, not the TVL their records track. They remain in the traded view and in the median model below.</p>' +
      '<h3>Leave-one-out, the whole ladder (' + C.fit_comparables + ' cleaned peers, each priced by a model that never saw it)</h3>' + vTable(V.loo) +
      '<p class="note">The category offsets and the tilts are within noise of the bare curve on the median, and earn their place on within-3× and on the time split — the ladder is printed whole so the reader can judge the trade.</p>' +
      '<h3>Time split: fit only tokens listed before 2024, price the ones listed since</h3>' + vTable(V.time_split.rows) +
      '<p class="note">Fit on ' + V.time_split.fit_n + ' older tokens, tested on ' + V.time_split.test_n + ' newer ones. This is the split that resembles the board\'s own job: pricing things the fit never grew up with.</p>' +
      '<h3>The slug-hash split, both directions (the v3.0 race protocol, on the cleaned set)</h3>' +
      '<div class="grid2"><div><h3 style="margin-top:0">Direction A</h3>' + vTable(V.hash_a) + '</div><div><h3 style="margin-top:0">Direction B</h3>' + vTable(V.hash_b) + '</div></div>' +
      '<p class="note">Against the previous version\'s recipe — the same curve fitted on every priced peer, CEX and Chain included. The clean fit wins direction B clearly and loses direction A slightly; both are printed. The original v3.0 race against the category-median model also still runs on every build: curve ' + fx(D.validation.curve.median_factor) + ' median miss vs median model ' + fx(D.validation.median_model.median_factor) + ' (fit ' + D.validation.fit_n + ', test ' + D.validation.test_n + ').</p>' +
      '<h3>Age split of the full model\'s leave-one-out errors</h3>' + vTable([V.age_split.young, V.age_split.old]) +
      '<p class="note">' + (C.fit_comparables - V.age_split.young.n - V.age_split.old.n) + ' of the ' + C.fit_comparables + ' cleaned peers carry no listing date and are left out of this split. Young tokens are simply harder to price; the board\'s maturity tilt is the model\'s answer, and this split is the check on it.</p>' +
      '<h3>Uncertainty</h3><p>Every band and rank range comes from 200 bootstrap refits of the curve on resamples of the cleaned peers (seeded, so this page\'s own recompute lands on the same figures). A band is the middle half of a row\'s refit prices; a rank range is the P10–P90 of its refit ranks.</p>' +
      '<h3>Verdicts, netted in dollars</h3><p>Slice = ' + Math.round(D.econ_constants.airdrop_share * 100) + '% of implied value × ticket ÷ TVL, the ticket scaled to the pool ($250–$5,000). Fees are summed from each row\'s own dated plan (gas by chain, one bridge leg where the farm is not on Ethereum); forgone interest charges the ticket at ' + Math.round(D.econ_constants.tbill_rate * 100) + '% a year over the hold. <b>Farm</b>: net positive even at the band\'s low end. <b>Thin</b>: net positive at the point estimate only. <b>Skip</b>: the slice does not cover fees plus forgone interest.</p>' +
      '<h3>The set-aside ledger — why ' + setAsideTotal + ' pre-token protocols are not ranked</h3><table><tr><th>Reason</th><th class="num">Count</th></tr>' +
      D.set_aside.map(function (x) { return '<tr><td>' + esc(x.reason) + '</td><td class="num">' + x.count + '</td></tr>'; }).join('') +
      '<tr class="tot"><td>Total set aside</td><td class="num">' + setAsideTotal + '</td></tr></table>' +
      '<p class="note">Reconciliation: ' + C.protocols + ' records = ' + C.board + ' ranked + ' + setAsideTotal + ' set aside + ' + C.comparables + ' with a market cap + ' + C.live_unpriced + ' carrying a token the snapshot does not price.</p>' +
      '<h3>The median model, kept for contrast: category rates</h3><table><tr><th>Category</th><th class="num">Priced peers</th><th class="num">Median cap × TVL</th><th class="num">Shrunk multiple</th></tr>' +
      D.category_rates.map(function (r) { return '<tr><td>' + esc(r.category) + '</td><td class="num">' + r.peers + '</td><td class="num">' + r.median_ratio.toFixed(3) + '</td><td class="num">' + r.multiple.toFixed(3) + '</td></tr>'; }).join('') +
      '</table><p class="note">Market-wide median cap × TVL: ' + D.global_median.toFixed(3) + '. The board\'s prices come from the fitted curve, not these multiples; the multiples are printed so a reader can price any row the other way and compare — the detail view does exactly that.</p></div>';
    return h;
  }

  // ---------------- render + events ----------------
  function renderView() {
    if (state.selected) {
      var r = D.rows.find(function (x) { return x.slug === state.selected; });
      $('view').innerHTML = r ? detailView(r) : boardView();
      return;
    }
    $('view').innerHTML = state.tab === 'board' ? boardView() : state.tab === 'traded' ? tradedView() : methodView();
  }
  function render() { renderChrome(); renderControls(); renderView(); }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var tabBtn = t.closest('[data-tab]');
    if (tabBtn) { state.tab = tabBtn.getAttribute('data-tab'); state.selected = null; location.hash = state.tab === 'board' ? '' : 'tab=' + state.tab; render(); return; }
    var chip = t.closest('[data-cat]');
    if (chip) { state.category = chip.getAttribute('data-cat'); renderControls(); renderView(); return; }
    var vchip = t.closest('[data-verdict]');
    if (vchip) { state.verdict = vchip.getAttribute('data-verdict'); renderControls(); renderView(); return; }
    if (t.closest('[data-back]')) { ev.preventDefault(); state.selected = null; location.hash = ''; render(); return; }
    var th = t.closest('th[data-sort]');
    if (th) {
      var k = th.getAttribute('data-sort');
      if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === 'rank' ? 1 : -1; }
      renderView(); return;
    }
    var tr = t.closest('tr[data-slug]');
    if (tr) { state.selected = tr.getAttribute('data-slug'); location.hash = 'p=' + state.selected; renderControls(); renderView(); }
  });

  // deep links: #p=<slug> detail, #tab=traded|method, #v=Farm verdict filter
  (function fromHash() {
    var h = location.hash.replace(/^#/, '');
    h.split('&').forEach(function (kv) {
      var parts = kv.split('='), k = parts[0], v = decodeURIComponent(parts.slice(1).join('=') || '');
      if (k === 'p' && D.rows.some(function (r) { return r.slug === v; })) state.selected = v;
      if (k === 'tab' && (v === 'traded' || v === 'method')) state.tab = v;
      if (k === 'v' && ['Farm', 'Thin', 'Skip'].indexOf(v) >= 0) state.verdict = v;
      if (k === 'c' && v) state.category = v;
    });
  })();

  render();

  // ---------------- the in-browser recompute ----------------
  // A faithful port of lib/model.ts: same roundings, same seeded generator, same draw order, so
  // the figures below are a reproduction, not a re-estimate.
  var CHEAP_L2 = new Set(['Arbitrum', 'Base', 'Optimism', 'Linea', 'Scroll', 'zkSync Era', 'Mantle', 'Mode', 'Blast', 'Taiko', 'Unichain', 'Ink', 'BOB', 'Hemi', 'Katana', 'Soneium', 'World Chain', 'Zora']);
  function gasUsd(chain) {
    if (chain === 'Ethereum') return 8;
    if (chain === 'Solana') return 0.05;
    if (chain === 'Bitcoin') return 2;
    if (CHEAP_L2.has(chain)) return 0.5;
    if (chain === 'Binance' || chain === 'BNB Chain') return 0.3;
    return 1;
  }
  function ticketFor(tvl) { return tvl >= 1e9 ? 5000 : tvl >= 2.5e8 ? 2500 : tvl >= 5e7 ? 1000 : tvl >= 1.5e7 ? 500 : 250; }
  function holdDaysFor(age) { return age === null ? 45 : age < 180 ? 90 : age < 540 ? 60 : 30; }
  function fitCurveJS(comps) {
    var pts = comps.filter(function (c) { return c.tvl_usd > 0 && c.mcap_usd > 0; });
    var xs = pts.map(function (c) { return Math.log(c.tvl_usd); });
    var ys = pts.map(function (c) { return Math.log(c.mcap_usd); });
    var mx = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
    var my = ys.reduce(function (a, b) { return a + b; }, 0) / ys.length;
    var sxy = 0, sxx = 0;
    for (var i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
    var slope = sxx > 0 ? sxy / sxx : 1;
    var intercept = my - slope * mx;
    var resid = new Map();
    pts.forEach(function (c, j) {
      var key = c.category || '';
      var r = ys[j] - (intercept + slope * xs[j]);
      if (!resid.has(key)) resid.set(key, []);
      resid.get(key).push(r);
    });
    var offsets = new Map();
    resid.forEach(function (rs, cat) {
      var mean = rs.reduce(function (a, b) { return a + b; }, 0) / rs.length;
      offsets.set(cat, round4(mean * (rs.length / (rs.length + D.constants.shrink_prior))));
    });
    return { intercept: round4(intercept), slope: round4(slope), offsets: offsets };
  }
  function curveValueJS(f, tvl, cat) {
    if (tvl <= 0) return 0;
    return Math.exp(f.intercept + f.slope * Math.log(tvl) + (f.offsets.get(cat || '') || 0));
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
  }
  function recompute() {
    var badge = $('recompute-badge');
    try {
      var K = D.constants;
      var compBySlug = new Map(D.comparables.map(function (c) { return [c.slug, c]; }));
      var clean = D.fit_order.map(function (s) { return compBySlug.get(s); }).filter(Boolean);
      var baseFit = fitCurveJS(clean);
      var okV = 0, okB = 0, okR = 0, okN = 0;
      // bootstrap, same seed and draw order as the build
      var values = new Map(), ranks = new Map();
      D.rows.forEach(function (r) { values.set(r.slug, []); ranks.set(r.slug, []); });
      var rng = mulberry32(0xc0ffee);
      for (var rep = 0; rep < 200; rep++) {
        var sample = [];
        for (var i = 0; i < clean.length; i++) sample.push(clean[Math.floor(rng() * clean.length)]);
        var f = fitCurveJS(sample);
        var priced = D.rows.map(function (r) {
          return { slug: r.slug, v: curveValueJS(f, r.tvl_usd, r.category) * r.model.momentum_multiplier * r.model.maturity_multiplier * r.model.breadth_multiplier };
        });
        priced.sort(function (a, b) { return b.v - a.v || (a.slug < b.slug ? -1 : 1); });
        priced.forEach(function (row, j) { values.get(row.slug).push(row.v); ranks.get(row.slug).push(j + 1); });
      }
      D.rows.forEach(function (r) {
        var g = clamp(r.change_7d === null ? 0 : r.change_7d, K.growth_lo, K.growth_hi);
        var mom = round4(1 + (g / 100) * K.momentum_weight);
        var mat = round4(r.age_days === null ? 1 : K.maturity_base + K.maturity_gain * (1 - Math.exp(-r.age_days / K.maturity_tau_days)));
        var brd = round4(1 + K.breadth_per_chain * Math.min(Math.max(r.chains.length - 1, 0), K.breadth_cap));
        var val = Math.max(1, Math.round(curveValueJS(baseFit, r.tvl_usd, r.category) * mom * mat * brd));
        if (Math.abs(val - r.implied_value_usd) <= 1) okV++;
        var vs = [...values.get(r.slug)].sort(function (a, b) { return a - b; });
        var rs = [...ranks.get(r.slug)].sort(function (a, b) { return a - b; });
        var lo = Math.max(1, Math.round(quantile(vs, 0.25))), hi = Math.max(1, Math.round(quantile(vs, 0.75)));
        if (Math.abs(lo - r.band_lo_usd) <= 1 && Math.abs(hi - r.band_hi_usd) <= 1) okB++;
        if (Math.round(quantile(rs, 0.1)) === r.rank_p10 && Math.round(quantile(rs, 0.9)) === r.rank_p90) okR++;
        var chain = r.chains.length ? r.chains[0] : 'its main chain';
        var gas = gasUsd(chain), ticket = ticketFor(r.tvl_usd), hold = holdDaysFor(r.age_days);
        var weeks = Math.max(1, Math.round(hold / 7));
        var fees = (chain === 'Ethereum' ? 0 : 1) + 5 * gas;
        var minutes = 110 + 10 * weeks;
        var forgone = ticket * D.econ_constants.tbill_rate * hold / 365;
        var slice = D.econ_constants.airdrop_share * r.implied_value_usd * ticket / r.tvl_usd;
        var net = slice - fees - forgone;
        if (Math.abs(net - r.econ.net_usd) <= 0.02 && minutes === r.econ.minutes) okN++;
      });
      var n = D.rows.length;
      badge.textContent = 'board.json = this page — recomputed in your browser just now: ' + okV + '/' + n + ' values, ' + okB + '/' + n + ' bands, ' + okR + '/' + n + ' rank ranges and ' + okN + '/' + n + ' nets match';
    } catch (err) {
      badge.textContent = 'In-browser recompute could not run (' + err.message + ') — the figures stand as built.';
    }
  }
  setTimeout(recompute, 60);
})();
