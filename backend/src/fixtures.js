'use strict';
// FR-1.3 — custom fixture generation: round robin, swiss, single & double elimination.
const { err, vErr, isId, isInt, isObj } = require('./core');

function checkTeams(teams, min, max) {
  if (!Array.isArray(teams) || teams.length < min || teams.length > max || !teams.every(isId) || new Set(teams).size !== teams.length) {
    throw vErr(['teams']);
  }
}

// ---------- Round robin (circle method) ----------
function homeOf(n, i, j) {
  // orientation giving |home-away| <= 1 per team: cyclic rule on an odd core, last team alternates
  const odd = n % 2 === 1 ? n : n - 1;
  if (n % 2 === 0 && (i === n - 1 || j === n - 1)) {
    const other = i === n - 1 ? j : i;
    return other % 2 === 0 ? other : n - 1;
  }
  const d = (((j - i) % odd) + odd) % odd;
  return d >= 1 && d <= (odd - 1) / 2 ? i : j;
}

function roundRobin(teams, params) {
  checkTeams(teams, 2, 40);
  const legs = params.legs === undefined ? 1 : params.legs;
  if (legs !== 1 && legs !== 2) throw vErr(['params.legs']);
  const withdrawals = params.withdrawals === undefined ? [] : params.withdrawals;
  const policy = params.withdrawal_policy === undefined ? 'forfeit_remaining' : params.withdrawal_policy;
  if (!['forfeit_remaining', 'void_all'].includes(policy)) throw vErr(['params.withdrawal_policy']);
  const n = teams.length;
  const perLeg = n % 2 === 0 ? n - 1 : n;
  const roundCount = perLeg * legs;
  if (!Array.isArray(withdrawals)) throw vErr(['params.withdrawals']);
  const wd = new Map();
  for (const w of withdrawals) {
    if (!isObj(w) || !teams.includes(w.team_id) || !isInt(w.after_round) || w.after_round < 0 || w.after_round > roundCount) {
      throw vErr(['params.withdrawals']);
    }
    wd.set(w.team_id, w.after_round);
  }
  const slots = teams.map((_, i) => i);
  if (n % 2 === 1) slots.push(-1);
  const m = slots.length;
  const base = [];
  let arr = slots.slice();
  for (let r = 0; r < m - 1; r++) {
    const pairs = [];
    let bye = null;
    for (let k = 0; k < m / 2; k++) {
      const a = arr[k], b = arr[m - 1 - k];
      if (a === -1 || b === -1) { bye = a === -1 ? b : a; continue; }
      const h = homeOf(n, a, b);
      pairs.push([h, h === a ? b : a]);
    }
    base.push({ pairs, bye });
    arr = [arr[0], arr[m - 1], ...arr.slice(1, m - 1)];
  }
  const rounds = [];
  const summary = { total: 0, scheduled: 0, forfeit: 0, voided: 0 };
  for (let leg = 1; leg <= legs; leg++) {
    base.forEach((b, ri) => {
      const roundNo = (leg - 1) * perLeg + ri + 1;
      const matches = b.pairs.map(([h, a], idx) => {
        const home = teams[leg === 1 ? h : a], away = teams[leg === 1 ? a : h];
        let status = 'scheduled', awarded = null;
        const hw = wd.has(home), aw = wd.has(away);
        if (policy === 'void_all') {
          if (hw || aw) status = 'voided';
        } else {
          const hOut = hw && roundNo > wd.get(home), aOut = aw && roundNo > wd.get(away);
          if (hOut && aOut) status = 'voided';
          else if (hw && aw && (hOut || aOut)) { status = 'forfeit'; awarded = hOut ? away : home; }
          else if (hOut) { status = 'forfeit'; awarded = away; }
          else if (aOut) { status = 'forfeit'; awarded = home; }
        }
        summary.total++;
        summary[status]++;
        return { match_id: `RR-L${leg}-R${roundNo}-M${idx + 1}`, leg, home, away, status, awarded_to: awarded };
      });
      rounds.push({ round: roundNo, matches, byes: b.bye === null ? [] : [teams[b.bye]] });
    });
  }
  return { format: 'round_robin', legs, team_count: n, round_count: roundCount, rounds, summary };
}

