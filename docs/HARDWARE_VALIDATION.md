# Hardware Validation — TT ELOCK sample (displayed ID 82637294)

Status: **BLE investigation done (read-only). TCP connection to our server NOT yet established** — blocked on
network destination (see §3). Nothing has been written to or configured on the device.

## 1. What we know about the physical unit

| Item | Value | Label | Evidence |
|---|---|---|---|
| Displayed ID | 82637294 (also on the printed label next to a QR code) | HARDWARE-SPECIFIC | device display + label photos (user, 2026-09-26) |
| Display, info screen | `TT ELOCK` / `ID:82637294` / `79A-EN-V146_2625` / `78A-V5.1 7AVT1` | HARDWARE-SPECIFIC | photo. Meaning of the two version strings (main MCU vs comms module?) UNKNOWN |
| Display, idle screen | icons: network, **padlock (locked)**, Bluetooth, battery; `ID: 82637294`; prompt **`InputKey`** | HARDWARE-SPECIFIC | photo |
| Physical state | **locked** | HARDWARE-SPECIFIC | user, 2026-09-26 |
| Local (keypad) password | **`00000000` (8 digits)** | HARDWARE-SPECIFIC | user. Relationship to the 6-byte protocol Key is UNKNOWN (§2) |
| LockID | **82637294** (wire `20 47 1C 7E`) | CONFIRMED over BLE | BLE notify frames contain `20471C7E` = Appendix 0 encoding of 82637294 |
| JT/T808 terminal ID | unknown | UNKNOWN | needs first TCP frame |
| BLE address / adv name | `DD:78:A9:81:04:A4` / `82637294` | HARDWARE-SPECIFIC | scan |
| GAP device name | `TT_LOCK7` | HARDWARE-SPECIFIC | GATT read |
| BLE services | 0x0001 (0x0002 write, 0x0003 notify), 0xFF00 (0xFF01 r/w = `0000`) | HARDWARE-SPECIFIC | GATT enumeration |
| BLE frame checksum | CRC-8/MAXIM over whole frame | HARDWARE-SPECIFIC | 5/5 frames, unique match |
| Device clock | GMT+8, ≈1 min slow | HARDWARE-SPECIFIC | BLE timestamp vs host UTC |
| "Voltage" byte (BLE) | 0x37 at 00:46 IST, **0x23 at 02:07 IST** | **Interpretation as voltage code CONTRADICTED**: 0x23 is outside the documented 0x30–0x37 range. Possibly battery % (55 → 35). UNKNOWN | BLE frames, `captures/ble-monitor-2026-09-26.jsonl` |
| Lock status (BLE) | 0x50 = locally sealed | INFERRED (field position), **consistent with the physical state** (locked by keypad) | BLE frame + user |
| Hardware variant (7B vs 4G) | 4G expected (Airtel 4G SIM) | INFERRED | 0x5D vs 0xE1 LBS item will confirm |
| Airtel SIM data/APN | unknown | UNKNOWN | |
| Configured server IP/port | unknown | UNKNOWN — **blocker** | |
| Seal key / local password | unknown | UNKNOWN — hardware configuration dependency | |

Raw evidence: `docs/evidence/2026-09-26_ble_notify_capture.log`. Tools: `tools/ble/` (scan, GATT read, passive listen, CRC finder).

## 2. Security key — how it works and what we need

- The Seal command carries a 6-byte Key which the lock stores as its "electronic seal". Unseal (and Clear alarm)
  must present the same key; otherwise the lock answers 0x93 (unseal) / 0x73 (clear alarm).
- Encoding depends on lock type: **RF lock** = 10 digits (4→WORD, 6→DWORD); **password lock** = 6 ASCII digits.
- The platform chooses the key at seal time. After a platform seal "the local password becomes invalid and the
  seal key takes effect" (Appendix 3 note).
- BLE suggests the lock is currently **locally sealed (0x5x)** — i.e. sealed via its own keypad/local password.
  The local password is not known to us. A platform Seal may still work (Appendix 3 says the platform should seal a
  locally-sealed lock); an Unseal needs a key the lock accepts.
- The keypad password is **8 digits** (`00000000`). That fits neither documented Key encoding (rf10 = 10 digits,
  ascii6 = 6 digits). For this particular all-zero password the candidate wire encodings collapse to two:
  `00 00 00 00 00 00` (rf10 of "0000000000", BCD, or hex) and `30 30 30 30 30 30` (ascii6 of "000000"). Both can be
  sent exactly with `key_format = hex`. This is a hypothesis for testing, not a documented rule (vendor question B4).
- **Best evidence source:** when the lock is online and someone opens/locks it on the keypad, the protocol says the
  lock reports an operation reply with operation identifier `'K'` + opcode + the 6-byte password it received. That
  unsolicited 0x55 shows exactly how the lock encodes a keypad password, and gives the first real business frame for
  LEN/CRC validation — without sending any command (TEST-HW-021, run before any remote command).

### Safe order for the first lock tests

