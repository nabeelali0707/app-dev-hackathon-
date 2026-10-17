import { useEffect, useState, useCallback } from 'react';
import {
  SafeAreaView, View, Text, TextInput, Pressable, ScrollView, StyleSheet, ActivityIndicator, StatusBar,
} from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import NetInfo from '@react-native-community/netinfo';

// ---------- Local persistence (NFR-4): cache + offline action queue ----------
const db = SQLite.openDatabaseSync('league.db');
db.execSync(`
  CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS queue (action_id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', result TEXT, created_at TEXT NOT NULL);
`);
const cachePut = (key, obj) => db.runSync('INSERT OR REPLACE INTO cache (key, json, updated_at) VALUES (?, ?, ?)', key, JSON.stringify(obj), new Date().toISOString());
const cacheGet = (key) => {
  const row = db.getFirstSync('SELECT json, updated_at FROM cache WHERE key = ?', key);
  return row ? { data: JSON.parse(row.json), updated_at: row.updated_at } : null;
};
const queueAll = () => db.getAllSync('SELECT * FROM queue ORDER BY created_at');
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const ROLES = [
  { key: 'super_admin', label: 'Platform Super-Admin' },
  { key: 'league_organizer', label: 'League Organizer' },
  { key: 'club_manager', label: 'Club Manager' },
  { key: 'player', label: 'Player' },
  { key: 'viewer', label: 'General Viewer' },
];

async function api(base, path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
  return json;
}

// ---------- UI primitives ----------
const C = { bg: '#0F172A', card: '#1E293B', text: '#F8FAFC', muted: '#94A3B8', accent: '#22C55E', warn: '#F59E0B', danger: '#EF4444', line: '#334155' };

function Button({ label, onPress, kind = 'primary', disabled }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }}
      onPress={onPress} disabled={disabled}
      style={({ pressed }) => [s.btn, kind === 'ghost' && s.btnGhost, kind === 'danger' && { backgroundColor: C.danger }, (pressed || disabled) && { opacity: 0.6 }]}>
      <Text style={[s.btnText, kind === 'ghost' && { color: C.text }]}>{label}</Text>
    </Pressable>
  );
}
const Field = ({ label, ...p }) => (
  <View style={{ marginBottom: 12 }}>
    <Text style={s.label}>{label}</Text>
    <TextInput accessibilityLabel={label} placeholderTextColor={C.muted} style={s.input} autoCapitalize="none" {...p} />
  </View>
);
const Card = ({ title, children }) => (
  <View style={s.card} accessibilityRole="summary">
    {title ? <Text style={s.cardTitle}>{title}</Text> : null}
    {children}
  </View>
);

// ---------- Screens ----------
function Login({ base, setBase, onLogin }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const signIn = async (role) => {
    setBusy(true); setError(null);
    try {
      const { tokens, context } = await api(base, '/audit/v1/rbac-matrix', { method: 'POST' });
      await SecureStore.setItemAsync('token', tokens[role]);
      await SecureStore.setItemAsync('session', JSON.stringify({ role, context }));
      onLogin({ role, token: tokens[role], context });
    } catch (e) { setError(`Could not sign in: ${e.message}. Check the server address.`); }
    setBusy(false);
  };
  return (
    <ScrollView contentContainerStyle={s.pad}>
      <Text style={s.h1} accessibilityRole="header">League Ops</Text>
      <Text style={s.muted}>Sign in with a demo account to continue.</Text>
      <Field label="Server address" value={base} onChangeText={setBase} keyboardType="url" />
      {ROLES.map((r) => <Button key={r.key} label={`Continue as ${r.label}`} onPress={() => signIn(r.key)} disabled={busy} kind="ghost" />)}
      {busy && <ActivityIndicator color={C.accent} style={{ marginTop: 12 }} />}
      {error && <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text>}
    </ScrollView>
  );
}