// ---------- Swiss ----------
function swiss(teams, params) {
  checkTeams(teams, 2, 64);
  const n = teams.length;
  const totalRounds = params.total_rounds === undefined ? Math.ceil(Math.log2(n)) : params.total_rounds;
  if (!isInt(totalRounds) || totalRounds < 1 || totalRounds > Math.max(1, n - 1)) throw vErr(['params.total_rounds']);
  const round = params.round === undefined ? 1 : params.round;
  if (!isInt(round) || round < 1 || round > totalRounds) throw vErr(['params.round']);
  const history = params.history === undefined ? [] : params.history;
  if (!Array.isArray(history) || history.length !== round - 1) throw vErr(['params.history']);
  const idx = new Map(teams.map((t, i) => [t, i]));
  const score2 = new Array(n).fill(0); // in half points
  const opps = teams.map(() => []);
  const hadBye = new Set();
  const played = new Set();
  const key = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  history.forEach((h, k) => {
    if (!isObj(h) || h.round !== k + 1 || !Array.isArray(h.matches)) throw vErr(['params.history']);
    if (h.bye !== null && h.bye !== undefined) {
      if (!idx.has(h.bye)) throw vErr(['params.history']);
      score2[idx.get(h.bye)] += 2;
      hadBye.add(idx.get(h.bye));
    }
    for (const mt of h.matches) {
      if (!isObj(mt) || !idx.has(mt.home) || !idx.has(mt.away) || mt.home === mt.away || !['home', 'away', 'draw'].includes(mt.result)) throw vErr(['params.history']);
      const a = idx.get(mt.home), b = idx.get(mt.away);
      opps[a].push(b); opps[b].push(a);
      played.add(key(a, b));
      if (mt.result === 'home') score2[a] += 2;
      else if (mt.result === 'away') score2[b] += 2;
      else { score2[a] += 1; score2[b] += 1; }
    }
  });
  const buch2 = teams.map((_, i) => opps[i].reduce((s, o) => s + score2[o], 0));
  const order = teams.map((_, i) => i).sort((a, b) => score2[b] - score2[a] || buch2[b] - buch2[a] || a - b);
  const rank = new Map(order.map((t, r) => [t, r]));
  const standings = order.map((t, r) => ({ rank: r + 1, team_id: teams[t], score: score2[t] / 2, buchholz: buch2[t] / 2 }));

  let pairs = null, bye = null;
  if (round === 1) {
    const m = Math.floor(n / 2);
    pairs = [];
    for (let i = 0; i < m; i++) pairs.push([i, i + m]);
    if (n % 2 === 1) bye = n - 1;
  } else {
    const candidates = n % 2 === 1
      ? teams.map((_, i) => i).filter((i) => !hadBye.has(i)).sort((a, b) => score2[a] - score2[b] || b - a)
      : [null];
    if (n % 2 === 1 && candidates.length === 0) candidates.push(...teams.map((_, i) => i).sort((a, b) => score2[a] - score2[b] || b - a));
    for (const c of candidates) {
      const rest = order.filter((t) => t !== c);
      const res = minCostPairing(rest, score2, played, key);
      if (res) { pairs = res; bye = c; break; }
    }
    if (!pairs) throw err(409, 'NO_VALID_PAIRING', 'No rematch-free pairing exists', { round });
  }
  const pairings = pairs
    .map(([a, b]) => (rank.get(a) <= rank.get(b) ? [a, b] : [b, a]))
    .sort((x, y) => rank.get(x[0]) - rank.get(y[0]))
    .map(([a, b], i) => ({ match_id: `SW-R${round}-M${i + 1}`, home: teams[a], away: teams[b] }));
  return { format: 'swiss', round, total_rounds: totalRounds, pairings, bye: bye === null ? null : teams[bye], standings };
}

