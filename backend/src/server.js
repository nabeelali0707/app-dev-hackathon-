'use strict';
const http = require('http');
const { EventEmitter } = require('events');
const { ApiError, err, vErr, isObj, isId } = require('./core');
const { generateFixtures } = require('./fixtures');
const league = require('./league');
const ops = require('./ops');

let S = null;
let lastSeed = 42;

function reset(body) {
  const b = body === undefined || body === null ? {} : body;
  if (!isObj(b)) throw vErr(['body']);
  const seed = b.seed === undefined ? 42 : b.seed;
  if (!Number.isInteger(seed)) throw vErr(['seed']);
  const stock = { 'var-jersey-001-M': 1, 'var-jersey-001-L': 5 };
  if (b.stock !== undefined) {
    if (!isObj(b.stock)) throw vErr(['stock']);
    for (const [k, v] of Object.entries(b.stock)) {
      if (!Number.isInteger(v) || v < 0) throw vErr(['stock']);
      stock[k] = v;
    }
  }
  const bus = S ? S.bus : new EventEmitter();
  lastSeed = seed;
  S = {
    seed, bus, sports: new Map(), leagues: new Map(), matches: new Map(), eventIndex: new Map(),
    rosterLeagues: new Map(), rosterPlayers: new Map(), rosterRequests: new Map(), auditCounter: 0,
    orders: new Map(), payCounter: 0, queue: [], offline: new Map(),
    tenants: new Map([['tenant-alpha', { name: 'Alpha Sports' }], ['tenant-beta', { name: 'Beta Athletics' }]]),
    products: new Map([['prod-jersey-001', { tenant_id: 'tenant-alpha', name: 'Home Jersey', type: 'apparel' }]]),
    variants: new Map(), discounts: new Map([['WELCOME10', 10]]),
    entities: {
      leagues: new Map([['league-alpha-1', { tenant_id: 'tenant-alpha' }], ['league-alpha-2', { tenant_id: 'tenant-alpha' }], ['league-beta-1', { tenant_id: 'tenant-beta' }]]),
      clubs: new Map([['club-alpha-1', { tenant_id: 'tenant-alpha' }], ['club-alpha-2', { tenant_id: 'tenant-alpha' }], ['club-beta-1', { tenant_id: 'tenant-beta' }]]),
      players: new Map([['player-alpha-1', { tenant_id: 'tenant-alpha', club_id: 'club-alpha-1' }], ['player-alpha-2', { tenant_id: 'tenant-alpha', club_id: 'club-alpha-2' }], ['player-beta-1', { tenant_id: 'tenant-beta', club_id: 'club-beta-1' }]]),
    },
  };
  for (const [vid, n] of Object.entries(stock)) {
    S.variants.set(vid, { variant_id: vid, product_id: 'prod-jersey-001', size: vid.split('-').pop(), price_minor: 450000, currency: 'PKR', stock: n, reserved: 0 });
  }
  for (const sp of league.SEED_SPORTS) league.storeSport(S, sp);
  return { status: 200, body: { status: 'reset_complete', seed, sports: league.SEED_SPORTS.map((s) => s.sport_id), tenants: ['tenant-alpha', 'tenant-beta'], stock } };
}

// Offline sync: replays queued mobile actions in client order; each action is idempotent by action_id.
function offlineSync(body) {
  if (!isObj(body) || !Array.isArray(body.actions)) throw vErr(['actions']);
  const results = body.actions.map((a) => {
    if (!isObj(a) || !isId(a.action_id)) return { action_id: a && a.action_id, status: 'rejected', http_status: 400, error: { code: 'VALIDATION_ERROR', fields: ['action_id'] } };
    const prev = S.offline.get(a.action_id);
    if (prev) return prev;
    let out;
    try {
      let r;
      if (a.type === 'event' || a.type === 'score_event') r = league.appendEvent(S, a.payload);
      else if (a.type === 'roster_transfer') r = ops.rosterTransfer(S, a.payload);
      else throw vErr(['type']);
      out = { action_id: a.action_id, status: r.status === 200 ? 'duplicate' : 'applied', http_status: r.status, result: r.body };
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      out = { action_id: a.action_id, status: e.status === 409 ? 'conflict' : 'rejected', http_status: e.status,
        resolution: e.status === 409 ? 'server_wins' : 'discarded', error: { code: e.code, message: e.message, details: e.details } };
    }
    S.offline.set(a.action_id, out);
    return out;
  });
  return { status: 200, body: { client_id: body.client_id ?? null, results } };
}

// Rate limiter for /api/v1/*: 100 requests per rolling 10 s per client IP.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 10000);
  if (arr.length >= 100) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

const sseClients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

