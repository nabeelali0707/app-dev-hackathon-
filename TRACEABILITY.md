# Traceability

| ID | Source | Tests |
|---|---|---|
| FR-1.1 | backend/src/league.js (SEED_SPORTS, createSport, appendEvent, project, scoreView) | tests/smoke.js (events, compensation, score); tests/unit.test.js (signature) |
| FR-1.2 | backend/src/league.js (createLeague) | tests/smoke.js (league) |
| FR-1.3 | backend/src/fixtures.js (roundRobin, swiss, singleElim, doubleElim) | tests/unit.test.js (round robin, swiss, seed order, elim) |
| FR-1.4 | backend/src/league.js (standings) | tests/smoke.js (standings) |
| FR-2.1 | backend/src/server.js (tenant/club/player entities in reset) | tests/unit.test.js (rbac negative boundaries) |
| FR-2.2 | backend/src/ops.js (rosterSetup, rosterTransfer, rosterHistory) | tests/smoke.js (loan, auto-return, MIN_POSITION_VIOLATION) |
| FR-2.3 | backend/src/ops.js (checkout, inventory, buildPdf) | tests/smoke.js (20-request burst, PDF) |
| FR-5.1 | backend/src/ops.js (POLICY, probe, jwtSign, jwtVerify) | tests/unit.test.js (jwt, rbac); tests/smoke.js (probe matrix) |
| NFR-3 | backend/src/ops.js (checkout synchronous reserve/commit/release) | tests/smoke.js (burst) |
| NFR-4 | backend/src/server.js (offlineSync); mobile/App.js (SQLite cache + action queue, NetInfo auto-sync, conflict display) | tests/smoke.js |
| NFR-5 | mobile/App.js (tokens in expo-secure-store / Android Keystore); backend/src/server.js (rate limiter, 413, validation), backend/src/ops.js (JWT verification) | tests/unit.test.js (jwt) |
| NFR-7 | docker-compose.yml, backend/Dockerfile | — |