// Branch & bound minimum sum |score diff| perfect matching without rematches.
function minCostPairing(list, sc, played, key) {
  let best = null, bestCost = Infinity, nodes = 0;
  const lb = (rem) => { let s = 0; for (let i = 0; i + 1 < rem.length; i += 2) s += Math.abs(sc[rem[i]] - sc[rem[i + 1]]); return s; };
  const pairs = [];
  function dfs(rem, cost) {
    if (nodes++ > 3e6) return;
    if (rem.length === 0) { if (cost < bestCost) { bestCost = cost; best = pairs.slice(); } return; }
    if (cost + lb(rem) >= bestCost) return;
    const a = rem[0];
    const cands = rem.slice(1).filter((b) => !played.has(key(a, b)))
      .sort((x, y) => Math.abs(sc[a] - sc[x]) - Math.abs(sc[a] - sc[y]));
    for (const b of cands) {
      pairs.push([a, b]);
      dfs(rem.filter((t) => t !== a && t !== b), cost + Math.abs(sc[a] - sc[b]));
      pairs.pop();
    }
  }
  dfs(list, 0);
  return best;
}

// ---------- Elimination ----------
function seedOrder(B) {
  let o = [1, 2];
  while (o.length < B) { const k2 = o.length * 2; const nx = []; for (const s of o) nx.push(s, k2 + 1 - s); o = nx; }
  return o;
}
const mk = (id, bracket, round, index) => ({
  match_id: id, bracket, round, index, home: null, away: null, home_seed: null, away_seed: null,
  bye: false, winner: null, loser: null, winner_to: null, loser_to: null,
});

function buildMain(teams, prefix, bracket) {
  const n = teams.length;
  let B = 1; while (B < n) B *= 2;
  const k = Math.log2(B);
  const order = seedOrder(B);
  const rounds = [];
  for (let r = 1; r <= k; r++) {
    const ms = [];
    for (let i = 1; i <= B / 2 ** r; i++) {
      const m = mk(`${prefix}${r}M${i}`, bracket, r, i);
      if (r < k) m.winner_to = { match_id: `${prefix}${r + 1}M${Math.ceil(i / 2)}`, slot: i % 2 === 1 ? 'home' : 'away' };
      if (r === 1) {
        const s1 = order[2 * i - 2], s2 = order[2 * i - 1];
        const hs = Math.min(s1, s2), as = Math.max(s1, s2);
        m.home_seed = hs; m.home = teams[hs - 1];
        if (as > n) { m.bye = true; m.winner = m.home; }
        else { m.away_seed = as; m.away = teams[as - 1]; }
      }
      ms.push(m);
    }
    rounds.push({ round: r, matches: ms });
  }
  return { B, k, rounds };
}

function applyResults(all, results, onResult) {
  const place = (to, team) => { if (to && all.has(to.match_id)) all.get(to.match_id)[to.slot] = team; };
  for (const m of all.values()) if (m.bye && m.winner) place(m.winner_to, m.winner);
  if (results === undefined) return;
  if (!Array.isArray(results)) throw vErr(['params.results']);
  for (const r of results) {
    if (!isObj(r) || !all.has(r.match_id)) throw vErr(['params.results'], 'Unknown match_id in results');
    const m = all.get(r.match_id);
    if (r.winner === null || r.winner === undefined || (r.winner !== m.home && r.winner !== m.away)) {
      throw vErr(['params.results'], 'Winner is not a participant of ' + r.match_id);
    }
    m.winner = r.winner;
    m.loser = r.winner === m.home ? m.away : m.home;
    place(m.winner_to, m.winner);
    if (m.loser) place(m.loser_to, m.loser);
    if (onResult) onResult(m);
  }
}

