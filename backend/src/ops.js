'use strict';
// FR-2.2 roster/transfers/loans, FR-2.3 store checkout, FR-5.1 RBAC.
const crypto = require('crypto');
const { err, vErr, isId, isInt, isObj, isDate, addDays, nowIso, today, canonical, sign } = require('./core');

// ---------------- Roster ----------------
const ROLES = ['captain', 'vice_captain', 'starter', 'substitute'];

function rosterSetup(S, b) {
  if (!isObj(b) || !isObj(b.league)) throw vErr(['league']);
  const lg = b.league;
  const f = [];
  if (!isId(lg.league_id)) f.push('league.league_id');
  if (!isId(lg.tenant_id)) f.push('league.tenant_id');
  if (typeof lg.sport_id !== 'string') f.push('league.sport_id');
  if (!isObj(lg.transfer_window) || !isDate(lg.transfer_window.open) || !isDate(lg.transfer_window.close)) f.push('league.transfer_window');
  if (lg.max_squad_size !== undefined && !(isInt(lg.max_squad_size) && lg.max_squad_size >= 1)) f.push('league.max_squad_size');
  if (lg.required_positions !== undefined && !isObj(lg.required_positions)) f.push('league.required_positions');
  if (!Array.isArray(b.squads) || !b.squads.every((s) => isObj(s) && isId(s.squad_id) && isId(s.tenant_id))) f.push('squads');
  if (!Array.isArray(b.players) || !b.players.every((p) => isObj(p) && isId(p.player_id) && typeof p.position === 'string' &&
      (p.squad_id === null || isId(p.squad_id)) && (p.role === undefined || ROLES.includes(p.role)))) f.push('players');
  const mip = b.matches_in_progress === undefined ? [] : b.matches_in_progress;
  if (!Array.isArray(mip)) f.push('matches_in_progress');
  if (f.length) throw vErr(f);
  const sport = S.sports.get(lg.sport_id);
  if (!sport) throw err(404, 'SPORT_NOT_FOUND', 'Unknown sport', { sport_id: lg.sport_id });
  const squads = new Map(b.squads.map((s) => [s.squad_id, { ...s }]));
  for (const p of b.players) if (p.squad_id && !squads.has(p.squad_id)) throw err(404, 'SQUAD_NOT_FOUND', 'Unknown squad', { squad_id: p.squad_id });
  // replace previous state of this league
  for (const [pid, p] of S.rosterPlayers) if (p.league_id === lg.league_id) S.rosterPlayers.delete(pid);
  const league = {
    league_id: lg.league_id, tenant_id: lg.tenant_id, sport_id: lg.sport_id, window: { ...lg.transfer_window },
    max_squad_size: lg.max_squad_size ?? sport.roster.max_squad_size,
    required_positions: lg.required_positions ?? sport.roster.required_positions, squads, matches_in_progress: mip,
  };
  S.rosterLeagues.set(league.league_id, league);
  for (const p of b.players) {
    S.rosterPlayers.set(p.player_id, {
      player_id: p.player_id, name: p.name || p.player_id, position: p.position, league_id: league.league_id, squad_id: p.squad_id,
      role: p.role || 'substitute', parent_squad_id: null, registration_type: 'registration', start_date: null, loan_end_date: null,
      history: [],
    });
  }
  const counts = {};
  for (const sid of squads.keys()) counts[sid] = squadCount(S, league.league_id, sid);
  return { status: 201, body: { league_id: league.league_id, status: 'configured', squad_counts: counts } };
}

const squadCount = (S, leagueId, sid) => [...S.rosterPlayers.values()].filter((p) => p.league_id === leagueId && p.squad_id === sid).length;

function applyLoanReturn(S, p, asOf) {
  if (p.registration_type === 'loan' && p.loan_end_date && asOf > p.loan_end_date) {
    const ret = addDays(p.loan_end_date, 1);
    const entry = {
      audit_id: nextAudit(S), action: 'loan_return', player_id: p.player_id, league_id: p.league_id, from_squad_id: p.squad_id,
      to_squad_id: p.parent_squad_id, effective_date: ret, state: 'active', who: 'system', when: nowIso(), why: 'Loan period ended',
    };
    p.history.push(entry);
    p.squad_id = p.parent_squad_id;
    p.parent_squad_id = null;
    p.registration_type = 'loan_return';
    p.start_date = ret;
    p.loan_end_date = null;
    p.role = 'substitute';
  }
}
const nextAudit = (S) => 'au-' + String(++S.auditCounter).padStart(4, '0');

