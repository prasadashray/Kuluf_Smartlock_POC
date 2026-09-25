# Architecture

```
 Physical TT ELOCK / simulator
        │  Airtel 4G  →  public IP:TCP_PORT  (only public port)
        ▼
 tcp-listener/server.js ── one Session per socket (tcp-listener/session.js)
        │   FrameDecoder (stream reassembly)  →  per-session ordered queue
        ▼
 services/protocol-handler.js ── decodePacket → decodeBody → log → dispatch
        │           │                 │                     │
        │   auth / register /   telemetry-service.js    command-service.js
        │   heartbeat / time    (locations, lock status, (0x8900 build, 0x0001 ack,
        │   sync / diagnostics   battery, alarms)          0x0900/0x55 correlation,
        │                                                   timeouts, waiters)
        ▼                         ▼                         ▼
 services/message-log.js ──► store (db/pg-store.js | db/memory-store.js) ──► PostgreSQL 16
        │                                                    ▲
        └─► logging/capture.js (JSONL, raw chunks + frames)  │
                                                  api/app.js (Express, 127.0.0.1)
                                                             ▲
                                                  dashboard (React/Vite/Leaflet, polling)
```

## Modules

| Path | Responsibility |
|---|---|
| `server/src/protocol/` | Pure codec library: bytes/BCD/time, escaping, XOR checksum, header, packet, stream frame decoder, JT/T808 bodies, 0x0200 location, TT e-lock business layer, CRC candidates. No I/O. Shared with the simulator. |
| `server/src/config/` | Environment-driven configuration with validation; every unverified protocol choice is a setting |
| `server/src/tcp-listener/` | TCP server, per-connection `Session` (ordered processing queue, serial counter, raw terminal ID echo), `SessionManager` (one session per device, duplicate replacement), offline sweep |
| `server/src/services/protocol-handler.js` | Frame entry point; identification (terminal ID → device row); auth/registration; heartbeat; routing to telemetry/commands; diagnostics request/response waiters; disconnect handling |
| `server/src/services/command-service.js` | Seal/Unseal/Clear alarm; business serial allocation; two-level correlation; timeouts; "success only on device reply" |
| `server/src/services/telemetry-service.js` | Location history, lock status/voltage/battery, alarm raise/clear reconciliation |
| `server/src/services/message-log.js` | Every RX/TX frame → DB + JSONL capture + console |
| `server/src/db/` | SQL migrations runner, PostgreSQL store, in-memory store (same interface) |
| `server/src/api/app.js` | REST API |
| `server/src/platform.js` | Wiring (used by `index.js` and tests) |
| `simulator/` | `SimulatedDevice` class (lock state machine per Appendix 1) + CLI + JSON scenarios |
| `dashboard/` | Minimal operator UI |
| `tools/ble/` | Read-only BLE diagnostics (Python/bleak) |
| `tools/e2e-api-check.mjs` | Scripted API walk-through for live runs |

## Key flows

**Inbound frame**: socket `data` → capture chunk → `FrameDecoder.push` → for each candidate frame, enqueue on the
session → `decodePacket` (unescape, checksum, header) → on failure: log `invalid_frame`, no ack → on success:
identify device, `decodeBody`, log `rx`, update `last_seen_at`, dispatch, resolve diagnostic waiters.

**Command**: API → `CommandService.execute` → validate (device online, authenticated, LockID + key known) →
`encodeLockOperation` → `encodeBusinessFrame` (business serial) → `0x8900` → register pending → write → status
`sent` → device `0x0001` (status `acknowledged`, or `rejected` if result ≠ 0) → device `0x0900`/`0x55` with the
same business serial → status `completed`, result code/label/outcome, device state updated → waiters resolved.
No reply within `COMMAND_TIMEOUT_S` → `timeout`.

**Alarms**: sources `location_alarm_flags` (Table 24), `e7_alarm_status` (0xE7), `lock_status` (LockStatus 7x/8x/Ax),
`voltage` (0x30/0x31), `lock_upload` (SubCmd 02–05). For state-like sources the set of active alarms is reconciled
on each report (new → raise row; gone → `cleared_at`, `cleared_by=device_report`). Event-like `lock_upload`
alarms are cleared by a successful Clear alarm command.

## Data model

`devices` (identity, auth, key, live status, battery), `sessions` (one row per TCP connection), `message_log`
(append-only raw frames), `commands` (full lifecycle incl. TX/RX hex and correlation), `locations` (append-only),
`alarms` (history with raise/clear). See `server/migrations/001_initial_schema.sql`.

## Configuration

`.env.example` documents every variable. Unverified protocol points: `BIZ_LEN_MODE`, `BIZ_CRC_ALGO`,
`BIZ_CRC_RANGE`, `BIZ_CRC_ENFORCE`, `BIZ_REPLY_TO_LOCK_UPLOAD`, `DEVICE_TZ_OFFSET_MINUTES`, `DEFAULT_KEY_FORMAT`,
`TIME_SYNC_ON_AUTH`, `AUTH_MODE`.

## Deliberately out of scope (POC)

User accounts/roles, TLS termination, multi-tenancy, queues between listener and services, horizontal scaling,
mobile apps, analytics, GBK encoding of non-ASCII outbound strings, sub-packet reassembly, IC-card / binding
commands (§10.2.2).
