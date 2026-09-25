# Next Steps — ordered execution plan

Priorities: **P0** must do first · **P1** next · **P2** after · **P3** later. Verify current state first
(`docs/AGENT_START_HERE.md` §13). Most P0/P1 items depend on external inputs (vendor, cloud VM) the agent cannot supply.

---

## P0 — Unblock the physical connection

### P0.1 Confirm/obtain the public endpoint (cloud VM)
- **Objective:** a static public IP with TCP 6808 reachable from the Airtel mobile network.
- **Why:** the lock cannot reach us behind home NAT; nothing physical proceeds without it.
- **Files:** `docs/DEPLOYMENT.md`, `docker-compose.yml`, `.env.example`.
- **Expected result:** server reachable at `<vm-ip>:6808` from outside.
- **Verification:** from a phone on mobile data or an external host, `Test-NetConnection <vm-ip> -Port 6808`, then a
  simulator run `node simulator/simulate-device.js --host <vm-ip> --port 6808 --device-id 000099990001 --lock-id 99990001 --exit-after 20` shows up via the API.
- **Blockers:** user must provision the VM (or give SSH access to deploy).

### P0.2 Get vendor answers for pointing the lock at our server
- **Objective:** the exact method to set the lock's server IP/port/APN, and the recovery method if remote unseal fails.
- **Why:** without it the lock keeps talking to its current server, not ours.
- **Files:** `docs/VENDOR_QUESTIONS.md` / `.docx` (A1–A5), `docs/HARDWARE_VALIDATION.md` §3.
- **Expected result:** documented method (SMS / app / tool / vendor-remote) + current config values + open-if-failed path.
- **Verification:** answers recorded in the vendor form; A5 (recovery) answered before any remote seal.
- **Blockers:** user/vendor.

## P1 — First real connection (once P0 done)

### P1.1 Deploy to the VM and connect the lock, capture read-only
- **Objective:** the physical lock connects; capture the first real frames without sending anything.
- **Why:** first ground-truth of terminal ID, auth code, heartbeat, 0x0200, and (if any) 0x0900.
- **Files:** `docs/DEPLOYMENT.md`, `captures/traffic.jsonl`, API `/devices/:id/messages`.
- **Expected result:** a device row appears; message log fills; no commands sent.
- **Verification:** `GET /api/devices`, inspect `captures/traffic.jsonl`; server log shows auth/heartbeat.
- **Dependencies:** P0.1, P0.2.

### P1.2 Read back and record the device's original configuration
- **Objective:** capture original server/APN/heartbeat params before changing anything.
- **Why:** must be able to restore the device; preserves evidence (master rule).
- **Files:** API `POST /api/devices/:id/diagnostics/query-params`; record in `docs/HARDWARE_VALIDATION.md` §6.
- **Expected result:** decoded 0x0104 parameter list stored.
- **Verification:** parameters visible in the API response and written to the doc.
- **Dependencies:** P1.1 (device online and authenticated).

### P1.3 Resolve business LEN / CRC from the first real 0x0900 (DOC-06/07)
- **Objective:** confirm the business-frame LEN interpretation and CRC algorithm on real hardware.
- **Why:** Seal/Unseal will be rejected if these are wrong.
- **Files:** `server/src/protocol/tt-elock.js` (decoder records `lenInterpretations`/`crcMatches`), `server/src/config/index.js`.
- **Expected result:** a matching LEN mode and CRC algo identified from the "business frame evidence" log lines.
- **Verification:** set `BIZ_LEN_MODE`/`BIZ_CRC_ALGO`/`BIZ_CRC_RANGE` accordingly, then `BIZ_CRC_ENFORCE=true`; frames validate.
- **Dependencies:** a real 0x0900 (a keypad operation while online is the easiest source — see HARDWARE_VALIDATION TEST-HW-021).

## P2 — Physical lock control (safe order; requires user go-ahead)

### P2.1 Learn the Key encoding without commanding the lock
- **Objective:** determine how the 8-digit keypad password maps to the 6-byte protocol Key.
- **Why:** Unseal needs the right key encoding, or the lock answers 0x93.
- **Files:** `docs/HARDWARE_VALIDATION.md` §2, `server/src/protocol/tt-elock.js` (`encodeKey`), config `DEFAULT_KEY_FORMAT`.
- **Expected result:** the operation identifier in a keypad-operation 0x55 shows the 6 bytes the lock uses for the password.
- **Verification:** compare captured operation-identifier bytes with `rf10` vs `ascii6` encodings of the password.
- **Dependencies:** P1.1; user operates the keypad while online.

### P2.2 Remote Unseal of the locally-sealed lock
- **Objective:** first remote command; the lock is currently locally sealed, so unseal is the low-risk first action.
- **Why:** a failed unseal is harmless (lock stays locked, keypad still works); a failed seal is not.
- **Files:** API `POST /devices/:id/unseal?wait=true`, `docs/HARDWARE_VALIDATION.md` §"Safe order", TEST-HW-009.
- **Expected result:** 0x90 unseal success, or a decoded failure code we can act on.
- **Verification:** API result + physical lock opens; record TX/RX in the hardware doc §6/§8.
- **Dependencies:** P0.2 (A5 recovery known), P1.3, P2.1, **explicit user go-ahead**.

### P2.3 Remote Seal then Unseal round-trip
- **Objective:** prove full remote control.
- **Why:** core POC acceptance criterion.
- **Files:** API seal/unseal, `docs/HARDWARE_VALIDATION.md` TEST-HW-008/009.
- **Expected result:** Seal 0x80 → physical seal → Unseal 0x90 → physical open, with correct DB records.
- **Verification:** result codes + physical state + `commands`/`message_log` rows.
- **Dependencies:** P2.2 succeeded; a key we can also recover by other means; user go-ahead.

### P2.4 Telemetry, alarms, reconnect against hardware
- **Objective:** validate 0x0200 location, battery, tamper/alarm, reconnect, duplicate-connection on the real device.
- **Files:** `docs/HARDWARE_VALIDATION.md` TEST-HW-006/007/011/012/013/016.
- **Expected result:** decoded values match reality; alarms raised/cleared correctly.
- **Verification:** dashboard + API + DB vs observed device behaviour.
- **Dependencies:** P1.1.

## P3 — Hardening & polish

- **P3.1** Visually verify the dashboard in a browser; fix any rendering issues. (`npm run dashboard`)
- **P3.2** Run the full Docker stack (`docker compose --profile full up`) and confirm server+dashboard+db together.
- **P3.3** Decide on the vendor-API path only if the vendor confirms e-lock support (DECISIONS D-27; VENDOR_QUESTIONS C1).
- **P3.4** Address KNOWN_ISSUES open items; add hardware-observed discrepancies to PROTOCOL_NOTES/HARDWARE_VALIDATION.
- **P3.5** Production items (out of POC scope): TLS/VPN, key management, India compliance (see the SmartSkale checklist).
