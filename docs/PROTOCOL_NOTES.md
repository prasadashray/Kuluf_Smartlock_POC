# Protocol Notes — TT808ELOCK (JT/T808-2013 + TT A13 e-lock extension)

Implementation: `server/src/protocol/` (pure functions, no I/O; shared by server, simulator and tests).

Labels: **CONFIRMED** (documents or hardware), **INFERRED** (not yet hardware-verified), **UNKNOWN**,
**HARDWARE-SPECIFIC**. "EN" = English translation, "CN" = Chinese A13 original.

---

## 1. Transport and framing — CONFIRMED (EN/CN §4)

| Rule | Implementation |
|---|---|
| TCP, terminal = client, platform = server | `tcp-listener/server.js` |
| `0x7E | header | body | XOR | 0x7E` | `packet.js` `encodePacket` / `decodePacket` |
| Escape `7E→7D 02`, `7D→7D 01` over header+body+checksum | `escape.js` |
| Send: build → checksum → escape → frame. Receive: de-frame → unescape → checksum → parse | `packet.js` |
| XOR checksum from first header byte to byte before checksum | `checksum.js` |
| Big-endian WORD/DWORD, BCD 8421, STRING = GBK | `bytes.js` (GBK decode via `TextDecoder('gbk')`; encode ASCII only) |

Worked example (§4.4.2): `30 7E 08 7D 55` → `7E 30 7D 02 08 7D 01 55 7E` — unit-tested.

Receive-side hardening (not in the documents, required by TCP): `frame-decoder.js` treats every non-empty run of
bytes between two `0x7E` as a candidate frame; handles split frames, coalesced frames, shared delimiters, garbage
and oversize input. Invalid escapes, short frames and checksum failures are rejected, logged with the raw bytes,
and **not acknowledged** (the terminal retransmits per its own policy).

## 2. Header — CONFIRMED (Table 2, Figure 2)

`msgId WORD | props WORD (len bits0-9, encryption bits10-12, sub-packet bit13, reserved 14-15) | terminal BCD[6] | serial WORD | [package item]`

- Terminal ID is stored as the full 12-digit string (lossless); replies echo the **exact 6 raw bytes** received.
- Encrypted (bit10) frames are flagged as warnings; sub-packet header is decoded; reassembly is not implemented
  ("TT devices generally do not have this item").
- Platform serial: per session, cyclic from 0.

## 3. Messages implemented

| ID | Dir | Status | Notes |
|---|---|---|---|
| 0x0001 | T→P | CONFIRMED | reply serial/ID/result; used for command delivery ack |
| 0x8001 | P→T | CONFIRMED | sent for every terminal-initiated message except responses |
| 0x0002 | T→P | CONFIRMED | empty body |
| 0x0100 | T→P | CONFIRMED (TT variant) | **20-byte ICCID** only; extra bytes kept as hex |
| 0x8100 | P→T | CONFIRMED | serial + result + auth code (only on success) |
| 0x0102 | T→P | CONFIRMED | STRING auth code; factory default = ICCID(20) + version (heuristic split for display only) |
| 0x0200 | T→P | CONFIRMED | see §5 |
| 0x8103 | P→T | CONFIRMED | used for time calibration (param 0x002A) after auth |
| 0x8104/0x0104 | P↔T | CONFIRMED | read-only parameter query (server IP/port/APN/heartbeat) |
| 0x8201/0x0201 | P↔T | CONFIRMED | on-demand location |
| 0x8300/0x0300 | P↔T | CONFIRMED format | text; 0x0300 flag 4 = TT text upload |
| 0x8900/0x0900 | P↔T | CONFIRMED wrapper | type `0x81` + TT business frame (§4) |
| others | — | — | logged with raw hex, acknowledged with 0x8001 result 3 (not supported) |

Sleep mode (§8.8 note 2): 0x0100/0x0102 are not sent in sleep mode → the server **processes and stores messages
from unauthenticated sessions**, but refuses lock commands to them (`REQUIRE_AUTH_FOR_COMMANDS=true`).

## 4. TT e-lock business frame (§10) — structure CONFIRMED, two details UNKNOWN

```
Uplink:   LEN | 2A | business data | 23 | [28B GPS + 7B/10B LBS] | serial(2) | CRC(1)
Downlink: LEN | 2A | business data | 23 | serial(2) | CRC(1)
```

### 4.1 LEN byte — UNKNOWN (DOC-06)
The text says "length from business data to CRC". The two document examples are:

| Example | Bytes `2A`..`23` | LEN printed |
|---|---|---|
| Seal (downlink) | 36 | `0x25` = 37 |
| Operation reply (legacy uplink) | 27 | `0x1C` = 28 |

Both equal *(bytes 2A..23) + 1*, and neither example shows the serial number (`$$` placeholder) — they appear to
pre-date the serial field. Implemented interpretations (`BIZ_LEN_MODE`):

| Mode | LEN = | Status |
|---|---|---|
| `after_len` (default) | every byte after LEN, including serial and CRC | INFERRED ("business data to CRC", inclusive) |
| `after_len_excl_crc` | every byte after LEN except CRC | alternative reading |
| `doc_example` | (2A..23) + 1 | matches the printed examples |