function Standings({ base, online }) {
  const [leagueId, setLeagueId] = useState('lg-1');
  const [data, setData] = useState(() => cacheGet('standings:lg-1'));
  const [error, setError] = useState(null);
  const load = async () => {
    setError(null);
    try {
      const d = await api(base, `/api/v1/standings/${encodeURIComponent(leagueId)}`);
      cachePut(`standings:${leagueId}`, d);
      setData({ data: d, updated_at: new Date().toISOString() });
    } catch (e) {
      const c = cacheGet(`standings:${leagueId}`);
      if (c) setData(c);
      setError(online ? e.message : 'Offline — showing cached table.');
    }
  };
  return (
    <ScrollView contentContainerStyle={s.pad}>
      <Field label="League ID" value={leagueId} onChangeText={setLeagueId} />
      <Button label="Load standings" onPress={load} />
      {error && <Text style={s.warn}>{error}</Text>}
      {data && (
        <Card title={`Table · ${data.data.league_id}`}>
          <Text style={s.muted}>Updated {new Date(data.updated_at).toLocaleString()}</Text>
          <View style={[s.row, s.rowHead]}>
            {['#', 'Team', 'P', 'W', 'D', 'L', 'Diff', 'Pts'].map((h) => <Text key={h} style={[s.cell, h === 'Team' && s.cellWide, s.bold]}>{h}</Text>)}
          </View>
          {data.data.table.map((r) => (
            <View key={r.team_id} style={s.row} accessible accessibilityLabel={`Rank ${r.rank}, ${r.team_id}, ${r.points} points, ${r.status.replace('_', ' ')}`}>
              <Text style={s.cell}>{r.rank}</Text>
              <Text style={[s.cell, s.cellWide]}>{r.team_id}{r.status === 'clinched' ? ' ✓' : r.status === 'eliminated' ? ' ✕' : ''}</Text>
              <Text style={s.cell}>{r.played}</Text><Text style={s.cell}>{r.won}</Text><Text style={s.cell}>{r.drawn}</Text>
              <Text style={s.cell}>{r.lost}</Text><Text style={s.cell}>{r.diff}</Text><Text style={[s.cell, s.bold]}>{r.points}</Text>
            </View>
          ))}
          <Text style={s.muted}>✓ clinched · ✕ eliminated</Text>
        </Card>
      )}
    </ScrollView>
  );
}

function Scoring({ base, token, online, onQueueChange }) {
  const [matchId, setMatchId] = useState('m1');
  const [teamId, setTeamId] = useState('t1');
  const [eventType, setEventType] = useState('goal');
  const [score, setScore] = useState(() => cacheGet('match:m1'));
  const [msg, setMsg] = useState(null);

  const refresh = async () => {
    try {
      const d = await api(base, `/api/v1/matches/${encodeURIComponent(matchId)}`);
      cachePut(`match:${matchId}`, d);
      setScore({ data: d, updated_at: new Date().toISOString() });
    } catch (e) { const c = cacheGet(`match:${matchId}`); if (c) setScore(c); setMsg(online ? e.message : 'Offline — showing cached score.'); }
  };
  const enqueue = (type, payload) => {
    const event = { event_id: `mob-${uid()}`, match_id: matchId, type, payload };
    db.runSync('INSERT INTO queue (action_id, type, payload, created_at) VALUES (?, ?, ?, ?)', `act-${uid()}`, 'event', JSON.stringify(event), new Date().toISOString());
    setMsg(`Queued ${type}${online ? '' : ' (offline — will sync later)'}`);
    onQueueChange();
  };
  return (
    <ScrollView contentContainerStyle={s.pad}>
      <Field label="Match ID" value={matchId} onChangeText={setMatchId} />
      <Button label="Refresh score" onPress={refresh} kind="ghost" />
      {score && (
        <Card title={`${score.data.home.team_id}  ${score.data.home.score} – ${score.data.away.score}  ${score.data.away.team_id}`}>
          <Text style={s.muted}>Status: {score.data.status.replace('_', ' ')} · v{score.data.version}</Text>
        </Card>
      )}
      <Card title="Record event">
        <Button label="Start match" onPress={() => enqueue('match_start', {})} kind="ghost" />
        <Field label="Team ID" value={teamId} onChangeText={setTeamId} />
        <Field label="Scoring event type" value={eventType} onChangeText={setEventType} />
        <Button label={`Add ${eventType} for ${teamId}`} onPress={() => enqueue('score', { team_id: teamId, event_type: eventType })} />
        <Button label="End match" onPress={() => enqueue('match_end', {})} kind="ghost" />
      </Card>
      {msg && <Text style={s.muted} accessibilityLiveRegion="polite">{msg}</Text>}
    </ScrollView>
  );
}