function route(method, path, query, body, req) {
  let m;
  if (method === 'GET' && path === '/health') {
    if (!S) throw err(503, 'NOT_READY', 'Not seeded');
    return { status: 200, body: { status: 'ok' } };
  }
  if (method === 'POST' && path === '/audit/v1/reset') return reset(body);
  if (method === 'POST' && path === '/audit/v1/sports') return league.createSport(S, body);
  if (method === 'POST' && path === '/audit/v1/fixtures') return { status: 200, body: generateFixtures(body) };
  if (method === 'POST' && path === '/audit/v1/leagues') return league.createLeague(S, body);
  if (method === 'POST' && path === '/audit/v1/events') return league.appendEvent(S, body);
  if (method === 'GET' && (m = path.match(/^\/audit\/v1\/score\/([^/]+)$/))) return { status: 200, body: league.scoreView(S, decodeURIComponent(m[1])) };
  if (method === 'GET' && (m = path.match(/^\/audit\/v1\/standings\/([^/]+)$/))) return { status: 200, body: league.standings(S, decodeURIComponent(m[1])) };
  if (method === 'POST' && path === '/audit/v1/roster/setup') return ops.rosterSetup(S, body);
  if (method === 'POST' && path === '/audit/v1/roster/transfer') return ops.rosterTransfer(S, body);
  if (method === 'GET' && (m = path.match(/^\/audit\/v1\/roster\/history\/([^/]+)$/))) return ops.rosterHistory(S, decodeURIComponent(m[1]), query.get('as_of') ?? undefined);
  if (method === 'POST' && path === '/audit/v1/checkout') return ops.checkout(S, body);
  if (method === 'GET' && (m = path.match(/^\/audit\/v1\/inventory\/([^/]+)$/))) return ops.inventory(S, decodeURIComponent(m[1]));
  if (method === 'POST' && path === '/audit/v1/rbac-matrix') return ops.rbacMatrix();
  if (method === 'POST' && path === '/audit/v1/offline-sync') return offlineSync(body);
  const auth = req.headers.authorization;
  if (method === 'POST' && path === '/audit/v1/rbac/tenants') return ops.probe(S, 'tenants.create', null, null, auth);
  if (method === 'POST' && (m = path.match(/^\/audit\/v1\/rbac\/leagues\/([^/]+)\/fixtures$/))) return ops.probe(S, 'league.fixtures.write', 'leagues', decodeURIComponent(m[1]), auth);
  if (method === 'POST' && (m = path.match(/^\/audit\/v1\/rbac\/clubs\/([^/]+)\/roster$/))) return ops.probe(S, 'club.roster.write', 'clubs', decodeURIComponent(m[1]), auth);
  if (method === 'POST' && (m = path.match(/^\/audit\/v1\/rbac\/clubs\/([^/]+)\/products$/))) return ops.probe(S, 'club.products.write', 'clubs', decodeURIComponent(m[1]), auth);
  if (method === 'PATCH' && (m = path.match(/^\/audit\/v1\/rbac\/players\/([^/]+)$/))) return ops.probe(S, 'player.update', 'players', decodeURIComponent(m[1]), auth);
  if (method === 'GET' && (m = path.match(/^\/audit\/v1\/rbac\/clubs\/([^/]+)$/))) return ops.probe(S, 'club.read', 'clubs', decodeURIComponent(m[1]), auth);
  if (method === 'GET' && path === '/audit/v1/rbac/platform/config') return ops.probe(S, 'platform.config', null, null, auth);
  // Public app API (rate limited)
  if (method === 'GET' && path === '/api/v1/ping') return { status: 200, body: { status: 'ok', pong: true } };
  if (method === 'GET' && path === '/api/v1/sports') return { status: 200, body: { sports: [...S.sports.values()] } };
  if (method === 'GET' && (m = path.match(/^\/api\/v1\/matches\/([^/]+)$/))) return { status: 200, body: league.scoreView(S, decodeURIComponent(m[1])) };
  if (method === 'GET' && (m = path.match(/^\/api\/v1\/standings\/([^/]+)$/))) return { status: 200, body: league.standings(S, decodeURIComponent(m[1])) };
  if (method === 'POST' && path === '/api/v1/offline-sync') { ops.jwtVerify(req.headers.authorization); return offlineSync(body); }
  throw err(404, 'NOT_FOUND', `No route for ${method} ${path}`);
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  if (path.startsWith('/api/v1/') && rateLimited(req.socket.remoteAddress || 'unknown')) {
    return send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests', details: { limit: 100, window_seconds: 10 } } });
  }
  if (req.method === 'GET' && path === '/api/v1/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  const chunks = [];
  let size = 0, aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > 1024 * 1024) {
      aborted = true;
      send(res, 413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Body exceeds 1 MB', details: { max_bytes: 1048576 } } });
      req.resume();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      let body;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length) {
        try { body = JSON.parse(raw); } catch { throw err(400, 'VALIDATION_ERROR', 'Malformed JSON body', { fields: ['body'] }); }
      }
      if (!S && path !== '/audit/v1/reset' && path !== '/health') reset({});
      const out = route(req.method, path, url.searchParams, body, req);
      send(res, out.status, out.body);
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { error: { code: e.code, message: e.message, details: e.details || {} } });
      console.error(e);
      send(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} } });
    }
  });
});

reset({});
S.bus.on('match_event', (d) => broadcast('match_event', d));
S.bus.on('roster_changed', (d) => broadcast('roster_changed', d));

if (require.main === module) {
  if (!process.env.DAY1_SALT) console.warn('WARNING: DAY1_SALT is not set');
  const port = parseInt(process.env.PORT || '8080', 10);
  server.listen(port, '0.0.0.0', () => console.log(`API listening on :${port}`));
}

module.exports = { server, reset, getState: () => S };