function rosterTransfer(S, b) {
  if (!isObj(b)) throw vErr(['body']);
  const f = [];
  for (const k of ['request_id', 'league_id', 'player_id']) if (!isId(b[k])) f.push(k);
  if (!['transfer', 'loan', 'release'].includes(b.type)) f.push('type');
  if (!isId(b.from_squad_id)) f.push('from_squad_id');
  if (b.type !== 'release' && !isId(b.to_squad_id)) f.push('to_squad_id');
  if (b.type === 'release' && b.to_squad_id !== null && b.to_squad_id !== undefined) f.push('to_squad_id');
  if (!isDate(b.effective_date)) f.push('effective_date');
  if (b.type === 'loan') {
    if (!isDate(b.loan_end_date) || (isDate(b.effective_date) && b.loan_end_date <= b.effective_date)) f.push('loan_end_date');
  } else if (b.loan_end_date !== null && b.loan_end_date !== undefined) f.push('loan_end_date');
  if (b.reason !== undefined && b.reason !== null && typeof b.reason !== 'string') f.push('reason');
  if (b.requested_by !== undefined && b.requested_by !== null && typeof b.requested_by !== 'string') f.push('requested_by');
  if (f.length) throw vErr(f);
  const key = canonical(b);
  const prev = S.rosterRequests.get(b.request_id);
  if (prev) {
    if (prev.key === key) return { status: 200, body: prev.body };
    throw err(409, 'DUPLICATE_REQUEST_ID', 'request_id reused with a different body', { request_id: b.request_id });
  }
  const L = S.rosterLeagues.get(b.league_id);
  if (!L) throw err(404, 'LEAGUE_NOT_FOUND', 'Unknown league', { league_id: b.league_id });
  const p = S.rosterPlayers.get(b.player_id);
  if (!p || p.league_id !== L.league_id) throw err(404, 'PLAYER_NOT_FOUND', 'Unknown player', { player_id: b.player_id });
  const from = L.squads.get(b.from_squad_id);
  if (!from) throw err(404, 'SQUAD_NOT_FOUND', 'Unknown squad', { squad_id: b.from_squad_id });
  const to = b.type === 'release' ? null : L.squads.get(b.to_squad_id);
  if (b.type !== 'release' && !to) throw err(404, 'SQUAD_NOT_FOUND', 'Unknown squad', { squad_id: b.to_squad_id });
  if (from.tenant_id !== L.tenant_id || (to && to.tenant_id !== L.tenant_id)) {
    throw err(409, 'CROSS_TENANT_TRANSFER', 'Squads must belong to the league tenant', { squad_id: from.tenant_id !== L.tenant_id ? from.squad_id : to.squad_id });
  }
  applyLoanReturn(S, p, b.effective_date);
  if (p.squad_id !== from.squad_id) throw err(409, 'NOT_IN_SQUAD', 'Player is not in from_squad_id', { player_id: p.player_id, squad_id: from.squad_id });
  if (b.type !== 'release' && (b.effective_date < L.window.open || b.effective_date > L.window.close)) {
    throw err(409, 'TRANSFER_WINDOW_CLOSED', 'Effective date is outside the transfer window', { open: L.window.open, close: L.window.close });
  }
  if (p.registration_type === 'loan') throw err(409, 'PLAYER_ON_LOAN', 'Player is currently on loan', { player_id: p.player_id });
  if (to && squadCount(S, L.league_id, to.squad_id) + 1 > L.max_squad_size) throw err(409, 'SQUAD_FULL', 'Destination squad is full', { squad_id: to.squad_id });
  const req = L.required_positions[p.position];
  if (req !== undefined) {
    const have = [...S.rosterPlayers.values()].filter((x) => x.league_id === L.league_id && x.squad_id === from.squad_id && x.position === p.position).length;
    if (have - 1 < req) throw err(409, 'MIN_POSITION_VIOLATION', 'Squad would drop below the required count for ' + p.position, { squad_id: from.squad_id, position: p.position });
  }
  const blocking = L.matches_in_progress.find((m) => m && (m.home_squad_id === from.squad_id || m.away_squad_id === from.squad_id));
  const state = blocking ? 'deferred_until_match_end' : 'active';
  if (b.type === 'release') {
    p.squad_id = null; p.registration_type = 'release'; p.parent_squad_id = null; p.loan_end_date = null;
  } else {
    p.squad_id = to.squad_id;
    p.parent_squad_id = b.type === 'loan' ? from.squad_id : null;
    p.registration_type = b.type;
    p.loan_end_date = b.type === 'loan' ? b.loan_end_date : null;
    p.role = 'substitute';
  }
  p.start_date = b.effective_date;
  const audit = {
    audit_id: nextAudit(S), action: b.type, player_id: p.player_id, league_id: L.league_id, from_squad_id: from.squad_id,
    to_squad_id: to ? to.squad_id : null, effective_date: b.effective_date, state, who: b.requested_by || 'unknown', when: nowIso(), why: b.reason || '',
  };
  p.history.push(audit);
  const body = {
    request_id: b.request_id, status: 'accepted', state, blocking_match_id: blocking ? blocking.match_id : null,
    registration: b.type === 'release' ? null : {
      player_id: p.player_id, league_id: L.league_id, squad_id: p.squad_id, parent_squad_id: p.parent_squad_id,
      registration_type: b.type, start_date: b.effective_date, loan_end_date: p.loan_end_date, role: 'substitute',
    },
    audit_entry: audit,
  };
  S.rosterRequests.set(b.request_id, { key, body });
  S.bus.emit('roster_changed', audit);
  return { status: 201, body };
}

