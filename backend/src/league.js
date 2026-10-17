'use strict';
// FR-1.1 sports-as-data + event-sourced scoring; FR-1.4 standings.
const { err, vErr, isId, isInt, isObj, canonical, sign, sha256hex, clone } = require('./core');

const TIE_TOKENS = ['h2h_points', 'h2h_diff', 'overall_diff', 'scored', 'fair_play', 'draw_lots'];
const OT_POLICIES = ['none', 'extra_time', 'shootout', 'golden_score', 'super_over'];

const SEED_SPORTS = [
  { sport_id: 'football', name: 'Football', scoring_model: 'event', periods: { count: 2, duration_minutes: 45 },
    scoring_events: { goal: { points: 1 } }, draw_allowed: true, overtime: { policy: 'none' },
    tie_break_order: TIE_TOKENS, roster: { min_squad_size: 11, max_squad_size: 25, required_positions: { gk: 1 } } },
  { sport_id: 'basketball', name: 'Basketball', scoring_model: 'event', periods: { count: 4, duration_minutes: 12 },
    scoring_events: { free_throw: { points: 1 }, two_pointer: { points: 2 }, three_pointer: { points: 3 } }, draw_allowed: false,
    overtime: { policy: 'extra_time', duration_minutes: 5 }, tie_break_order: TIE_TOKENS,
    roster: { min_squad_size: 5, max_squad_size: 15, required_positions: {} } },
  { sport_id: 'cricket', name: 'Cricket', scoring_model: 'innings',
    periods: { innings_per_team: 1, overs_per_innings: 20, balls_per_over: 6, wickets_per_innings: 10 },
    scoring_events: {
      dot_ball: { runs: 0, legal_ball: true, wicket: false }, single: { runs: 1, legal_ball: true, wicket: false },
      two: { runs: 2, legal_ball: true, wicket: false }, four: { runs: 4, legal_ball: true, wicket: false },
      six: { runs: 6, legal_ball: true, wicket: false }, wide: { runs: 1, legal_ball: false, wicket: false },
      no_ball: { runs: 1, legal_ball: false, wicket: false }, wicket: { runs: 0, legal_ball: true, wicket: true } },
    draw_allowed: true, overtime: { policy: 'super_over' }, tie_break_order: TIE_TOKENS,
    roster: { min_squad_size: 11, max_squad_size: 18, required_positions: { wicketkeeper: 1 } } },
  { sport_id: 'esports', name: 'Esports', scoring_model: 'round', periods: { best_of: 3 },
    scoring_events: { round_win: { rounds: 1 } }, draw_allowed: false, overtime: { policy: 'none' },
    tie_break_order: TIE_TOKENS, roster: { min_squad_size: 5, max_squad_size: 8, required_positions: {} } },
];

const posInt = (v, min) => isInt(v) && v >= min;

function validateSport(b) {
  const f = [];
  if (!isObj(b)) throw vErr(['body']);
  if (typeof b.sport_id !== 'string' || !/^[a-z0-9_-]{2,40}$/.test(b.sport_id)) f.push('sport_id');
  if (typeof b.name !== 'string' || b.name.length < 1 || b.name.length > 80) f.push('name');
  const model = b.scoring_model;
  if (!['event', 'innings', 'round'].includes(model)) f.push('scoring_model');
  const p = b.periods;
  if (!isObj(p)) f.push('periods');
  else if (model === 'event' && !(posInt(p.count, 1) && posInt(p.duration_minutes, 1))) f.push('periods');
  else if (model === 'innings' && !['innings_per_team', 'overs_per_innings', 'balls_per_over', 'wickets_per_innings'].every((k) => posInt(p[k], 1))) f.push('periods');
  else if (model === 'round' && !(posInt(p.best_of, 1) && p.best_of % 2 === 1)) f.push('periods');
  const se = b.scoring_events;
  if (!isObj(se) || Object.keys(se).length === 0) f.push('scoring_events');
  else {
    for (const [k, v] of Object.entries(se)) {
      let ok = /^[a-z0-9_]{1,40}$/.test(k) && isObj(v);
      if (ok && model === 'event') ok = posInt(v.points, 1);
      if (ok && model === 'innings') ok = posInt(v.runs, 0) && typeof v.legal_ball === 'boolean' && typeof v.wicket === 'boolean';
      if (ok && model === 'round') ok = posInt(v.rounds, 1);
      if (!ok) { f.push('scoring_events'); break; }
    }
  }
  if (typeof b.draw_allowed !== 'boolean') f.push('draw_allowed');
  const ot = b.overtime;
  if (!isObj(ot) || !OT_POLICIES.includes(ot.policy) || (ot.duration_minutes !== undefined && !posInt(ot.duration_minutes, 0))) f.push('overtime');
  if (b.tie_break_order !== undefined && !validTieOrder(b.tie_break_order)) f.push('tie_break_order');
  const r = b.roster;
  if (!isObj(r) || !posInt(r.min_squad_size, 1) || !posInt(r.max_squad_size, 1) || r.min_squad_size > r.max_squad_size ||
      !isObj(r.required_positions) || !Object.values(r.required_positions).every((v) => posInt(v, 0))) f.push('roster');
  if (f.length) throw vErr(f);
}
const validTieOrder = (t) => Array.isArray(t) && t.every((x) => TIE_TOKENS.includes(x)) && new Set(t).size === t.length;

