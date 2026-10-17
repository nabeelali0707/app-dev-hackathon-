'use strict';
process.env.DAY1_SALT = 'unit-salt';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { canonical, sign } = require('../backend/src/core');
const { roundRobin, swiss, singleElim, doubleElim, seedOrder } = require('../backend/src/fixtures');
const ops = require('../backend/src/ops');

test('canonical json sorts keys and has no whitespace', () => {
  assert.strictEqual(canonical({ b: 1, a: { d: true, c: null }, e: ['x', 2] }), '{"a":{"c":null,"d":true},"b":1,"e":["x",2]}');
});
test('signature matches HMAC recipe', () => {
  const exp = crypto.createHmac('sha256', 'unit-salt').update('evt-1|{"event_type":"goal","team_id":"t1"}').digest('hex');
  assert.strictEqual(sign('evt-1', { team_id: 't1', event_type: 'goal' }), exp);
});
test('round robin: each pair once, home/away balanced, byes', () => {
  for (const n of [2, 3, 4, 5, 6, 7, 8, 11]) {
    const teams = Array.from({ length: n }, (_, i) => 't' + i);
    const r = roundRobin(teams, { legs: 1 });
    const pairs = new Set(); const bal = Object.fromEntries(teams.map((t) => [t, 0]));
    for (const rd of r.rounds) for (const m of rd.matches) { pairs.add([m.home, m.away].sort().join('|')); bal[m.home]++; bal[m.away]--; }
    assert.strictEqual(pairs.size, (n * (n - 1)) / 2);
    for (const t of teams) assert.ok(Math.abs(bal[t]) <= 1, `balance n=${n}`);
  }
});
test('double round robin covers each ordered pair once', () => {
  const r = roundRobin(['a', 'b', 'c', 'd'], { legs: 2 });
  const s = new Set(); r.rounds.forEach((rd) => rd.matches.forEach((m) => s.add(m.home + '>' + m.away)));
  assert.strictEqual(s.size, 12);
});
test('swiss round 1 exact', () => {
  const r = swiss(['t1', 't2', 't3', 't4', 't5'], { round: 1, total_rounds: 3 });
  assert.deepStrictEqual(r.pairings.map((p) => [p.home, p.away]), [['t1', 't3'], ['t2', 't4']]);
  assert.strictEqual(r.bye, 't5');
});
test('seed order', () => assert.deepStrictEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]));
test('single elim byes propagate', () => {
  const r = singleElim(['t1', 't2', 't3', 't4', 't5', 't6'], {});
  assert.strictEqual(r.rounds[1].matches[0].home, 't1');
  assert.strictEqual(r.rounds[0].matches[0].bye, true);
});
test('double elim counts', () => {
  const r = doubleElim(Array.from({ length: 8 }, (_, i) => 't' + i), { bracket_reset: true });
  assert.strictEqual(r.losers.reduce((s, x) => s + x.matches.length, 0), 6);
  assert.strictEqual(r.grand_final.length, 2);
});
test('jwt rejects alg none and tampering', () => {
  const tok = ops.jwtSign({ role: 'viewer' });
  assert.ok(ops.jwtVerify('Bearer ' + tok));
  const [h, p] = tok.split('.');
  const none = Buffer.from('{"alg":"none"}').toString('base64url');
  assert.throws(() => ops.jwtVerify(`Bearer ${none}.${p}.`));
  assert.throws(() => ops.jwtVerify(`Bearer ${h}.${p}.AAAA`));
});
test('rbac negative boundaries', () => {
  const P = ops.POLICY;
  assert.strictEqual(P['league.fixtures.write'](ops.PRINCIPALS.league_organizer, { id: 'league-alpha-2', tenant_id: 'tenant-alpha' }), false);
  assert.strictEqual(P['club.read'](ops.PRINCIPALS.viewer, { id: 'club-beta-1', tenant_id: 'tenant-beta' }), false);
  assert.strictEqual(P['platform.config'](ops.PRINCIPALS.club_manager), false);
});