1. **Precondition — recovery path (vendor question A5):** before the platform seals the lock for the first time we
   must know how to open it if our remote unseal does not work. After a platform seal "the local password becomes
   invalid and the seal key takes effect" (Appendix 3 note), so `00000000` may stop working.
2. TEST-HW-021 first (keypad unlock with `00000000` while online) → capture the unsolicited reply.
3. Remote **Unseal** of the locally sealed lock with the key encoding learned in step 2 (vendor question B5). A
   failure here is harmless: the lock stays locked and the keypad still works.
4. Only then a remote **Seal** with a key we can also open by other means, followed immediately by remote Unseal.
Record every attempt in §8.

## 3. Getting the device onto our server (Phase D/E) — BLOCKED, needs user/vendor

Requirements:
1. Public TCP endpoint reachable from the Airtel mobile network. **Decision (user, 2026-09-26): cloud VM with a
   public IP.** Deployment steps: `docs/DEPLOYMENT.md`. Waiting for the VM.
2. The device must be told the address/port. Documented parameters: 0x0013 main server (IP or domain), 0x0018 TCP
   port, 0x0010 APN. Ways to set them: via the platform the device currently talks to (0x8103 / 0x8105 cmd 2), the
   vendor's configuration tool/app, SMS commands (the supplied Appendix 5 does not include a server-address
   command), or BLE (protocol undocumented). **We need the vendor's method** — questions A1–A4 in
   `docs/VENDOR_QUESTIONS.md`. The vendor's Gitee reference (`docs/VENDOR_REFERENCE.md`) points to a gps51-style
   platform; if the lock currently reports there, the vendor can most likely re-point it from that platform.

Once connected, first actions are read-only: capture, `POST /api/devices/:id/diagnostics/query-params` (0x8104)
to record the original configuration before anything is changed.

## 4. Test matrix

Result: PASS / FAIL / BLOCKED / NOT RUN. Each executed test gets a record in §6.

| Test ID | Test | Depends on | Result |
|---|---|---|---|
| TEST-HW-000 | BLE discovery, identify LockID, clock, frame checksum (read-only) | device on | **PASS** (2026-09-26) |
| TEST-HW-001 | Device powers on, display shows ID, firmware strings, lock icon | — | PASS (user photos 2026-09-26) |
| TEST-HW-002 | Device network connectivity (SIM data attach) | SIM/APN | BLOCKED |
| TEST-HW-003 | TCP connection to our server; first raw packet captured | §3 | BLOCKED |
| TEST-HW-004 | Authentication (0x0102) / registration (0x0100) | 003 | BLOCKED |
| TEST-HW-005 | Heartbeat interval and 0x8001 handling | 004 | BLOCKED |
| TEST-HW-006 | GPS/location 0x0200 decode vs actual position | 004 | BLOCKED |
| TEST-HW-007 | Lock status (0x0200 bits 24–31 / 0x0900 upload) vs physical state | 004 | BLOCKED |
| TEST-HW-008 | Remote Seal: business LEN/CRC accepted, 0x55 result, physical seal | 004, key | BLOCKED |
| TEST-HW-009 | Remote Unseal with the seal key; wrong key → 0x93 | 008 | BLOCKED |
| TEST-HW-010 | Clear alarm | alarm state | BLOCKED |
| TEST-HW-011 | Low battery response / voltage code | battery | BLOCKED |
| TEST-HW-012 | Tamper/alarm (rod open/cut, E7/E8 bits, 0x0900 SubCmd 02–05) | 004 | BLOCKED |
| TEST-HW-013 | Reconnect after TCP disconnect (server closes socket) | 004 | BLOCKED |
| TEST-HW-014 | Server restart while device connected | 004 | BLOCKED |
| TEST-HW-015 | Device power cycle / reconnect | 004 | BLOCKED |
| TEST-HW-016 | Duplicate connection handling | 004 | BLOCKED |
| TEST-HW-017 | Business frame evidence: which LEN interpretation / CRC candidate the device uses | first 0x0900 | BLOCKED |
| TEST-HW-018 | Time zone of 0x0200 time and AbsTime; effect of 0x002A time sync | 004 | BLOCKED |
| TEST-HW-019 | Parameter read-back (0x8104) — record original configuration | 004 | BLOCKED |
| TEST-HW-020 | Sleep behaviour: messages without auth, heartbeat gaps | 004 | BLOCKED |
| TEST-HW-021 | Local keypad operation produces unsolicited 0x55 (cmdSRC keypad) | 004 | BLOCKED |
| TEST-HW-022 | BLE live status monitor (`tools/ble/ble_monitor.py`, read-only) vs physical keypad unlock / open / close / lock | device near PC | **PASS (partial)** 2026-09-26 — keypad unlock decoded (events 0x70 + 0x90, source keypad, status 0x60); re-lock seen as status 0x50; "open"/"closed" states not observed (§6) |

## 5. First-connection procedure (when §3 is resolved)

1. Start the server with capture on (default): `npm run server` (or `DB_ENABLED=false` capture-only).
2. Note the exact time; power-cycle or wait for the device to connect.
3. Do **not** send any command. Let it run for ≥ 2 heartbeat intervals.
4. From `captures/traffic.jsonl` and `/api/devices/:id/messages` record: terminal ID, auth code, message sequence,
   heartbeat interval, 0x0200 content, any 0x0900 (LEN/CRC evidence in the server log line
   "business frame evidence").