function storeSport(S, b) {
  const cfg = {
    sport_id: b.sport_id, name: b.name, scoring_model: b.scoring_model, periods: clone(b.periods),
    scoring_events: clone(b.scoring_events), draw_allowed: b.draw_allowed, overtime: clone(b.overtime),
    tie_break_order: b.tie_break_order ? b.tie_break_order.slice() : TIE_TOKENS.slice(), roster: clone(b.roster),
  };
  S.sports.set(cfg.sport_id, cfg);
  return cfg;
}

function createSport(S, b) {
  validateSport(b);
  if (S.sports.has(b.sport_id)) throw err(409, 'SPORT_EXISTS', 'Sport already exists', { sport_id: b.sport_id });
  return { status: 201, body: { sport_id: b.sport_id, status: 'created', config: storeSport(S, b) } };
}

// ---------- Leagues ----------
function createLeague(S, b) {
  if (!isObj(b)) throw vErr(['body']);
  const f = [];
  if (!isId(b.league_id)) f.push('league_id');
  if (typeof b.sport_id !== 'string') f.push('sport_id');
  const teamsOk = Array.isArray(b.teams) && b.teams.length >= 2 && b.teams.length <= 40 && b.teams.every(isId) && new Set(b.teams).size === b.teams.length;
  if (!teamsOk) f.push('teams');
  if (!Array.isArray(b.fixtures) || !b.fixtures.every((x) => isObj(x) && isId(x.match_id) && isId(x.home) && isId(x.away) && x.home !== x.away &&
      (!teamsOk || (b.teams.includes(x.home) && b.teams.includes(x.away))))) f.push('fixtures');
  else if (new Set(b.fixtures.map((x) => x.match_id)).size !== b.fixtures.length) f.push('fixtures');
  const pts = b.points === undefined ? {} : b.points;
  if (!isObj(pts) || ['win', 'draw', 'loss'].some((k) => pts[k] !== undefined && !isInt(pts[k]))) f.push('points');
  if (b.tie_break_order !== undefined && !validTieOrder(b.tie_break_order)) f.push('tie_break_order');
  if (!isObj(b.qualification) || !isInt(b.qualification.spots) || b.qualification.spots < 1 || (teamsOk && b.qualification.spots > b.teams.length)) f.push('qualification');
  if (b.lots_seed !== undefined && !isInt(b.lots_seed)) f.push('lots_seed');
  if (f.length) throw vErr(f);
  const sport = S.sports.get(b.sport_id);
  if (!sport) throw err(404, 'SPORT_NOT_FOUND', 'Unknown sport', { sport_id: b.sport_id });
  if (S.leagues.has(b.league_id)) throw err(409, 'LEAGUE_EXISTS', 'League already exists', { league_id: b.league_id });
  for (const fx of b.fixtures) if (S.matches.has(fx.match_id)) throw err(409, 'MATCH_EXISTS', 'Match already exists', { match_id: fx.match_id });
  const league = {
    league_id: b.league_id, sport_id: b.sport_id, teams: b.teams.slice(), fixtures: b.fixtures.map((x) => x.match_id),
    points: { win: pts.win ?? 3, draw: pts.draw ?? 1, loss: pts.loss ?? 0 },
    tie_break_order: (b.tie_break_order || sport.tie_break_order).slice(), spots: b.qualification.spots,
    lots_seed: b.lots_seed ?? S.seed,
  };
  S.leagues.set(league.league_id, league);
  for (const fx of b.fixtures) S.matches.set(fx.match_id, { match_id: fx.match_id, sport_id: b.sport_id, league_id: b.league_id, home: fx.home, away: fx.away, events: [] });
  return { status: 201, body: { league_id: league.league_id, status: 'created', team_count: league.teams.length, fixture_count: league.fixtures.length } };
}