function rosterHistory(S, playerId, asOf) {
  if (asOf !== undefined && !isDate(asOf)) throw vErr(['as_of']);
  const p = S.rosterPlayers.get(playerId);
  if (!p) throw err(404, 'PLAYER_NOT_FOUND', 'Unknown player', { player_id: playerId });
  const date = asOf || today();
  applyLoanReturn(S, p, date);
  return { status: 200, body: { player_id: p.player_id, as_of: date, league_id: p.league_id, current_squad_id: p.squad_id, parent_squad_id: p.parent_squad_id, history: p.history.slice() } };
}

// ---------------- Store ----------------
function fmtPKR(minor) { return `PKR ${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`; }

function buildPdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '?');
  let content = 'BT /F1 12 Tf 50 780 Td 16 TL\n';
  for (const l of lines) content += `(${esc(l)}) Tj T*\n`;
  content += 'ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1').toString('base64');
}

function checkout(S, b) {
  if (!isObj(b)) throw vErr(['body']);
  const f = [];
  if (!isId(b.order_id)) f.push('order_id');
  if (!isId(b.customer_id)) f.push('customer_id');
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 10 ||
      !b.items.every((i) => isObj(i) && isId(i.variant_id) && isInt(i.quantity) && i.quantity >= 1 && i.quantity <= 10) ||
      new Set(b.items.map((i) => i.variant_id)).size !== b.items.length) f.push('items');
  if (b.discount_code !== undefined && b.discount_code !== null && typeof b.discount_code !== 'string') f.push('discount_code');
  if (!isObj(b.payment) || typeof b.payment.token !== 'string') f.push('payment');
  if (f.length) throw vErr(f);
  const key = canonical(b);
  const prev = S.orders.get(b.order_id);
  if (prev) {
    if (prev.key !== key) throw err(409, 'DUPLICATE_ORDER_ID', 'order_id reused with a different body', { order_id: b.order_id });
    if (prev.error) throw prev.error;
    return { status: 200, body: prev.body };
  }
  for (const i of b.items) if (!S.variants.has(i.variant_id)) throw err(404, 'VARIANT_NOT_FOUND', 'Unknown variant', { variant_id: i.variant_id });
  if (b.discount_code !== undefined && b.discount_code !== null && !S.discounts.has(b.discount_code)) {
    throw err(400, 'INVALID_DISCOUNT_CODE', 'Unknown discount code', { discount_code: b.discount_code });
  }
  // Atomic reservation: the whole check-and-reserve block runs synchronously on the single event loop,
  // so concurrent requests are serialised and stock can never go negative (NFR-3).
  for (const i of b.items) {
    const v = S.variants.get(i.variant_id);
    if (v.stock < i.quantity) {
      const e = err(409, 'OUT_OF_STOCK', `Variant ${i.variant_id} has no stock left.`, { variant_id: i.variant_id });
      S.orders.set(b.order_id, { key, error: e });
      throw e;
    }
  }
  for (const i of b.items) { const v = S.variants.get(i.variant_id); v.stock -= i.quantity; v.reserved += i.quantity; }
  const release = () => { for (const i of b.items) { const v = S.variants.get(i.variant_id); v.stock += i.quantity; v.reserved -= i.quantity; } };
  const commit = () => { for (const i of b.items) S.variants.get(i.variant_id).reserved -= i.quantity; };
  const token = b.payment.token;
  const authId = 'auth_' + (++S.payCounter);
  if (token !== 'tok_success' && token !== 'tok_capture_fail') {
    release();
    const e = err(402, 'PAYMENT_DECLINED', 'Payment authorization was declined', { order_id: b.order_id });
    S.orders.set(b.order_id, { key, error: e });
    S.queue.push({ type: 'order.payment_failed', order_id: b.order_id, at: nowIso() });
    throw e;
  }
  if (token === 'tok_capture_fail') {
    release();
    const e = err(402, 'PAYMENT_CAPTURE_FAILED', 'Payment capture failed; authorization voided', { order_id: b.order_id, authorization_id: authId });
    S.orders.set(b.order_id, { key, error: e });
    S.queue.push({ type: 'order.payment_failed', order_id: b.order_id, at: nowIso() });
    throw e;
  }
  commit();
  const items = b.items.map((i) => ({ variant_id: i.variant_id, quantity: i.quantity, unit_price_minor: S.variants.get(i.variant_id).price_minor }));
  const subtotal = items.reduce((s, i) => s + i.quantity * i.unit_price_minor, 0);
  const pct = b.discount_code ? S.discounts.get(b.discount_code) : 0;
  const discount = Math.floor((subtotal * pct) / 100);
  const total = subtotal - discount;
  const payload = { order_id: b.order_id, customer_id: b.customer_id, items, subtotal_minor: subtotal, discount_minor: discount, total_minor: total, currency: 'PKR', paid_at: nowIso() };
  const pdf = buildPdf([
    'Club Store Receipt', `Order: ${b.order_id}`, `Customer: ${b.customer_id}`,
    ...items.map((i) => `${i.variant_id} x${i.quantity} @ ${fmtPKR(i.unit_price_minor)}`),
    `Subtotal: ${fmtPKR(subtotal)}`, `Discount: ${fmtPKR(discount)}`, `Total: ${fmtPKR(total)}`, `Paid at: ${payload.paid_at}`,
  ]);
  const body = {
    order_id: b.order_id, status: 'paid', currency: 'PKR', items, subtotal_minor: subtotal, discount_minor: discount, total_minor: total,
    payment: { authorization_id: authId, capture_id: 'cap_' + S.payCounter, state: 'captured' },
    receipt: { payload, signature: sign(b.order_id, payload), pdf_base64: pdf },
  };
  S.orders.set(b.order_id, { key, body });
  S.queue.push({ type: 'order.status_changed', order_id: b.order_id, from: 'pending', to: 'paid', at: nowIso() });
  return { status: 201, body };
}