5. `POST /api/devices/:id/diagnostics/query-params` → record the device's original configuration.
6. Confirm LockID (PATCH if not learned), choose the key format, then run TEST-HW-008 with the physical state
   observed before and after.

## 6. Test records

Template (one per executed test):

```
Test ID:
Date/time (UTC):
Device ID (terminal / lock):
Initial state (physical + reported):
Command / action:
Raw TX packet:
Raw RX packet(s):
Result:
Final state (physical + reported):
Observation:
```

### TEST-HW-000 — BLE discovery (read-only)
```
Test ID:        TEST-HW-000
Date/time:      2026-09-25 19:14–19:19 UTC
Device:         BLE DD:78:A9:81:04:A4, adv name 82637294
Initial state:  powered on, near the dev PC; physical lock state not recorded
Action:         BLE scan; GATT connect; read readable characteristics; subscribe to notify char 0x0003. No writes.
Raw TX:         none (no writes)
Raw RX:         010e0120471c7e3750fd26092603154067 (+4 similar, see evidence log)
Result:         PASS
Final state:    unchanged
Observation:    LockID 82637294 encoded 20 47 1C 7E (Appendix 0 rule) - displayed ID is the LockID.
                Device clock GMT+8. BLE frame CRC = CRC-8/MAXIM. Lock status byte 0x50 (locally sealed, inferred).
```

### TEST-HW-022 — BLE live monitor during keypad operation (read-only)
```
Test ID:        TEST-HW-022
Date/time:      2026-09-26 02:09:31–02:10:43 IST (20:39–20:40 UTC, 25 Sep)
Device:         BLE DD:78:A9:81:04:A4, LockID 82637294
Initial state:  physically locked; BLE status 0x50 Sealed (local)
Action:         user operated the lock by hand (keypad unlock with 00000000, then locked again). No writes to the lock.
Raw TX:         none
Raw RX:         before:  010E0120471C7E2350FD260926043904AE   (status 0x50)
                event 1: 010F7020471C7E2360FD0226092604390443 (0x70, keypad, status 0x60)
                event 2: 010F9020471C7E2360FD02260926043904D7 (0x90, keypad, status 0x60)
                after:   010E0120471C7E2350FD26092604401437   (status 0x50)
                full list: docs/evidence/2026-09-26_ble_keypad_unlock_test.jsonl
Result:         PASS (partial)
Final state:    BLE status 0x50 Sealed (local) from lock-clock 02:10:14 IST
Observation:    see list below
```
1. **Keypad unlock produced two event frames** (new frame type, 15-byte payload, CRC-8/MAXIM valid):
   result **0x70 "alarm release success"** then **0x90 "unseal success"**, cmdSRC **0x02 keypad**, lock status **0x60**.
   Codes and field order match TT808ELOCK Appendix 1 / §10.2.1 → strong evidence that this firmware uses the A13
   result-code, cmdSRC and LockStatus semantics our server decodes. HARDWARE-SPECIFIC (BLE).
2. After a **keypad** unseal the lock reports **0x60** ("unsealed state"), not **0xBx** ("local unsealed state") as
   Appendix 3 would suggest. Possible discrepancy — verify over TCP before logging it formally (DISC candidate).
3. Why a keypad unseal also reports 0x70 "alarm released" is UNKNOWN (maybe unsealing always clears the alarm state).
4. **User-confirmed sequence (2026-09-26):** keypad unlock with `00000000` → opened the shackle → closed the shackle
   → held the lock button for a few seconds to re-seal. So the lock does **not** auto-seal on closing; sealing is a
   deliberate keypad action. Yet re-sealing produced **no 0x80 event over BLE** and the "shackle open" state was
   never seen — confirming BLE only carries periodic snapshots, not every event (obs. 5).
5. No "open" (0x1x) / "not closed" (0x3x) status was seen. Status frames arrive in pairs (3 s apart by the lock's
   clock) with gaps of a minute or more, so short states can be missed: **BLE status is not a complete event log.**
6. Delivery lag: frames arrived 17–50 s after the lock's own timestamp (slow BLE link or lock clock offset).
7. The "battery" byte stayed 0x23 throughout.

## 7. Discrepancies (hardware vs specification)

None formally recorded yet (no TCP traffic). Candidate from BLE: keypad unseal → LockStatus 0x60 instead of 0xBx
(TEST-HW-022 obs. 2). Template:

```
ID:
Date:
Protocol section:
Expected:
Actual:
Raw packet:
Interpretation:
Investigation:
Resolution:
Code change:
Hardware-specific:
Vendor clarification required:
```

## 8. Physical command log

Every command sent to the physical device is recorded here (in addition to the `commands` table).

| Time (UTC) | Command | Key format | TX (business hex) | Result code | Physical outcome | Operator |
|---|---|---|---|---|---|---|
| — | none sent yet | | | | | |