// ---------- Event sourcing ----------
function project(S, match) {
  const sport = S.sports.get(match.sport_id);
  const compensatedBy = new Map();
  for (const e of match.events) if (e.type === 'compensation') compensatedBy.set(e.payload.compensates, e.event_id);
  const side = () => ({ score: 0, runs: 0, balls: 0, wickets: 0, fair_play: 0 });
  const t = { [match.home]: side(), [match.away]: side() };
  let status = 'upcoming', tb = null;
  for (const e of match.events) {
    if (e.type === 'match_start') status = 'in_progress';
    else if (e.type === 'match_end') status = 'completed';
    if (compensatedBy.has(e.event_id) || e.type === 'compensation') continue;
    if (e.type === 'score') {
      const def = sport.scoring_events[e.payload.event_type];
      const s = t[e.payload.team_id];
      if (sport.scoring_model === 'event') s.score += def.points;
      else if (sport.scoring_model === 'round') s.score += def.rounds;
      else { s.score += def.runs; if (def.legal_ball) s.balls++; if (def.wicket) s.wickets++; }
    } else if (e.type === 'discipline') t[e.payload.team_id].fair_play += e.payload.points;
    else if (e.type === 'tiebreak_winner') tb = e.payload.team_id;
  }
  const h = t[match.home], a = t[match.away];
  let winner = null;
  if (h.score > a.score) winner = match.home;
  else if (a.score > h.score) winner = match.away;
  else if (tb) winner = tb;
  let outcome = 'pending';
  if (status === 'completed') {
    if (winner) outcome = winner === match.home ? 'home_win' : 'away_win';
    else outcome = sport.draw_allowed ? 'draw' : 'undecided';
  }
  return { sport, status, outcome, winner: status === 'completed' ? winner : (h.score !== a.score ? winner : (tb || null)), tb, t, compensatedBy };
}

const EVENT_TYPES = ['match_init', 'match_start', 'score', 'discipline', 'tiebreak_winner', 'match_end', 'compensation'];