function SyncQueue({ items, syncing, onSync }) {
  return (
    <ScrollView contentContainerStyle={s.pad}>
      <Button label={syncing ? 'Syncing…' : 'Sync now'} onPress={onSync} disabled={syncing} />
      {items.length === 0 && <Text style={s.muted}>Nothing queued.</Text>}
      {items.map((q) => {
        const p = JSON.parse(q.payload);
        const r = q.result ? JSON.parse(q.result) : null;
        const color = q.status === 'applied' || q.status === 'duplicate' ? C.accent : q.status === 'pending' ? C.muted : C.warn;
        return (
          <Card key={q.action_id}>
            <Text style={s.text}>{p.type} · {p.match_id}</Text>
            <Text style={{ color }}>{q.status}{r?.error ? ` — ${r.error.code} (${r.resolution})` : ''}</Text>
          </Card>
        );
      })}
    </ScrollView>
  );
}

function Store({ base }) {
  const [variant, setVariant] = useState('var-jersey-001-L');
  const [code, setCode] = useState('');
  const [out, setOut] = useState(null);
  const buy = async () => {
    setOut(null);
    try {
      const o = await api(base, '/audit/v1/checkout', { method: 'POST', body: {
        order_id: `ord-${uid()}`, customer_id: 'mobile-user', items: [{ variant_id: variant, quantity: 1 }],
        discount_code: code.trim() || null, payment: { token: 'tok_success' } } });
      setOut({ ok: true, text: `Paid PKR ${(o.total_minor / 100).toFixed(2)} · order ${o.order_id}` });
    } catch (e) { setOut({ ok: false, text: e.message }); }
  };
  return (
    <ScrollView contentContainerStyle={s.pad}>
      <Card title="Home Jersey · PKR 4500.00">
        <Text style={s.label}>Size</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
          {['M', 'L'].map((sz) => (
            <Pressable key={sz} accessibilityRole="radio" accessibilityState={{ selected: variant.endsWith(sz) }} accessibilityLabel={`Size ${sz}`}
              onPress={() => setVariant(`var-jersey-001-${sz}`)} style={[s.chip, variant.endsWith(sz) && s.chipOn]}>
              <Text style={s.text}>{sz}</Text>
            </Pressable>
          ))}
        </View>
        <Field label="Discount code (optional)" value={code} onChangeText={setCode} placeholder="WELCOME10" />
        <Button label="Buy now" onPress={buy} />
        {out && <Text style={out.ok ? { color: C.accent } : s.error} accessibilityLiveRegion="polite">{out.text}</Text>}
      </Card>
    </ScrollView>
  );
}

// ---------- App shell ----------
const TABS = ['Standings', 'Scoring', 'Queue', 'Store'];