The decoder does **not** depend on LEN to find fields: it locates `0x23` from the known data length per operation
code and the documented additional-info sizes (0 / 35 / 38), then records in `lenInterpretations` which modes the
received LEN satisfies. **The first real 0x0900 frame settles this.**

### 4.2 CRC byte — UNKNOWN (DOC-07)
No document specifies the algorithm or coverage. Candidates computed on every uplink frame and recorded in
`crcMatches`: {`crc8_maxim`, `xor`, `sum`} × {`from_len` (LEN..serial), `from_head` (2A..serial)}.
Default `crc8_maxim/from_len` is INFERRED from hardware evidence H-06 (the same device's BLE frames use CRC-8/MAXIM
over the whole frame). Until confirmed, mismatches are logged as warnings and frames are still processed
(`BIZ_CRC_ENFORCE=false`); once confirmed, set the matching config and `BIZ_CRC_ENFORCE=true`.

**Downlink risk**: if LEN/CRC defaults are wrong, the lock will ignore or reject Seal/Unseal. Evidence to look for:
0x0001 result 2 ("message error") to our 0x8900, or no 0x55 reply. The command record stores the exact TX bytes.

### 4.3 Business serial — CONFIRMED
Downlink 0x0001–0xFFFF; uplink `0x0000` for spontaneous uploads, `= downlink serial` for replies. This is the
command correlation key (`commands.business_serial`). Start value is randomised per server process.

### 4.4 Business data layouts — CONFIRMED (CN §10.2.1, §10.3)

**Lock operation (downlink, 34 bytes)**
`15 | Cmd | LockID(4) | Gate | Bill(8) | LineCode(2) | Key(6) | ValidTime | Spare(4) | AbsTime(6)`
Cmd: `32` seal, `38` unseal, `42` clear alarm, `A0` set dynamic password, `A2` modify local password.
Unit test reproduces the CN example byte-for-byte:
`1532 043B1F46 02 00003039040BEBCB 04D2 04D20008AA52 03 01108026 081010164318` (EN translation drops a byte — DOC-05).

**Operation reply (uplink, 35 bytes, A10+)**
`55 | Result | LockID(4) | Gate | Bill(8) | Voltage | LockStatus | MotoStatus | LineCode(2) | OpIdent(8) | cmdSRC | AbsTime(6)`
The 2nd byte is the **result code** (Appendix 1), not an echo of the command (TDD DOC-02). The legacy 25-byte form
(no LineCode/OpIdent), matching the CN example `55 97 …`, is also decoded and flagged `legacy_pre_A10`.

OpIdent: `'R'|'C'|'K'` + opcode + 6-byte entered password; `'1'/'0'` dynamic password; `'I'` IC card.
cmdSRC: 00 SMS, 01 auto, 02 keypad, 03 handheld, 04 platform, 05 checkpoint, 06 IC card, 07–0F other.

**Lock info active upload (uplink, 21 bytes)**
`01 | SubCmd | LockID(4) | Gate | Voltage | LockStatus | MotoStatus | Spare(4) | Ver | AbsTime(6)`;
SubCmd 01 info, 02 knob damage, 03 lock body damage, 04 rod cut, 05 rod open, F2 request dynamic password.
Platform "normal reply" `61 | SubCmd | LockID | AbsTime` vs table "center business reply: none" (DOC-11):
**not sent by default** (`BIZ_REPLY_TO_LOCK_UPLOAD=false`); the JT/T808 0x8001 is always sent.

### 4.5 Field encodings (Appendix 0)

| Field | Rule | Status |
|---|---|---|
| LockID | 8 digits; first 4 and last 4 digits each → WORD. 83181001 → `207E03E9` | CONFIRMED (doc) + **HARDWARE-CONFIRMED over BLE**: 82637294 → `20 47 1C 7E` |
| Gate | platform-linked commands fixed `0x00` | CONFIRMED |
| Bill | 8 bytes, hex literal | CONFIRMED |
| LineCode | decimal → WORD | CONFIRMED |
| Key | RF lock: 10 digits, first 4 → WORD, **last 6 → DWORD** (CN; EN wrongly says 2B — DOC-04); password lock: 6 ASCII digits | CONFIRMED format; **which one this lock uses is UNKNOWN** |
| AbsTime | BCD `YYMMDDhhmmss`, "center time or communication-unit local time" | CONFIRMED format; zone see §6 |
| LockStatus (downlink) | reserved, `0x00` | CONFIRMED |

Note: the sample's LockID contains `0x7E`, so every business frame for this lock exercises escaping.

### 4.6 Result codes (Appendix 1) — CONFIRMED, all implemented

