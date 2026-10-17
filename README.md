# NaSCon '26 — Multi-Sport League & Club Operations Platform (Phase I)

## Run
```sh
DAY1_SALT=<team-salt> docker compose up -d --build
curl http://localhost:8080/health   # {"status":"ok"}
```
The API is a dependency-free Node.js 20 service (`backend/src`). Baseline data is seeded on startup and on `POST /audit/v1/reset`.
`DAY1_SALT` is read only from the environment.

## Layout
- `backend/src/core.js` — canonical JSON, HMAC signatures, validation helpers
- `backend/src/fixtures.js` — round robin (circle method), Swiss (branch & bound min-cost pairing, Buchholz), single & double elimination
- `backend/src/league.js` — sports-as-data, event-sourced scoring with compensations, standings & tie-breakers
- `backend/src/ops.js` — roster/transfer/loan/audit, concurrency-safe checkout + mock gateway + PDF receipts, JWT + RBAC policy-as-code
- `backend/src/server.js` — HTTP routing, `/audit/v1/*`, `/api/v1/*` (rate limited 100 req / 10 s / IP), SSE stream `/api/v1/stream`

## Tests
`./run_tests.sh` (unit tests + end-to-end smoke test).

## Demo accounts (Section 8.3)
JWTs for all five roles are issued by `POST /audit/v1/rbac-matrix`:

| Role | Principal | Scope |
|---|---|---|
| Platform Super-Admin | user-super | platform-wide |
| League Organizer | user-organizer | tenant-alpha / league-alpha-1 |
| Club Manager | user-clubmgr | tenant-alpha / club-alpha-1 |
| Player | user-player | player-alpha-1 |
| General Viewer | user-viewer | tenant-alpha read-only |

## Known limitations
State is held in-process memory (the single Node event loop serialises checkout reservation, giving zero overselling). 



## Mobile (React Native / Expo)
Source in `mobile/` (`App.js`). Sign in as any of the five demo roles, browse standings and match scores cached in SQLite, record scoring events offline (queued in SQLite and auto-synced through `POST /api/v1/offline-sync` when connectivity returns; per-action conflict results are shown in the Queue tab), and buy merchandise. Tokens are stored with expo-secure-store (Android Keystore). Default server `http://10.0.2.2:8080` (emulator → host), editable on the sign-in screen.

Build: `cd mobile && npm install && npx expo prebuild -p android && cd android && ./gradlew assembleRelease`, then copy the APK to `mobile/release/app-release.apk`.
