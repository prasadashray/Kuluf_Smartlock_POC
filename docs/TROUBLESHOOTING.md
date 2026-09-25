# Troubleshooting

## Device never connects
1. Is the listener reachable from outside? From a phone on mobile data (Wi-Fi off), a TCP port checker, or
   `Test-NetConnection <public-ip> -Port 6808` from another network. Home broadband may be behind CGNAT.
2. Windows Firewall: allow inbound TCP on `TCP_PORT` for node.exe (Private/Public as appropriate).
3. Router: forward `TCP_PORT` to this PC, or use a cloud VM / tunnel.
4. Device side: server address (param 0x0013), port (0x0018), APN (0x0010) must point to us; SIM must have data.
5. Look at `captures/traffic.jsonl` — if there are `chunk` records but no `frame` records, the device is sending
   something that is not 0x7E-framed JT/T808 (record it as a discrepancy).

## Frames logged as `invalid_frame`
- `BAD_CHECKSUM`: compare `unescaped_hex` with the XOR rule; check whether the device checksums different bytes.
- `BAD_ESCAPE`: device may not escape, or escapes differently — capture and record a discrepancy.
- `TOO_SHORT`: partial data or a keep-alive byte pattern.
Invalid frames are never acknowledged; the device will retransmit.

## Device authenticates but commands fail
| Symptom | Likely cause | Check |
|---|---|---|
| API 409 `LOCK_ID_UNKNOWN` | no 0x0900 seen yet | `PATCH /api/devices/:id {"lock_id":"82637294"}` |
| API 409 `KEY_UNKNOWN` | no key given/stored | pass `{"key": "..."}` or PATCH `current_key` |
| API 409 `NOT_AUTHENTICATED` | device connected in sleep mode without 0x0102 | wait for auth, or set `REQUIRE_AUTH_FOR_COMMANDS=false` deliberately |
| command `rejected`, ack `message_error` | device could not parse our business frame | business LEN/CRC config (see below) |
| command `timeout` with ack `success` | device accepted the JT/T808 frame but produced no 0x55 | LEN/CRC wrong, wrong LockID, or lock asleep; inspect server log |
| 0x93 wrong key | key/key format | `key_format` rf10 vs ascii6; the OpIdent in the reply shows the password the lock saw |

## Business frame LEN / CRC (DOC-06 / DOC-07)
Every uplink 0x0900 produces a log line:
```
business frame evidence terminal=... len=0x.. lenMatches=[...] crc=0x.. crcMatches=[...] configured=... valid=...
```
Set `BIZ_LEN_MODE` to the value in `lenMatches` and `BIZ_CRC_ALGO`/`BIZ_CRC_RANGE` to the value in `crcMatches`,
restart, then set `BIZ_CRC_ENFORCE=true`. If nothing matches, capture several frames and run the candidate search in
`tools/ble/crc_hunt.py` over the business bytes; record a discrepancy.

## Device shows offline while connected
`DEVICE_OFFLINE_TIMEOUT_S` shorter than the device's heartbeat/report interval. Read the interval with
`POST /api/devices/:id/diagnostics/query-params` (param 0x0001) and set the timeout to ≥ 3× that.

## Times look 8 hours (or 2.5 hours) off
Device BCD times are converted with `DEVICE_TZ_OFFSET_MINUTES` (default 480 = GMT+8). Raw values are kept in
`device_time_raw` and in `reply_parsed`.

## Database
- `ECONNREFUSED 127.0.0.1:5433`: `docker compose up -d db` (project `kuluf-smartlock-poc`).
- Port 5432 is a separate native PostgreSQL service on this PC; this project does not use it.
- Capture-only operation without a database: `DB_ENABLED=false npm run server`.

## Tests hang
Run with `npm test` (uses `--test-timeout` and `--test-force-exit`). Integration tests use random ports and an
in-memory store; they do not need Docker.