| Seal (0x32) | | Unseal (0x38) | | Clear alarm (0x42) | |
|---|---|---|---|---|---|
| 80 success | | 90 success | | 70 success | |
| 81 repeat seal | no_change | 91 repeat unseal | no_change | 71 timeout | |
| 82 not locked properly | | 92 lock open | | 72 not in alarm | no_change |
| 83 voltage too low | | 93 key mismatch | | 73 key mismatch | |
| 84 housing opened | | 94 housing opened | | 74 housing opened | |
| 85 emergency unlock | | 95 emergency unlock | | 75 emergency unlock | |
| 86 rod cut alarm | | 96 open alarm | | | |
| 87 rod open alarm | | 97 unseal without seal | no_change | | |
| 89 timeout | | 98 cut alarm | | | |
| | | 99 timeout | | | |

Also A1 (dynamic password set), A3 (local password changed). Each command stores raw code, protocol meaning and label.

### 4.7 LockStatus (Appendix 3) — CONFIRMED
High nibble: 1 open, 2 standby, 3 not locked properly, 4 sealed, 5 locally sealed, 6 unsealed, B locally unsealed,
7 alarm, 8 local alarm, 9 alarm released, A abnormal. For 7x/8x the low nibble: bit0 rod cut, bit1 opened,
bit2 shell removed (CN 拆壳; EN "removal" — DOC-12), bit3 knob damaged.
Appendix 3 note: in "locally sealed" state the platform must issue a Seal to put the lock into (platform) sealed
state; after a platform seal the local password becomes invalid and the seal key applies.

## 5. Location report 0x0200 — CONFIRMED

28-byte basic block: alarm DWORD, status DWORD, lat/lon DWORD (deg × 10⁶, hemisphere from status bits 2/3),
altitude WORD m, speed WORD 0.1 km/h, direction WORD, time BCD[6]. Table 23 lists Time at offset 21, which is
impossible after a WORD at 20 — implemented at **22** (DOC-08; 28 bytes also matches "28B GPS" in §10.1).

Status bits 24–31 = LockStatus (0x00 = absent). Alarm flag bits: Table 24 (all 32 decoded).
Additional items decoded: 01, 02, 03, 04, 11, 12, 13, 25, 2A, 2B, 30, 31, E1 (7B LBS), E2 IMEI, E3 version,
E6 ICCID, 5D (4G LBS 1+n×10), E7 (24-bit alarm status), E8 (24-bit switch status + network type), E9 battery %,
56 battery %/voltage, 51 temperatures, 58 humidity, EA G-sensor. Unknown items are kept as hex.
E7/E8 bit numbering is taken as bit 0 = least-significant bit of the 3-byte big-endian value (INFERRED).

## 6. Time zone — CONFIRMED by protocol, HARDWARE-SPECIFIC evidence agrees

All protocol times are GMT+8 (Table 23 note). BLE frames from the sample carried `26 09 26 03 15 40` at
19:16:33 UTC → device clock is GMT+8 (≈1 min slow). All times are stored in UTC; conversion uses
`DEVICE_TZ_OFFSET_MINUTES` (default 480). The raw BCD string is stored alongside (`device_time_raw`).

## 7. Connection behaviour

| Behaviour | Source | Implementation |
|---|---|---|
| Auth immediately after connect | §5.1 | tolerated in any order |
| Registration only when auth fails | §8.5 note | `AUTH_MODE=known_devices` + `REGISTRATION_MODE=issue_code` |
| Heartbeat → 0x8001 | §5.2 | yes |
| Same identity reconnects → old connection is dead | §5.3 | old session closed (`replaced_by_new_connection`) |
| No message for a period → disconnected | §5.3 | `DEVICE_OFFLINE_TIMEOUT_S` sweep closes socket, marks offline |
| Platform retransmission on timeout | §6.1.1 | **not done for lock commands** (see DECISIONS D-07) |
| Time calibration 500 ms after auth | §8.9 note | `TIME_SYNC_ON_AUTH`, `TIME_SYNC_DELAY_MS` |

## 9. BLE frames observed on the sample (HARDWARE-SPECIFIC, layout INFERRED)

Not part of any supplied document. Read-only observations from notify characteristic 0x0003
(`tools/ble/ble_monitor.py`; evidence in `docs/evidence/`). Check byte = CRC-8/MAXIM over all preceding bytes.

```
status: 01 | 0E | 01     | LockID(4) | Batt? | LockStatus | MotoStatus |          BCD time(6) GMT+8 | CRC
event:  01 | 0F | Result | LockID(4) | Batt? | LockStatus | MotoStatus | cmdSRC | BCD time(6) GMT+8 | CRC
```
- The 2nd byte counts the bytes between it and the CRC.
- `Result` values seen: 0x70, 0x90 (Appendix 1); `cmdSRC` 0x02 = keypad; LockStatus 0x50 / 0x60 (Appendix 3).
- The byte after LockID read 0x37 and later 0x23; 0x23 is not a documented voltage code (maybe battery %).
- The BLE command (write) format is UNKNOWN; nothing has been written to the lock.

## 8. Discrepancy log (documents vs hardware)

No TCP traffic from the physical device has been captured yet. Hardware discrepancies will be recorded in
`docs/HARDWARE_VALIDATION.md` §Discrepancies using the template from the master instructions.
