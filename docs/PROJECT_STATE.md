# Project State

Snapshot date: 2026-09-26. Verify against the repository (`docs/AGENT_START_HERE.md` §13).
Labels: CONFIRMED / INFERRED / UNKNOWN / HARDWARE-SPECIFIC / REQUIRES VENDOR CONFIRMATION / REQUIRES HARDWARE TEST.

## Project name
IndiaLock Connect POC (repo folder `Kuluf_Smartlock_POC`; vendor-facing brand "SmartSkale").

## Current objective
Prove reliable communication with, and remote control of, a **physical TT ELOCK** over the TT808ELOCK protocol
(JT/T808-2013 + TT A13 e-lock extension). This is Phase 1 (POC).

## Current phase
Phase A–C complete (protocol, simulator, full local end-to-end). **Phase D–F blocked**: preparing the public endpoint
and getting the physical device to connect. No physical TCP session yet. BLE read-only investigation done.

## What has been completed (CONFIRMED unless noted)
- Full TT808ELOCK protocol library with tests (72 unit tests pass).
- Device simulator sharing the protocol library, with CLI flags and JSON scenarios.
- TCP listener with stream reassembly, per-connection sessions, duplicate-connection handling, offline sweep.
- Services: protocol handler (auth/register/heartbeat/time-sync/location/passthrough/diagnostics), command service
  (two-level correlation, timeouts, "success only on device reply"), telemetry/alarm service.
- PostgreSQL schema + migration runner; PgStore and an interchangeable in-memory store.
- REST API (Express) and a React/Vite/Leaflet dashboard (builds).
- Raw traffic capture (JSONL) + DB message log.
- BLE read-only tools; live BLE status monitor validated against the physical lock.
- Docs incl. discovery, protocol notes, hardware validation, decisions, vendor reference + bilingual vendor questions
  (`.md` and `.docx`), deployment guide.

## What is currently working (CONFIRMED by tests/live runs)
- 99 unit+integration tests pass; 4 PostgreSQL e2e tests pass (2026-09-26).
- Live simulated run: connect → auth (ICCID+version) → time sync → heartbeat → location history → Seal 0x80 →
  Unseal wrong-key 0x93 → Unseal 0x90 → Clear-alarm → diagnostics, all persisted; zero checksum failures.
- BLE monitor decodes the physical lock's status and keypad-unlock events correctly.

## What is partially working
- **Dashboard**: builds and is served by Vite; `/api` proxy verified with curl; **not visually verified in a browser**
  (INFERRED-correct, REQUIRES manual check).
- **Docker full stack**: images build; only `db` has been run. `server`/`dashboard`/`simulator` containers not yet run.

## What is not working / not done
- **Physical device over TCP**: never connected (no network path). REQUIRES HARDWARE TEST.
- **Remote Seal/Unseal on the physical lock**: never attempted. REQUIRES HARDWARE TEST + vendor answers.
- **Business LEN/CRC and Key encoding on real hardware**: UNKNOWN (see PROTOCOL_NOTES §4).

## Current architecture
Direct TCP: `Lock ─TCP─► listener → protocol lib → command/telemetry services → PostgreSQL → REST API → dashboard`.
Capture file + DB message log on the side. See `docs/ARCHITECTURE.md`. Vendor-API path evaluated and rejected as
primary (`docs/VENDOR_REFERENCE.md`, DECISIONS D-27).

## Current technology stack
Node.js 24 (ESM), Express 5, PostgreSQL 16 (Docker), `pg`; tests via Node built-in `node:test`; React 19 + Vite 7 +
Leaflet 1.9; Docker Compose; BLE tools in Python 3 + bleak. No test framework or dotenv dependency.

## Current repository structure (files that matter)
```
server/src/protocol/   codec: bytes, escape, checksum, crc, header, packet, frame-decoder, location, tt-elock, messages, index
server/src/config/     env-driven config (all unverified protocol choices live here)
server/src/tcp-listener/  server.js, session.js, session-manager.js
server/src/services/   protocol-handler, command-service, telemetry-service, message-log, errors
server/src/db/         migrate.js, pg-store.js, memory-store.js
server/src/api/app.js  REST API
server/src/platform.js wiring (used by index.js and tests)
server/migrations/001_initial_schema.sql
server/tests/          unit/*, integration/simulator-flow.test.js, e2e/postgres.test.js, helpers.js
simulator/             device.js, simulate-device.js, scenarios/*.json
dashboard/             React app + Dockerfile + nginx.conf
tools/ble/             ble_scan/gatt/listen/monitor/crc_hunt (read-only)
tools/e2e-api-check.mjs
docs/                  (this handoff set + discovery/architecture/protocol/hardware/vendor/deployment/test docs)
Technical Docs/        TDD + TT808ELOCK EN + CN(A13) PDFs
docker-compose.yml, .env.example, README.md
```

