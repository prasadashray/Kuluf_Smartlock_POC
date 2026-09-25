# Decisions Log

Format: context → decision → consequence. "Revisit" = expected to change once hardware evidence exists.

| ID | Decision | Why | Revisit |
|---|---|---|---|
| D-01 | Keep the TDD stack: Node.js 24 (ESM), Express 5, PostgreSQL 16, React + Vite + Leaflet, Docker Compose | Environment already has Node 24, Docker, Postgres; no reason found to change | — |
| D-02 | Implement the §10.1 business envelope (LEN, `*`/`#`, business serial, CRC) even though the TDD omits it (DOC-01) | Protocol is authoritative for byte-level behaviour; without it the device cannot parse our commands | — |
| D-03 | Treat the 2nd byte of the 0x55 reply as the result code (DOC-02) | Appendix 1 lists device reply command words 0x80…; CN example `55 97` | — |
| D-04 | Follow the Chinese original where EN and CN differ (Key 4B, Seal example, bit2 "shell removed") | CN is the vendor original; examples are self-consistent only in CN | — |
| D-05 | LEN mode and CRC algorithm are configuration with defaults `after_len` + `crc8_maxim/from_len`; decoder records which candidates match; CRC not enforced | Not specified (DOC-06/07). CRC-8/MAXIM is what the same device uses on BLE (H-06) | **Yes** — first real 0x0900 |
| D-06 | Do not send the 0x61 business reply to lock uploads by default (DOC-11) | Table says "center business reply: none"; JT/T808 0x8001 is always sent | Yes — watch for retransmissions |
| D-07 | No automatic retransmission of Seal/Unseal/Clear alarm; configurable timeout (default 60 s) → status `timeout` | A physical actuation must not be repeated blindly; repeat seal/unseal have their own result codes | Maybe |
| D-08 | A command is `succeeded` only when status `completed` and the result code's outcome is `success`. 0x0001 ack = delivery only | Master instructions §35 | — |
| D-09 | Correlate replies by business serial; fallback to oldest open command of the same type (recorded as `heuristic_oldest_pending`); late replies after timeout are still attached (`late_business_serial`) | Evidence preservation; device may not echo serial | Yes |
| D-10 | Store all times in UTC; device BCD times converted with `DEVICE_TZ_OFFSET_MINUTES` (default 480); raw BCD kept | Protocol states GMT+8; BLE evidence agrees (H-07); India is +5:30 so the offset must be explicit (DOC-09) | Confirm on TCP |
| D-11 | Send 0x8103/0x002A time calibration 500 ms after successful auth (configurable) | Highlighted protocol note; the TDD omitted it (DOC-10) | Disable if the device rejects it |
| D-12 | `AUTH_MODE=accept_all` by default: accept and record any 0x0102 code | Factory code is ICCID+version, unknown in advance; do not invent codes | Switch to `known_devices` after first capture |
| D-13 | On 0x0100 issue a random code `IL` + 10 hex (stored per device) | Protocol requires a code; do not hard-code one | — |
| D-14 | Accept and store data from unauthenticated sessions; refuse commands to them | Sleep mode sends data without 0x0102 (§8.8 note 2) | — |
| D-15 | Invalid frames (escape/checksum/short) are logged with raw bytes and **not acknowledged** | Never silently accept; acknowledging corrupted data would make the device drop it | — |
| D-16 | Unknown message IDs: log + 0x8001 result 3 | JT/T808 expects a response; "not supported" is truthful | — |
| D-17 | LockID is never guessed from the terminal ID; it is learned from 0x0900 or set by the operator (PATCH) | The displayed ID's relationship to the terminal ID is unknown (earlier POC guessed it) | — |
| D-18 | Seal key is required explicitly (request body or stored); never generated | "Do not invent a key"; the platform-chosen seal key must be deliberate | — |
| D-19 | Key stored in clear in `devices.current_key` and command params (masked in API output); raw TX hex contains it anyway | POC simplicity; key-management policy is a production item (TDD §12.3) | Production |
| D-20 | Separate compose project name `kuluf-smartlock-poc`; Postgres on host port 5433 bound to 127.0.0.1 | A native Postgres uses 5432; another project named `indialock-connect-poc` exists on this machine | — |
| D-21 | In-memory store (same interface) for tests and `DB_ENABLED=false` capture-only mode; JSONL capture file independent of DB | First hardware packets must be preserved even if the DB is down | — |
| D-22 | `message_log` and `locations` append-only enforced by DB triggers; alarms keep history (rows marked cleared, never deleted) | Auditability | — |
| D-23 | REST API binds to 127.0.0.1 by default, optional bearer token; only the device TCP port is meant to be public | Protocol has no encryption; POC has no user auth | Production |
| D-24 | Dashboard uses polling (2–5 s) and plain Leaflet | TDD §8: polling is sufficient; fewer dependencies | — |
| D-25 | BLE used only for read-only diagnostics; nothing is written to the lock over BLE | BLE command protocol is undocumented (U-12) | If vendor supplies BLE docs |
| D-27 | Keep the direct TT808ELOCK TCP path as primary after reviewing the vendor Gitee reference; no architecture change | Vendor API documents only tracker functions and relay "lock car" commands, no e-lock seal/unseal or result codes (`docs/VENDOR_REFERENCE.md`) | After vendor answers C1–C4 |
| D-28 | Type-based reply correlation fallback only for replies with cmdSRC = platform (0x04) | Keypad/RF/IC-card operations produce unsolicited 0x55 replies that must not complete our commands | — |
| D-29 | Public endpoint = cloud VM with static IP (user decision 2026-09-26); only TCP 6808 public, API/dashboard via SSH tunnel | Stable address to configure in the lock | — |
| D-30 | First hardware lock tests: keypad operation capture → remote Unseal → only then remote Seal, and only once a recovery path is known | Avoid a lock stuck sealed by an unverified key encoding (`HARDWARE_VALIDATION.md` §2) | — |
| D-26 | Earlier POC at `Desktop\SSLockPOC\indialock-connect-poc` not reused | Simulator-only; its LockID encoding, UTC time handling and missing business envelope contradict the protocol / BLE evidence | — |