function appendEvent(S, b) {
  if (!isObj(b)) throw vErr(['body']);
  const f = [];
  if (!isId(b.event_id)) f.push('event_id');
  if (!isId(b.match_id)) f.push('match_id');
  if (!EVENT_TYPES.includes(b.type)) f.push('type');
  if (!isObj(b.payload)) f.push('payload');
  if (f.length) throw vErr(f);
  const bodyKey = canonical({ event_id: b.event_id, match_id: b.match_id, type: b.type, payload: b.payload });
  const prev = S.eventIndex.get(b.event_id);
  if (prev) {
    if (prev.bodyKey === bodyKey) return { status: 200, body: prev.response };
    throw err(409, 'DUPLICATE_EVENT_ID', 'event_id reused with a different body', { event_id: b.event_id });
  }
  const p = b.payload;
  const pf = [];
  switch (b.type) {
    case 'match_init':
      if (typeof p.sport_id !== 'string') pf.push('payload.sport_id');
      if (!isId(p.home_team_id)) pf.push('payload.home_team_id');
      if (!isId(p.away_team_id) || p.away_team_id === p.home_team_id) pf.push('payload.away_team_id');
      if (p.league_id !== undefined && p.league_id !== null && !isId(p.league_id)) pf.push('payload.league_id');
      break;
    case 'score':
      if (!isId(p.team_id)) pf.push('payload.team_id');
      if (typeof p.event_type !== 'string') pf.push('payload.event_type');
      break;
    case 'discipline':
      if (!isId(p.team_id)) pf.push('payload.team_id');
      if (!isInt(p.points)) pf.push('payload.points');
      break;
    case 'tiebreak_winner':
      if (!isId(p.team_id)) pf.push('payload.team_id');
      break;
    case 'compensation':
      if (!isId(p.compensates)) pf.push('payload.compensates');
      if (p.reason !== undefined && typeof p.reason !== 'string') pf.push('payload.reason');
      break;
  }
  if (pf.length) throw vErr(pf);

  let match = S.matches.get(b.match_id);
  if (b.type === 'match_init') {
    if (!S.sports.has(p.sport_id)) throw err(404, 'SPORT_NOT_FOUND', 'Unknown sport', { sport_id: p.sport_id });
    if (match) throw err(409, 'MATCH_EXISTS', 'Match already exists', { match_id: b.match_id });
    match = { match_id: b.match_id, sport_id: p.sport_id, league_id: p.league_id ?? null, home: p.home_team_id, away: p.away_team_id, events: [] };
    S.matches.set(b.match_id, match);
  } else {
    if (!match) throw err(404, 'MATCH_NOT_FOUND', 'Unknown match', { match_id: b.match_id });
    const pr = project(S, match);
    const sport = pr.sport;
    const inTeam = () => {
      if (p.team_id !== match.home && p.team_id !== match.away) throw vErr(['payload.team_id'], 'team_id is not part of this match');
    };
    const needInProgress = () => {
      if (pr.status !== 'in_progress') throw err(409, 'MATCH_NOT_IN_PROGRESS', 'Match is not in progress', { match_id: match.match_id, status: pr.status });
    };
    switch (b.type) {
      case 'match_start':
        if (pr.status !== 'upcoming') throw err(409, 'ILLEGAL_TRANSITION', `Cannot start a match that is ${pr.status}`, { match_id: match.match_id, from: pr.status, to: 'in_progress' });
        break;
      case 'score': {
        inTeam();
        const def = sport.scoring_events[p.event_type];
        if (!Object.prototype.hasOwnProperty.call(sport.scoring_events, p.event_type) || !def) {
          throw err(400, 'UNKNOWN_EVENT_TYPE', 'Unknown event_type for sport ' + sport.sport_id, { event_type: p.event_type, fields: ['payload.event_type'] });
        }
        needInProgress();
        const s = pr.t[p.team_id];
        if (sport.scoring_model === 'innings') {
          const pd = sport.periods;
          if (s.balls >= pd.innings_per_team * pd.overs_per_innings * pd.balls_per_over || s.wickets >= pd.innings_per_team * pd.wickets_per_innings) {
            throw err(409, 'INNINGS_COMPLETE', 'Innings is complete', { team_id: p.team_id });
          }
        } else if (sport.scoring_model === 'round') {
          if (pr.t[match.home].score >= (sport.periods.best_of + 1) / 2 || pr.t[match.away].score >= (sport.periods.best_of + 1) / 2) {
            throw err(409, 'SERIES_ALREADY_DECIDED', 'Series already decided', { match_id: match.match_id });
          }
        }
        break;
      }
      case 'discipline':
      case 'tiebreak_winner':
        inTeam();
        needInProgress();
        break;
      case 'match_end': {
        if (pr.status !== 'in_progress') throw err(409, 'ILLEGAL_TRANSITION', `Cannot end a match that is ${pr.status}`, { match_id: match.match_id, from: pr.status, to: 'completed' });
        const h = pr.t[match.home].score, a = pr.t[match.away].score;
        if (h === a && !sport.draw_allowed && !pr.tb) throw err(409, 'TIE_NOT_ALLOWED', 'Level score requires a tie-break winner', { match_id: match.match_id });
        break;
      }
      case 'compensation': {
        const target = S.eventIndex.get(p.compensates);
        if (!target) throw err(404, 'EVENT_NOT_FOUND', 'Unknown event', { event_id: p.compensates });
        const te = target.event;
        if (target.match_id !== match.match_id || !['score', 'discipline', 'tiebreak_winner'].includes(te.type) || pr.compensatedBy.has(te.event_id)) {
          throw err(409, 'INVALID_COMPENSATION', 'Event cannot be compensated', { event_id: p.compensates });
        }
        break;
      }
    }
  }
  const ev = { event_id: b.event_id, type: b.type, payload: clone(p), signature: sign(b.event_id, p), recorded_at: new Date().toISOString() };
  match.events.push(ev);
  const seq = match.events.length;
  ev.sequence = seq;
  const response = { event_id: b.event_id, match_id: match.match_id, type: b.type, sequence: seq, match_version: seq, signature: ev.signature };
  S.eventIndex.set(b.event_id, { bodyKey, response, match_id: match.match_id, event: ev });
  S.bus.emit('match_event', { match_id: match.match_id, event: response });
  return { status: 201, body: response };
}

