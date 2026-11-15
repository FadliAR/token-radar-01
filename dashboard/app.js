// Launch Radar's page. It renders window.RADAR — the dataset main.ts writes beside dashboard/ —
// as a ranked board with filters and sorting, a per-protocol detail drawer that shows the model's
// arithmetic for that row, and a comparables view: the priced peers the model's multiples are read
// from. Everything on the page comes from data.js; the page makes no requests of its own.
(function () {
  'use strict';

  var D = window.RADAR;
  if (!D) return;

  var state = { q: '', category: 'all', chain: 'all', band: 'all', watch: false, tab: 'board', sort: 'rank', dir: 1, selected: null };

  // ---------- small helpers ----------
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'no date';
    if (days >= 365) return (days / 365).toFixed(1) + ' yrs';
    if (days >= 30) return Math.round(days / 30.4) + ' mo';
    return days + ' d';
  }
  function fmtMult(x) { return '×' + Number(x).toFixed(2); }
  // The model's arithmetic, restated: the page multiplies a row's five printed factors and must
  // land on the figure board.json carries for that row. Same order of operations as lib/model.ts.
  function impliedOf(r) {
    var m = r.model;
    return Math.max(1, Math.round(r.tvl_usd * m.category_multiple * m.momentum_multiplier * m.maturity_multiplier * m.breadth_multiplier));
  }
  function chainsLabel(r) { return r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') : 'no chain on record'; }

  // ---------- hash state ----------
  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    var p = new URLSearchParams(h);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('category')) state.category = p.get('category');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('band')) state.band = p.get('band');
    if (p.get('watch') === '1') state.watch = true;
    if (p.get('tab') === 'comps') state.tab = 'comps';
    if (p.get('p')) state.selected = p.get('p');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.band !== 'all') p.set('band', state.band);
    if (state.watch) p.set('watch', '1');
    if (state.tab !== 'board') p.set('tab', state.tab);
    if (state.selected) p.set('p', state.selected);
    var s = p.toString();
    window.history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
  }

  // ---------- chrome: header, stats, model band, footer ----------
  function renderTop() {
    $('topbar').innerHTML =
      '<div class="brand"><span class="blip"></span>LAUNCH RADAR <small>token launch radar</small></div>' +
      '<div class="top-meta"><span>Snapshot <b>' + esc(D.as_of) + '</b></span>' +
      '<span>Model <b>' + esc(D.model_version) + '</b></span>' +
      '<span>Universe <b>' + D.counts.protocols + ' protocols</b></span></div>';

    var c = D.counts;
    var stats = [
      ['Watchlist covered', c.watchlist + ' / ' + c.watchlist, 'every slug, no exceptions'],
      ['Candidates ranked', String(c.board), c.early + ' found below the $' + Math.round(D.floor_usd / 1e6) + 'M floor'],
      ['Priced peers read', String(c.comparables), 'tokened protocols with a market cap'],
      ['Live but unpriced', String(c.live_unpriced), 'a ticker on record, no market cap'],
      ['Market-wide multiple', fmtMult(D.global_median), 'median market cap per $1 of TVL'],
    ];
    $('stats').innerHTML = stats.map(function (s) {
      return '<div class="stat"><span>' + esc(s[0]) + '</span><b>' + esc(s[1]) + '</b><em>' + esc(s[2]) + '</em></div>';
    }).join('');

    var k = D.constants;
    var topRates = D.category_rates.slice(0, 10).map(function (r) {
      return '<span class="rate-chip">' + esc(r.category) + ' <b>' + fmtMult(r.multiple) + '</b> · ' + r.peers + ' peers</span>';
    }).join('');
    $('modelband').innerHTML =
      '<h2>How an implied value is derived</h2>' +
      '<p>Each candidate is priced off its own kind. The snapshot\'s <b>' + c.comparables + ' priced peers</b> — protocols whose token already trades — ' +
      'give a market-cap-to-TVL ratio per category; a category\'s multiple is its <b>median ratio, shrunk toward the market-wide median ' + fmtMult(D.global_median) +
      '</b> with a prior of ' + k.shrink_prior + ' phantom peers, so a category with one peer stays near the market and one with fifteen speaks for itself. ' +
      'Peer ratios are winsorized to ' + k.ratio_lo + '–' + k.ratio_hi + '× so one outlier cannot carry a category. Three tilts follow from the protocol\'s own record: ' +
      'its 7-day TVL momentum, how long it has run with no token, and how many chains it spans. No name is priced by hand.</p>' +
      '<div class="formula">implied = TVL × category multiple × (1 + clamp(7d growth, ' + k.growth_lo + '%, +' + k.growth_hi + '%) × ' + k.momentum_weight + ') × maturity(age) × (1 + ' + k.breadth_per_chain + ' × extra chains)</div>' +
      '<div class="rates">' + topRates + '</div>';

    $('colophon').innerHTML =
      '<p>Implied value is this model\'s claim about what a launch could be worth if the protocol\'s record stayed as it is — an estimate derived only from the figures above, not a price, a prediction that a token will exist, or advice. A protocol is listed as pre-token when the snapshot records no token for it; a record can lag reality.</p>' +
      '<p>Data: ' + esc(D.source) + '. The board and this page are generated from that one frozen file; nothing here is fetched live.</p>';
  }

  // ---------- controls ----------
  function options(list, current, allLabel) {
    var out = '<option value="all">' + esc(allLabel) + '</option>';
    list.forEach(function (v) {
      out += '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>';
    });
    return out;
  }
  function renderControls(shownCount) {
    var cats = [];
    var chains = [];
    D.rows.forEach(function (r) {
      var cat = r.category || 'Uncategorised';
      if (cats.indexOf(cat) < 0) cats.push(cat);
      (r.chains || []).forEach(function (ch) { if (chains.indexOf(ch) < 0) chains.push(ch); });
    });
    cats.sort(); chains.sort();
    $('controls').innerHTML =
      '<div class="field"><label for="q">Search</label><input type="search" id="q" placeholder="Name, slug, category, chain" value="' + esc(state.q) + '"></div>' +
      '<div class="field"><label for="fcat">Category</label><select id="fcat">' + options(cats, state.category, 'All categories') + '</select></div>' +
      '<div class="field"><label for="fchain">Chain</label><select id="fchain">' + options(chains, state.chain, 'All chains') + '</select></div>' +
      '<div class="field"><label for="fband">TVL band</label><select id="fband">' +
        '<option value="all"' + (state.band === 'all' ? ' selected' : '') + '>All sizes</option>' +
        '<option value="b1"' + (state.band === 'b1' ? ' selected' : '') + '>Over $1B</option>' +
        '<option value="m250"' + (state.band === 'm250' ? ' selected' : '') + '>$250M – $1B</option>' +
        '<option value="m50"' + (state.band === 'm50' ? ' selected' : '') + '>$50M – $250M</option>' +
        '<option value="u50"' + (state.band === 'u50' ? ' selected' : '') + '>Under $50M</option>' +
      '</select></div>' +
      '<label class="field check"><input type="checkbox" id="fwatch"' + (state.watch ? ' checked' : '') + '> Watchlist only</label>' +
      '<div class="field"><label>View</label><div class="tabs">' +
        '<button type="button" id="tab-board" aria-pressed="' + (state.tab === 'board') + '">Launch board</button>' +
        '<button type="button" id="tab-comps" aria-pressed="' + (state.tab === 'comps') + '">Comparables</button>' +
      '</div></div>' +
      '<span class="shown">' + (state.tab === 'board' ? shownCount + ' of ' + D.counts.board + ' candidates shown' : D.counts.comparables + ' priced peers') + '</span>';

    $('q').addEventListener('input', function (e) { state.q = e.target.value; writeHash(); renderView(); });
    $('fcat').addEventListener('change', function (e) { state.category = e.target.value; writeHash(); renderView(); });
    $('fchain').addEventListener('change', function (e) { state.chain = e.target.value; writeHash(); renderView(); });
    $('fband').addEventListener('change', function (e) { state.band = e.target.value; writeHash(); renderView(); });
    $('fwatch').addEventListener('change', function (e) { state.watch = e.target.checked; writeHash(); renderView(); });
    $('tab-board').addEventListener('click', function () { state.tab = 'board'; writeHash(); render(); });
    $('tab-comps').addEventListener('click', function () { state.tab = 'comps'; writeHash(); render(); });
  }

  // ---------- filtering and sorting ----------
  function bandOk(tvl) {
    if (state.band === 'b1') return tvl >= 1e9;
    if (state.band === 'm250') return tvl >= 250e6 && tvl < 1e9;
    if (state.band === 'm50') return tvl >= 50e6 && tvl < 250e6;
    if (state.band === 'u50') return tvl < 50e6;
    return true;
  }
  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return D.rows.filter(function (r) {
      if (state.watch && !r.on_watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!bandOk(r.tvl_usd)) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sortRows(list) {
    var key = state.sort, dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? -1 : a.age_days; bv = b.age_days === null ? -1 : b.age_days; }
      else if (key === 'mult') { av = a.model.category_multiple; bv = b.model.category_multiple; }
      else if (key === 'implied') { av = a.implied_value_usd; bv = b.implied_value_usd; }
      else { av = a.rank; bv = b.rank; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function th(key, label, cls) {
    var arrow = state.sort === key ? (state.dir === 1 ? ' ↑' : ' ↓') : '';
    return '<th class="' + (cls || '') + '"><button type="button" data-sort="' + key + '">' + esc(label) + arrow + '</button></th>';
  }

  // ---------- the board ----------
  function boardHtml() {
    var list = sortRows(visibleRows());
    if (list.length === 0) {
      return '<div class="panel"><div class="empty"><h2>No candidate matches those filters</h2>' +
        '<p>Loosen the search, pick another category or chain, or clear the TVL band.</p>' +
        '<button type="button" id="clearf">Clear all filters</button></div></div>';
    }
    var max = list.reduce(function (m, r) { return Math.max(m, r.implied_value_usd); }, 1);
    var body = list.map(function (r) {
      var g = r.change_7d;
      var badge = r.on_watchlist ? '<span class="badge watch">Watchlist</span>' : '<span class="badge early">Early</span>';
      return '<tr data-slug="' + esc(r.slug) + '" tabindex="0" aria-selected="' + (state.selected === r.slug) + '">' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' + badge + '<span class="psub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(chainsLabel(r)) + '</span></td>' +
        '<td class="r num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="r num ' + (g === null ? '' : g >= 0 ? 'pos' : 'neg') + '">' + fmtPct(g) + '</td>' +
        '<td class="r num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="r num">' + fmtMult(r.model.category_multiple) + '</td>' +
        '<td class="r"><div class="implied"><span class="bar"><i style="width:' + Math.max(2, Math.round((r.implied_value_usd / max) * 100)) + '%"></i></span><span class="num">' + fmtUsd(r.implied_value_usd) + '</span></div></td>' +
        '</tr>';
    }).join('');
    return '<div class="panel"><div class="table-wrap"><table>' +
      '<caption>Pre-token protocols ranked by implied value — what a launch could be worth if each record stayed as it is. Select any row for its derivation and farm plan. Protocols whose token already trades are never ranked here; they are the comparables.</caption>' +
      '<thead><tr>' + th('rank', '#') + th('name', 'Protocol') + th('tvl', 'TVL', 'r') + th('growth', '7d', 'r') + th('age', 'Tokenless age', 'r') + th('mult', 'Multiple', 'r') + th('implied', 'Implied value', 'r') + '</tr></thead>' +
      '<tbody>' + body + '</tbody></table></div></div>';
  }

  // ---------- the comparables ----------
  function compsHtml() {
    var byCat = {};
    D.comparables.forEach(function (c) {
      var key = c.category || 'Uncategorised';
      (byCat[key] = byCat[key] || []).push(c);
    });
    var body = '';
    D.category_rates.forEach(function (rate) {
      var peers = byCat[rate.category];
      if (!peers) return;
      body += '<tr class="grouprow"><td colspan="5"><b>' + esc(rate.category) + '</b> — ' + rate.peers +
        ' priced peers · median ratio ' + fmtMult(rate.median_ratio) + ' · multiple applied after shrinkage <b>' + fmtMult(rate.multiple) + '</b></td></tr>';
      peers.forEach(function (c) {
        body += '<tr><td><span class="pname">' + esc(c.name) + '</span><span class="psub">' + esc(c.slug) + '</span></td>' +
          '<td class="r num">' + fmtUsd(c.tvl_usd) + '</td>' +
          '<td class="r num">' + fmtUsd(c.mcap_usd) + '</td>' +
          '<td class="r num">' + fmtMult(c.ratio) + '</td>' +
          '<td class="r"><span class="badge early">Already trades</span></td></tr>';
      });
    });
    return '<div class="panel"><div class="table-wrap"><table>' +
      '<caption>The evidence base: every protocol in the snapshot whose token already trades with a market cap on record. Their market-cap-to-TVL ratios (winsorized to ' + D.constants.ratio_lo + '–' + D.constants.ratio_hi + '×) are where the board\'s multiples come from. These protocols are comparables, never candidates.</caption>' +
      '<thead><tr><th>Protocol</th><th class="r">TVL</th><th class="r">Market cap</th><th class="r">Cap / TVL</th><th class="r">Status</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div></div>';
  }

  // ---------- detail drawer ----------
  function openDetail(slug) {
    var r = null;
    D.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    state.selected = slug;
    writeHash();
    var m = r.model;
    var recomputed = impliedOf(r);
    var steps = r.farm.map(function (s) {
      return '<li><span class="pact">' + esc(s.action) + '</span><span class="meta">' +
        '<span class="chip cost">Cost: ' + esc(s.cost) + '</span><span class="chip">Time: ' + esc(s.time) + '</span></span></li>';
    }).join('');
    $('drawer').innerHTML =
      '<div class="drawer-top"><div><span class="kicker">Rank ' + r.rank + ' of ' + D.counts.board + (r.on_watchlist ? ' · Watchlist' : ' · Early find') + '</span>' +
      '<h2>' + esc(r.name) + '</h2><div class="sub">' + esc(r.category || 'Uncategorised') + ' · ' + esc((r.chains || []).join(', ') || 'no chain on record') + '</div></div>' +
      '<button type="button" class="closebtn" id="dclose">Close</button></div>' +
      '<h3>The record</h3><div class="grid">' +
      '<div class="cell"><span>TVL</span><b>' + fmtUsd(r.tvl_usd) + '</b></div>' +
      '<div class="cell"><span>7-day TVL change</span><b class="' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change_7d) + '</b></div>' +
      '<div class="cell"><span>Tokenless age</span><b>' + fmtAge(r.age_days) + '</b></div>' +
      '<div class="cell"><span>First tracked</span><b>' + esc(r.listed_at || 'not recorded') + '</b></div>' +
      '<div class="cell"><span>Chains</span><b>' + (r.chains || []).length + '</b></div>' +
      '<div class="cell"><span>Token status</span><b>none on record</b></div></div>' +
      '<h3>How this value is derived</h3>' +
      '<table class="derive"><tbody>' +
      '<tr><td>Total value locked</td><td class="r">' + usdFull.format(r.tvl_usd) + '</td></tr>' +
      '<tr><td>× Category multiple (' + esc(r.category || 'Uncategorised') + ': median ' + fmtMult(m.category_median) + ' over ' + m.category_peers + ' priced peer' + (m.category_peers === 1 ? '' : 's') + ', shrunk toward ' + fmtMult(D.global_median) + ')</td><td class="r">' + fmtMult(m.category_multiple) + '</td></tr>' +
      '<tr><td>× Momentum (7d growth ' + fmtPct(m.growth_pct) + ', clamped)</td><td class="r">' + fmtMult(m.momentum_multiplier) + '</td></tr>' +
      '<tr><td>× Maturity (' + (r.age_days === null ? 'no listing date — neutral' : fmtAge(r.age_days) + ' with no token') + ')</td><td class="r">' + fmtMult(m.maturity_multiplier) + '</td></tr>' +
      '<tr><td>× Breadth (' + (r.chains || []).length + ' chains)</td><td class="r">' + fmtMult(m.breadth_multiplier) + '</td></tr>' +
      '<tr class="total"><td>Implied value</td><td class="r">' + usdFull.format(r.implied_value_usd) + '</td></tr>' +
      '</tbody></table>' +
      '<p class="checkline">This page multiplies the same five figures and gets <b>' + usdFull.format(recomputed) + '</b>' +
      (recomputed === r.implied_value_usd ? ' — the board\'s figure, recomputed in your browser.' : ' — within a rounding dollar of the board\'s figure.') + '</p>' +
      '<h3>Farm plan</h3><ol class="plan">' + steps + '</ol>' +
      '<p class="sub">Costs are indicative, in the chain\'s own terms at snapshot time; the plan is generated from this protocol\'s category, chains, TVL and age — the same derivation board.json carries.</p>';
    $('drawer').hidden = false;
    $('scrim').hidden = false;
    $('dclose').addEventListener('click', closeDetail);
  }
  function closeDetail() {
    state.selected = null;
    writeHash();
    $('drawer').hidden = true;
    $('scrim').hidden = true;
    renderView();
  }

  // ---------- render ----------
  function renderView() {
    var view = $('view');
    view.innerHTML = state.tab === 'board' ? boardHtml() : compsHtml();
    renderControls(state.tab === 'board' ? visibleRows().length : D.counts.comparables);
    view.querySelectorAll('th button[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-sort');
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = key === 'rank' || key === 'name' ? 1 : -1; }
        renderView();
      });
    });
    view.querySelectorAll('tr[data-slug]').forEach(function (tr) {
      var go = function () { openDetail(tr.getAttribute('data-slug')); };
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    var clear = $('clearf');
    if (clear) clear.addEventListener('click', function () {
      state.q = ''; state.category = 'all'; state.chain = 'all'; state.band = 'all'; state.watch = false;
      writeHash(); renderView();
    });
  }
  function render() {
    renderTop();
    renderView();
    if (state.selected) openDetail(state.selected);
  }

  $('scrim').addEventListener('click', closeDetail);
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.selected) closeDetail(); });

  readHash();
  render();
})();
