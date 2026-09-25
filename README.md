# IndiaLock Connect — POC (Phase 1)

Platform that talks to the physical TT ELOCK over the TT808ELOCK protocol (JT/T808-2013 + TT A13 e-lock
extension): TCP listener, protocol library, command/telemetry services, PostgreSQL, REST API, minimal dashboard,
and a device simulator built on the same protocol library.

**Status (2026-09-26):** protocol, simulator, server, API and dashboard are implemented and pass 103 automated tests
(including PostgreSQL end-to-end) plus a live simulated run. The physical lock has been identified over BLE (LockID
82637294 confirmed), but it has **not yet connected to this server** — that needs the cloud VM
(`docs/DEPLOYMENT.md`) and the vendor's method for setting the lock's server address (`docs/VENDOR_QUESTIONS.md`).
The POC is not complete until the hardware acceptance tests pass.

## Layout

```
server/        protocol library, TCP listener, services, REST API, migrations, tests
simulator/     simulate-device.js (CLI), device.js (SimulatedDevice), scenarios/
dashboard/     React + Vite + Leaflet operator UI
tools/         ble/ (read-only BLE diagnostics), e2e-api-check.mjs
docs/          discovery, architecture, protocol notes, hardware validation, test plan/results, decisions, troubleshooting
Technical Docs/  TDD + TT808ELOCK protocol (EN translation + CN original)
```

## Quick start (Windows, PowerShell)

```powershell
npm install                          # installs server + dashboard workspaces
Copy-Item .env.example .env          # then set POSTGRES_PASSWORD and DATABASE_URL
docker compose up -d db              # PostgreSQL 16 on 127.0.0.1:5433 (project "kuluf-smartlock-poc")
npm run migrate
npm run server                       # TCP :6808 (devices), API http://127.0.0.1:3000/api
npm run dashboard                    # http://localhost:5173 (proxies /api)
npm run simulator -- --verbose       # simulated lock 000082637294 / 82637294
```

No database? `DB_ENABLED=false` runs capture-only with an in-memory store; every raw chunk and frame still goes to
`captures/traffic.jsonl`.

Tests: `npm test` (unit + integration, no Docker needed) · `npm run test:e2e --workspace server` (needs the db).

## Operating a device

```powershell
# list / status
curl http://127.0.0.1:3000/api/devices
curl http://127.0.0.1:3000/api/devices/82637294/status        # id, terminal ID or LockID accepted
# platform-side configuration (LockID is learned from 0x0900 or set here; the key is never guessed)
curl -X PATCH http://127.0.0.1:3000/api/devices/82637294 -H "content-type: application/json" -d '{"lock_id":"82637294","key_format":"rf10"}'
# commands (?wait=true blocks until the lock's operation reply or timeout)
curl -X POST "http://127.0.0.1:3000/api/devices/82637294/seal?wait=true"   -H "content-type: application/json" -d '{"key":"1234567890"}'
curl -X POST "http://127.0.0.1:3000/api/devices/82637294/unseal?wait=true"
curl -X POST "http://127.0.0.1:3000/api/devices/82637294/clear-alarm?wait=true"
# read-only diagnostics
curl -X POST http://127.0.0.1:3000/api/devices/82637294/diagnostics/query-params
```

A command is reported `succeeded: true` only when the lock's 0x55 operation reply carries the success code
(0x80 / 0x90 / 0x70). Statuses: `pending → sent → acknowledged → completed | rejected | timeout | send_failed`.

### API

| Method | Path |
|---|---|
| GET | `/api/health`, `/api/sessions`, `/api/devices`, `/api/devices/:id`, `/api/devices/:id/status` |
| GET | `/api/devices/:id/{locations,alarms,commands,messages,events,sessions}` (`?limit=`, alarms `?active=true`, messages `?direction=rx|tx`) |
| PATCH | `/api/devices/:id` — `lock_id`, `current_key`, `key_format`, `display_name` |
| POST | `/api/devices/:id/{seal,unseal,clear-alarm}` — body `key?`, `keyFormat?`, `bill?`, `lineCode?`, `gate?`; `?wait=true` |
| POST | `/api/devices/:id/diagnostics/{query-params,query-location,time-sync,text}` |
| GET | `/api/commands/:commandId`, `/api/messages/unattributed` |

## Simulator

```powershell
node simulator/simulate-device.js --help
node simulator/simulate-device.js --simulate-sealed --key 1234567890 --scenario tamper --verbose
```
Flags include `--host --port --device-id --lock-id --auth-code --register --heartbeat --location-interval
--lock-upload-interval --simulate-sealed --simulate-unsealed --simulate-low-battery --simulate-tamper
--simulate-location --no-reply --scenario --exit-after`.

## Key documents

- `docs/PROJECT_DISCOVERY.md` — what was found (documents, environment, BLE hardware evidence)
- `docs/PROTOCOL_NOTES.md` — byte-level protocol as implemented, with CONFIRMED / INFERRED / UNKNOWN labels
- `docs/HARDWARE_VALIDATION.md` — device facts, hardware test matrix, records, discrepancy log
- `docs/VENDOR_REFERENCE.md` — vendor Gitee (gps51) investigation; `docs/VENDOR_QUESTIONS.md` / `docs/VENDOR_QUESTIONS.docx` — questions for the vendor, bilingual EN/中文 (the .docx is a fillable form to send)
- `docs/DEPLOYMENT.md` — cloud VM deployment
- `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `docs/TEST_PLAN.md`, `docs/TEST_RESULTS.md`, `docs/TROUBLESHOOTING.md`

## Security notes (POC)

The protocol is unencrypted. Expose only the device TCP port; the API binds to 127.0.0.1 (optional
`API_TOKEN`). Seal keys are stored in clear in the database for the POC. `.env` and `captures/` are git-ignored.