function scoreView(S, matchId) {
  const match = S.matches.get(matchId);
  if (!match) throw err(404, 'MATCH_NOT_FOUND', 'Unknown match', { match_id: matchId });
  const pr = project(S, match);
  const inn = pr.sport.scoring_model === 'innings';
  const bpo = inn ? pr.sport.periods.balls_per_over : 0;
  const sideOut = (id) => {
    const s = pr.t[id];
    return { team_id: id, score: s.score, wickets: inn ? s.wickets : null, balls: inn ? s.balls : null,
      overs: inn ? `${Math.floor(s.balls / bpo)}.${s.balls % bpo}` : null, fair_play: s.fair_play };
  };
  const compensates = new Map();
  for (const e of match.events) if (e.type === 'compensation') compensates.set(e.payload.compensates, e.event_id);
  return {
    match_id: match.match_id, sport_id: match.sport_id, league_id: match.league_id, status: pr.status, outcome: pr.outcome,
    winner_team_id: pr.status === 'completed' ? pr.winner : null, tiebreak_winner_team_id: pr.tb,
    home: sideOut(match.home), away: sideOut(match.away), version: match.events.length,
    events: match.events.map((e) => ({ sequence: e.sequence, event_id: e.event_id, type: e.type, payload: e.payload, signature: e.signature,
      compensated: compensates.has(e.event_id), compensated_by: compensates.get(e.event_id) || null })),
  };
}