function singleElim(teams, params) {
  checkTeams(teams, 2, 128);
  const { B, k, rounds } = buildMain(teams, 'R', 'main');
  const all = new Map();
  rounds.forEach((r) => r.matches.forEach((m) => all.set(m.match_id, m)));
  if (params.third_place_match === true && k >= 2) {
    const tp = mk('TP', 'third_place', k, 1);
    const semis = rounds[k - 2].matches;
    semis[0].loser_to = { match_id: 'TP', slot: 'home' };
    semis[1].loser_to = { match_id: 'TP', slot: 'away' };
    rounds[k - 1].matches.push(tp);
    all.set('TP', tp);
  }
  applyResults(all, params.results);
  return { format: 'single_elim', bracket_size: B, rounds };
}

function doubleElim(teams, params) {
  checkTeams(teams, 3, 128);
  const reset = params.bracket_reset === undefined ? true : params.bracket_reset === true;
  const { B, k, rounds: winners } = buildMain(teams, 'WR', 'winners');
  const losers = [];
  for (let j = 1; j <= k - 1; j++) {
    for (const r of [2 * j - 1, 2 * j]) {
      const ms = [];
      for (let i = 1; i <= B / 2 ** (j + 1); i++) ms.push(mk(`LR${r}M${i}`, 'losers', r, i));
      losers.push({ round: r, matches: ms });
    }
  }
  const LR = (r, i) => `LR${r}M${i}`;
  const lastLR = 2 * (k - 1);
  // winners-bracket losers
  winners[0].matches.forEach((m) => { m.loser_to = { match_id: LR(1, Math.ceil(m.index / 2)), slot: m.index % 2 === 1 ? 'home' : 'away' }; });
  for (let r = 2; r <= k; r++) winners[r - 1].matches.forEach((m) => { m.loser_to = { match_id: LR(2 * r - 2, m.index), slot: 'away' }; });
  // losers-bracket advancement
  losers.forEach((lr) => lr.matches.forEach((m) => {
    const r = m.round;
    if (r === lastLR) m.winner_to = { match_id: 'GF1', slot: 'away' };
    else if (r % 2 === 1) m.winner_to = { match_id: LR(r + 1, m.index), slot: 'home' };
    else m.winner_to = { match_id: LR(r + 1, Math.ceil(m.index / 2)), slot: m.index % 2 === 1 ? 'home' : 'away' };
  }));
  winners[k - 1].matches[0].winner_to = { match_id: 'GF1', slot: 'home' };
  const gf1 = mk('GF1', 'grand_final', 1, 1);
  const grand = [gf1];
  if (reset) {
    const gf2 = mk('GF2', 'grand_final', 2, 1);
    gf2.conditional = true;
    gf2.required = null;
    gf1.winner_to = { match_id: 'GF2', slot: 'home' };
    gf1.loser_to = { match_id: 'GF2', slot: 'away' };
    grand.push(gf2);
  }
  const all = new Map();
  [...winners, ...losers].forEach((r) => r.matches.forEach((m) => all.set(m.match_id, m)));
  grand.forEach((m) => all.set(m.match_id, m));
  applyResults(all, params.results, (m) => {
    if (m.match_id === 'GF1' && reset) {
      const gf2 = all.get('GF2');
      gf2.required = m.winner === m.away;
      gf2.home = m.home; gf2.away = m.away;
    }
  });
  return { format: 'double_elim', bracket_size: B, bracket_reset: reset, winners, losers, grand_final: grand };
}

function generateFixtures(body) {
  if (!isObj(body)) throw vErr(['body']);
  const params = body.params === undefined ? {} : body.params;
  if (!isObj(params)) throw vErr(['params']);
  switch (body.format) {
    case 'round_robin': return roundRobin(body.teams, params);
    case 'swiss': return swiss(body.teams, params);
    case 'single_elim': return singleElim(body.teams, params);
    case 'double_elim': return doubleElim(body.teams, params);
    default: throw vErr(['format']);
  }
}

module.exports = { generateFixtures, roundRobin, swiss, singleElim, doubleElim, seedOrder };