export default function App() {
  const [base, setBase] = useState('http://10.0.2.2:8080');
  const [session, setSession] = useState(null);
  const [tab, setTab] = useState('Standings');
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState(queueAll());
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    (async () => {
      const token = await SecureStore.getItemAsync('token');
      const raw = await SecureStore.getItemAsync('session');
      if (token && raw) setSession({ ...JSON.parse(raw), token });
    })();
    return NetInfo.addEventListener((st) => setOnline(!!st.isConnected));
  }, []);

  const sync = useCallback(async () => {
    if (!session) return;
    const pending = queueAll().filter((q) => q.status === 'pending');
    if (!pending.length) return;
    setSyncing(true);
    try {
      const res = await api(base, '/api/v1/offline-sync', { method: 'POST', token: session.token, body: {
        client_id: 'mobile', actions: pending.map((q) => ({ action_id: q.action_id, type: q.type, payload: JSON.parse(q.payload) })) } });
      for (const r of res.results) db.runSync('UPDATE queue SET status = ?, result = ? WHERE action_id = ?', r.status, JSON.stringify(r), r.action_id);
    } catch { /* stay queued; retried on reconnect */ }
    setQueue(queueAll());
    setSyncing(false);
  }, [base, session]);

  useEffect(() => { if (online) sync(); }, [online, sync]);

  const logout = async () => { await SecureStore.deleteItemAsync('token'); await SecureStore.deleteItemAsync('session'); setSession(null); };
  const pendingCount = queue.filter((q) => q.status === 'pending').length;

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" />
      {!online && <Text style={s.banner} accessibilityLiveRegion="polite">Offline — changes are saved and will sync automatically</Text>}
      {!session ? <Login base={base} setBase={setBase} onLogin={setSession} /> : (
        <>
          <View style={s.header}>
            <Text style={s.h2}>{ROLES.find((r) => r.key === session.role)?.label}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={logout} style={s.link}><Text style={s.muted}>Sign out</Text></Pressable>
          </View>
          <View style={{ flex: 1 }}>
            {tab === 'Standings' && <Standings base={base} online={online} />}
            {tab === 'Scoring' && <Scoring base={base} token={session.token} online={online} onQueueChange={() => { setQueue(queueAll()); if (online) sync(); }} />}
            {tab === 'Queue' && <SyncQueue items={queue} syncing={syncing} onSync={sync} />}
            {tab === 'Store' && <Store base={base} />}
          </View>
          <View style={s.tabbar} accessibilityRole="tablist">
            {TABS.map((t) => (
              <Pressable key={t} accessibilityRole="tab" accessibilityState={{ selected: tab === t }} accessibilityLabel={t === 'Queue' ? `Queue, ${pendingCount} pending` : t}
                onPress={() => setTab(t)} style={s.tab}>
                <Text style={[s.tabText, tab === t && { color: C.accent }]}>{t}{t === 'Queue' && pendingCount ? ` (${pendingCount})` : ''}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: 32 },
  pad: { padding: 16, paddingBottom: 40 },
  h1: { color: C.text, fontSize: 28, fontWeight: '700', marginBottom: 4 },
  h2: { color: C.text, fontSize: 18, fontWeight: '600' },
  text: { color: C.text, fontSize: 16 },
  muted: { color: C.muted, fontSize: 14, marginVertical: 6 },
  label: { color: C.muted, fontSize: 14, marginBottom: 6 },
  error: { color: C.danger, fontSize: 14, marginTop: 8 },
  warn: { color: C.warn, fontSize: 14, marginTop: 8 },
  input: { backgroundColor: C.card, color: C.text, borderRadius: 10, borderWidth: 1, borderColor: C.line, paddingHorizontal: 14, minHeight: 48, fontSize: 16 },
  btn: { backgroundColor: C.accent, minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginVertical: 6, paddingHorizontal: 16 },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.line },
  btnText: { color: '#052E16', fontSize: 16, fontWeight: '600' },
  card: { backgroundColor: C.card, borderRadius: 12, padding: 14, marginTop: 12 },
  cardTitle: { color: C.text, fontSize: 18, fontWeight: '600', marginBottom: 6 },
  row: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  rowHead: { borderBottomColor: C.muted },
  cell: { color: C.text, width: 34, fontSize: 14, textAlign: 'center' },
  cellWide: { flex: 1, textAlign: 'left' },
  bold: { fontWeight: '700' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 },
  link: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 8 },
  tabbar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.card },
  tab: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center' },
  tabText: { color: C.muted, fontSize: 14, fontWeight: '600' },
  chip: { minWidth: 48, minHeight: 48, borderRadius: 10, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  chipOn: { borderColor: C.accent, backgroundColor: '#14532D' },
  banner: { backgroundColor: C.warn, color: '#1C1917', textAlign: 'center', padding: 8, fontWeight: '600' },
});