// ---------- Standings ----------
function standings(S, leagueId) {
  const L = S.leagues.get(leagueId);
  if (!L) throw err(404, 'LEAGUE_NOT_FOUND', 'Unknown league', { league_id: leagueId });
  const sport = S.sports.get(L.sport_id);
  const inn = sport.scoring_model === 'innings';
  const pd = sport.periods;
  const results = []; // completed matches
  const remaining = Object.fromEntries(L.teams.map((t) => [t, 0]));
  for (const mid of L.fixtures) {
    const m = S.matches.get(mid);
    const pr = project(S, m);
    if (pr.status === 'completed' && pr.outcome !== 'undecided') {
      const oversOf = (s) => {
        if (!inn) return 0;
        if (s.wickets >= pd.wickets_per_innings * pd.innings_per_team) return pd.overs_per_innings * pd.innings_per_team;
        return s.balls / pd.balls_per_over;
      };
      const h = pr.t[m.home], a = pr.t[m.away];
      results.push({ home: m.home, away: m.away, hs: h.score, as: a.score, ho: oversOf(h), ao: oversOf(a), hf: h.fair_play, af: a.fair_play,
        winner: pr.outcome === 'draw' ? null : pr.winner });
    } else {
      remaining[m.home]++; remaining[m.away]++;
    }
  }
  const agg = (team, filter) => {
    const r = { played: 0, won: 0, drawn: 0, lost: 0, scored: 0, conceded: 0, oF: 0, oA: 0, fair_play: 0 };
    for (const x of results) {
      if (filter && !filter(x)) continue;
      let me, op;
      if (x.home === team) { me = 'h'; op = 'a'; } else if (x.away === team) { me = 'a'; op = 'h'; } else continue;
      r.played++;
      r.scored += x[me + 's']; r.conceded += x[op + 's'];
      r.oF += x[me + 'o']; r.oA += x[op + 'o'];
      r.fair_play += x[me + 'f'];
      if (x.winner === null) r.drawn++; else if (x.winner === team) r.won++; else r.lost++;
    }
    r.points = r.won * L.points.win + r.drawn * L.points.draw + r.lost * L.points.loss;
    r.diff = inn ? Math.round(((r.oF ? r.scored / r.oF : 0) - (r.oA ? r.conceded / r.oA : 0)) * 1000) / 1000 : r.scored - r.conceded;
    return r;
  };
  const overall = Object.fromEntries(L.teams.map((t) => [t, agg(t)]));
  const lots = (t) => sha256hex(`${L.lots_seed}|${L.league_id}|${t}`);
  const criteria = L.tie_break_order.filter((c) => c !== 'draw_lots').concat(['draw_lots']);
  const resolvedBy = {};
  const crit = (c, group) => {
    const set = new Set(group);
    const among = (x) => set.has(x.home) && set.has(x.away);
    return group.map((t) => {
      switch (c) {
        case 'h2h_points': return agg(t, among).points;
        case 'h2h_diff': return agg(t, among).diff;
        case 'overall_diff': return overall[t].diff;
        case 'scored': return overall[t].scored;
        case 'fair_play': return overall[t].fair_play;
        default: return 0;
      }
    });
  };
  const resolve = (group) => {
    if (group.length <= 1) return group;
    for (const c of criteria) {
      if (c === 'draw_lots') {
        const sorted = group.slice().sort((a, b) => (lots(a) < lots(b) ? -1 : lots(a) > lots(b) ? 1 : 0));
        sorted.slice(0, -1).forEach((t) => { resolvedBy[t] = 'draw_lots'; });
        return sorted;
      }
      const vals = crit(c, group);
      if (vals.every((v) => v === vals[0])) continue;
      const distinct = [...new Set(vals)].sort((a, b) => b - a);
      const out = [];
      distinct.forEach((v, i) => {
        const sub = resolve(group.filter((_, k) => vals[k] === v));
        if (i < distinct.length - 1) resolvedBy[sub[sub.length - 1]] = c;
        out.push(...sub);
      });
      return out;
    }
    return group;
  };
  const byPts = new Map();
  for (const t of L.teams) { const p = overall[t].points; if (!byPts.has(p)) byPts.set(p, []); byPts.get(p).push(t); }
  const order = [...byPts.keys()].sort((a, b) => b - a).flatMap((p) => resolve(byPts.get(p)));
  const W = L.points.win, k = L.spots;
  const maxP = (t) => overall[t].points + W * remaining[t];
  const status = (t) => {
    const others = L.teams.filter((x) => x !== t);
    if (others.filter((x) => maxP(x) >= overall[t].points).length < k) return 'clinched';
    if (others.filter((x) => overall[x].points > maxP(t)).length >= k) return 'eliminated';
    return 'still_possible';
  };
  const table = order.map((t, i) => {
    const r = overall[t];
    return { rank: i + 1, team_id: t, played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, scored: r.scored, conceded: r.conceded,
      diff: r.diff, points: r.points, fair_play: r.fair_play, status: status(t), resolved_by: resolvedBy[t] || null };
  });
  const h2h = {};
  for (const a of L.teams) {
    h2h[a] = {};
    for (const b of L.teams) {
      if (a === b) continue;
      const r = agg(a, (x) => (x.home === a && x.away === b) || (x.home === b && x.away === a));
      h2h[a][b] = { played: r.played, points: r.points, scored: r.scored, conceded: r.conceded };
    }
  }
  return { league_id: L.league_id, sport_id: L.sport_id, qualification_spots: L.spots, table, h2h };
}

module.exports = { SEED_SPORTS, storeSport, createSport, createLeague, appendEvent, scoreView, standings, project };