## Current database state/schema
PostgreSQL 16 in Docker container `kuluf-smartlock-poc-db-1`, host `127.0.0.1:5433`, db/user `indialock`. Migration
`001_initial_schema.sql` applied. Tables: `devices`, `sessions`, `message_log` (append-only), `commands`, `locations`
(append-only), `alarms` (history), `schema_migrations`. No real-device rows; only test data from runs.

## Current protocol implementation state
All POC message types implemented and unit-tested: 0x0001/0x8001, 0x0002, 0x0100/0x8100, 0x0102, 0x0200, 0x0201,
0x0104/0x8103/0x8104, 0x0900/0x8900 (TT e-lock business layer), text. Lock ops Seal 0x32 / Unseal 0x38 / Clear-alarm
0x42, result codes, LockStatus, voltage, operation identifier, lock upload. **UNKNOWN**: business LEN mode, business
CRC algorithm, this lock's Key encoding — all configurable, defaults are best guesses (PROTOCOL_NOTES §4).

## Current simulator state
CONFIRMED working. Lock state machine per Appendix 1; supports register/auth/heartbeat/location/lock-upload/seal/
unseal/clear-alarm/keypad-operation, scenarios, and flags (`--help`).

## Current TCP server/listener state
CONFIRMED working. Handles fragmentation, coalescing, garbage, bad checksum/escape, duplicate connections, heartbeat
timeout → offline. Binds `TCP_PORT` (default 6808).

## Current API state
CONFIRMED working. Endpoints for devices/status/locations/alarms/commands/messages/events/sessions, PATCH device,
seal/unseal/clear-alarm (`?wait=true`), diagnostics, health. Binds `127.0.0.1:3000` by default; optional bearer token.

## Current UI state
React dashboard: device list, detail (status/battery/lock/alarms), Leaflet map, event feed, raw protocol log, command
buttons, diagnostics, device config. Builds; not browser-verified.

## Current physical hardware integration state
HARDWARE-SPECIFIC / REQUIRES HARDWARE TEST. Lock present; identified over BLE (LockID 82637294, firmware
79A-EN-V146_2625 / 78A-V5.1 7AVT1, physically locked, keypad password 00000000). Read-only BLE monitoring works. No
TCP session, no commands sent to the device. See `docs/HARDWARE_VALIDATION.md`.

## Current environment/configuration requirements
Node ≥ 22 (have 24.18), Docker (have Desktop 29.7), PostgreSQL via Docker on 5433. `.env` from `.env.example`
(local `.env` exists with a generated `POSTGRES_PASSWORD`; **git-ignored, not in the repo**). Config reference:
`.env.example` and `server/src/config/index.js`.

## Current test status
Unit+integration: **99/99 pass**. PostgreSQL e2e: **4/4 pass** (needs the db container). See `docs/TEST_RESULTS.md`.

## Current blockers
1. No public endpoint (cloud VM pending) — `docs/DEPLOYMENT.md`.
2. No known way to point the lock at our server — vendor questions A1–A5.

## Important files and their purposes
- `server/src/protocol/tt-elock.js` — TT e-lock business layer incl. the LEN/CRC candidate machinery (DOC-06/07).
- `server/src/protocol/messages.js` — JT/T808 message bodies + dispatcher.
- `server/src/services/command-service.js` — command lifecycle and reply correlation.
- `server/src/services/protocol-handler.js` — inbound frame dispatch, auth, diagnostics.
- `server/src/config/index.js` — every tunable, including the unverified protocol switches.
- `simulator/device.js` — simulated lock behaviour.
- `tools/ble/ble_monitor.py` — read-only live BLE status monitor.
- `docs/HARDWARE_VALIDATION.md` — hardware facts, test matrix, safe test order, evidence.
- `docs/VENDOR_QUESTIONS.md` / `.docx` — what we need from the vendor.