function inventory(S, id) {
  const v = S.variants.get(id);
  if (!v) throw err(404, 'VARIANT_NOT_FOUND', 'Unknown variant', { variant_id: id });
  return { status: 200, body: { variant_id: id, stock: v.stock, reserved: v.reserved } };
}

// ---------------- RBAC / JWT ----------------
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function jwtSign(claims, ttlSec = 24 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ ...claims, iat: now, exp: now + ttlSec }));
  const s = b64u(crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest());
  return `${h}.${p}.${s}`;
}
function jwtVerify(header) {
  const unauth = () => err(401, 'UNAUTHENTICATED', 'Missing or invalid token');
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw unauth();
  const parts = header.slice(7).trim().split('.');
  if (parts.length !== 3) throw unauth();
  let h, p;
  try {
    h = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw unauth(); }
  if (!isObj(h) || h.alg !== 'HS256' || !isObj(p)) throw unauth();
  const expect = crypto.createHmac('sha256', JWT_SECRET).update(parts[0] + '.' + parts[1]).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) throw unauth();
  if (typeof p.exp !== 'number' || p.exp <= Math.floor(Date.now() / 1000)) throw unauth();
  return p;
}

const PRINCIPALS = {
  super_admin: { sub: 'user-super', role: 'super_admin', tenant_id: null },
  league_organizer: { sub: 'user-organizer', role: 'league_organizer', tenant_id: 'tenant-alpha', league_ids: ['league-alpha-1'] },
  club_manager: { sub: 'user-clubmgr', role: 'club_manager', tenant_id: 'tenant-alpha', club_id: 'club-alpha-1' },
  player: { sub: 'user-player', role: 'player', tenant_id: 'tenant-alpha', player_id: 'player-alpha-1', club_id: 'club-alpha-1' },
  viewer: { sub: 'user-viewer', role: 'viewer', tenant_id: 'tenant-alpha' },
};

function rbacMatrix() {
  const tokens = {};
  for (const [k, v] of Object.entries(PRINCIPALS)) tokens[k] = jwtSign(v);
  return { status: 200, body: { tokens, context: {
    tenant_id: 'tenant-alpha', foreign_tenant_id: 'tenant-beta', own_league_id: 'league-alpha-1', other_league_id: 'league-alpha-2',
    foreign_league_id: 'league-beta-1', own_club_id: 'club-alpha-1', other_club_id: 'club-alpha-2', foreign_club_id: 'club-beta-1',
    own_player_id: 'player-alpha-1', other_player_id: 'player-alpha-2', foreign_player_id: 'player-beta-1' } } };
}

// Policy-as-code: one function per protected action.
const POLICY = {
  'tenants.create': (u) => u.role === 'super_admin',
  'league.fixtures.write': (u, r) => u.role === 'super_admin' || (u.role === 'league_organizer' && u.tenant_id === r.tenant_id && (u.league_ids || []).includes(r.id)),
  'club.roster.write': (u, r) => u.role === 'super_admin' || (u.role === 'club_manager' && u.tenant_id === r.tenant_id && u.club_id === r.id),
  'club.products.write': (u, r) => u.role === 'super_admin' || (u.role === 'club_manager' && u.tenant_id === r.tenant_id && u.club_id === r.id),
  'player.update': (u, r) => u.role === 'super_admin' || (u.tenant_id === r.tenant_id &&
    ((u.role === 'club_manager' && u.club_id === r.club_id) || (u.role === 'player' && u.player_id === r.id))),
  'club.read': (u, r) => u.role === 'super_admin' || u.tenant_id === r.tenant_id,
  'platform.config': (u) => u.role === 'super_admin',
};

function probe(S, action, kind, id, authHeader) {
  const user = jwtVerify(authHeader);
  let res = null;
  if (kind) {
    res = S.entities[kind].get(id);
    if (!res) throw err(404, kind.toUpperCase().replace(/S$/, '') + '_NOT_FOUND', `Unknown ${kind}`, { id });
    res = { id, ...res };
  }
  if (!POLICY[action](user, res)) throw err(403, 'FORBIDDEN', 'Not allowed', { action });
  return { status: 200, body: { authorized: true } };
}

module.exports = { rosterSetup, rosterTransfer, rosterHistory, checkout, inventory, rbacMatrix, probe, jwtSign, jwtVerify, PRINCIPALS, POLICY, buildPdf, fmtPKR };
