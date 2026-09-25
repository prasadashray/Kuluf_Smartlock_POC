# IndiaLock Connect POC — Project Discovery

Date: 2026-09-26
Scope: Step 1–2 of the master instructions (inspect repository, Technical Docs, environment, physical device).

Evidence labels used throughout:

| Label | Meaning |
|---|---|
| **CONFIRMED** | Directly supported by the supplied documents or observed on the hardware |
| **INFERRED** | Reasonable interpretation, not yet hardware-verified |
| **UNKNOWN** | Requires further investigation / hardware validation |
| **HARDWARE-SPECIFIC** | Observed on the physical sample device |

---

## 1. Existing repository

At the start of discovery the repository contained **no code, no configuration and no git history** — only three PDFs:

```
Kuluf_Smartlock_POC/
└── Technical Docs/
    ├── TDD_IndiaLock_Connect.pdf                     (23 pages, Word export 2026-09-25)
    ├── TT808_ELOCK_Protocol_English.pdf              (32 pages, English translation, 2026-09-25)
    └── TT808通讯协议扩展版(完整)A13_ELOCK.pdf         (32 pages, Chinese vendor original, A13)
```

Nothing is overwritten by this POC. The project structure is created fresh (see §9).

**Related earlier work found on the machine (outside this repository):** `C:\Users\SmartSkale\Desktop\SSLockPOC\indialock-connect-poc`
(2026-09-07, simulator-only, no hardware findings). It was read but not reused, because several of its assumptions
contradict the protocol documents and the hardware evidence below: no §10.1 business envelope, LockID encoded as a
plain 32-bit integer (hardware shows the per-4-digit Appendix 0 encoding), device times treated as UTC (protocol and
hardware: GMT+8), LockID derived from the terminal ID. Its Docker Compose project is also named
`indialock-connect-poc`; see §3 for the collision this caused and how it was handled.

## 2. Documents read

| Document | Read | Role |
|---|---|---|
| TDD_IndiaLock_Connect.pdf | Completely | POC scope, architecture, priorities, schema, API |
| TT808_ELOCK_Protocol_English.pdf | Completely | Protocol reference (translation) |
| TT808…A13_ELOCK.pdf (Chinese) | Completely, with page renders of key tables | Authoritative original; used to resolve translation errors |

The English document is a translation of the Chinese A13 original. **Where they differ, the Chinese original was
checked page-by-page** (several translation defects were found — see §5).

## 3. Development environment

| Item | Finding |
|---|---|
| OS | Windows 11 Pro 10.0.26200, timezone IST (UTC+05:30) |
| Node.js / npm | **v24.18.0 / 11.16.0** |
| Python | 3.14.6 (used only for BLE diagnostics: `bleak`, `pymupdf` installed for this work) |
| Git | 2.55.0, global identity configured (prasadashray). Repository was **not** a git repo. |
| Docker | Docker Desktop 29.7.2 + Compose v5.5.0 — installed; daemon was stopped, started during discovery, works |
| PostgreSQL | **Native PostgreSQL 16.15 service running on :5432** (credentials unknown to us). POC will use its **own Postgres 16 container on :5433** via Docker Compose to avoid touching the native instance |
| Bluetooth | Intel Wireless Bluetooth (USB 8087:0026) with Microsoft BLE enumerator — **BLE scanning and GATT work** |
| Serial / USB | No USB-serial adapters. COM3–COM6 are all "Standard Serial over Bluetooth" links belonging to paired earbuds — unrelated to the lock |
| Network | Wi-Fi 192.168.1.3 behind home router 192.168.1.1; **public IPv4 122.161.76.254** (Airtel broadband); global IPv6 present. Windows Firewall enabled on all profiles. **Machine is behind NAT — not directly reachable from the mobile network** |
| Tunnels | ngrok / cloudflared not installed |
| Other Docker projects | Stopped containers `indialock-connect-poc-{server,dashboard,simulator,migrate}-1` and volume `indialock-connect-poc_db-data` belong to the earlier SSLockPOC project |

**Docker incident (2026-09-26):** this POC's compose file initially used the same project name
(`indialock-connect-poc`). `docker compose up -d db` therefore replaced the earlier project's *stopped* `db`
container with ours. Its data volume `indialock-connect-poc_db-data` was not touched. The container and empty
volume created by this POC were removed again and this POC now uses the project name `kuluf-smartlock-poc`.
Running `docker compose up` in the SSLockPOC folder will recreate that project's `db` container from its own
compose file with its existing data volume.

## 4. Confirmed protocol behaviour (from documents)

All byte-level facts below are CONFIRMED by the protocol documents (English + Chinese agree unless noted).

### 4.1 Transport and framing
- Terminal is the TCP **client**, platform is the TCP **server**. "TT devices adopt TCP (socket)". (§4.1)
- Frame: `0x7E | header | body | checksum | 0x7E`. (§4.4.1)
- Escaping on header+body+checksum: `0x7E → 0x7D 0x02`, `0x7D → 0x7D 0x01`. (§4.4.2)
- Order — send: build → checksum → escape → frame; receive: de-frame → unescape → verify checksum → parse.
- Worked example: `30 7E 08 7D 55` → `7E 30 7D 02 08 7D 01 55 7E`.
- Checksum: XOR of every byte from the first header byte to the byte before the checksum. (§4.4.4)
- Big-endian WORD/DWORD. BCD[n] = 8421 code. STRING = GBK.

### 4.2 Header (§4.4.3, Table 2, Figure 2)
| Offset | Field | Type |
|---|---|---|
| 0 | Message ID | WORD |
| 2 | Body properties: bits 0–9 length, 10–12 encryption (bit10 = RSA), 13 sub-packet, 14–15 reserved | WORD |
| 4 | Terminal ID | BCD[6] → 12 digits, leading zeros may be dropped |
| 10 | Message serial number (cyclic from 0) | WORD |
| 12 | Package item (only when bit13 = 1: total WORD + index WORD). "TT devices generally do not have this item" | — |

### 4.3 Messages needed by the POC
| ID | Dir | Body |
|---|---|---|
| 0x0001 | T→P | resp serial WORD, resp ID WORD, result BYTE (0 ok, 1 fail, 2 msg error, 3 unsupported) |
| 0x8001 | P→T | resp serial WORD, resp ID WORD, result BYTE (… 4 = alarm processing confirmed) |
| 0x0002 | T→P | empty (heartbeat) |
| 0x0100 | T→P | **TT variant: 20-byte ICCID** (not the standard JT/T808 registration body). Sent **only when authentication fails** |
| 0x8100 | P→T | resp serial WORD, result BYTE, auth code STRING (only on success) |
| 0x0102 | T→P | auth code STRING. **Factory default (no code issued) = SIM ICCID (20 bytes) + device version number** |
| 0x0200 | T→P | 28-byte basic info + TLV additional items (see §4.5) |
| 0x8900 | P→T | type BYTE `0x81` (e-lock business) + business frame (see §4.4) |
| 0x0900 | T→P | type BYTE `0x81` + business frame |
| 0x8103 | P→T | set parameters. Protocol note (highlighted): **send param 0x002A (BCD[6] time) ~500 ms after authentication succeeds, to calibrate device time** |
| 0x8104/0x0104 | P↔T | query parameters (read-only; useful to read server IP/port/APN/heartbeat from the device) |
| 0x8201/0x0201 | P↔T | on-demand location query |

Also documented: "0x0100 and 0x0102 are sent only in real-time mode, not in sleep mode" — i.e. the device may
connect and send data **without authenticating** when in sleep mode. The server must tolerate unauthenticated sessions.

### 4.4 TT e-lock business protocol (inside 0x8900 / 0x0900) — §10
**This inner layer is missing from the TDD** and is required for interoperability.

```
Uplink   (device → platform):  LEN(1) | 0x2A '*' | business data | 0x23 '#' | [28B GPS + 7B/10B LBS] (optional) | serial(2) | CRC(1)
Downlink (platform → device):  LEN(1) | 0x2A '*' | business data | 0x23 '#' | serial(2) | CRC(1)
```
- Uplink serial: `0x0000` for spontaneous uploads, **= downlink serial when replying** → this is the command
  correlation key. Downlink serial range 0x0001–0xFFFF.
- **Seal / Unseal / Clear alarm (downlink, 34 bytes of business data)**:
  `0x15 | Cmd(1) | LockID(4) | Gate(1) | Bill(8) | LineCode(2) | Key(6) | ValidTime(1) | Spare(4) | AbsTime(6)`
  Cmd: `0x32` seal, `0x38` unseal, `0x42` clear alarm, `0xA0` set dynamic password, `0xA2` modify local password.
- **Operation reply (uplink, 35 bytes, A10+ format)**:
  `0x55 | Cmd(1) | LockID(4) | Gate(1) | Bill(8) | Voltage(1) | LockStatus(1) | MotoStatus(1) | LineCode(2) | OpIdent(8) | cmdSRC(1) | AbsTime(6)`
  The reply `Cmd` byte **is the result code** (Appendix 1: 0x80 seal ok, 0x90 unseal ok, 0x70 alarm cleared …).
- **Lock info active upload (uplink, 21 bytes)**: `0x01 | SubCmd | LockID(4) | Gate | Voltage | LockStatus | MotoStatus | Spare(4) | Ver | AbsTime(6)`;
  SubCmd 0x01 info, 0x02 knob damage, 0x03 lock body damage, 0x04 rod cut, 0x05 rod open, 0xF2 request dynamic password.
- Field encodings (Appendix 0): LockID 8 digits → first 4 and last 4 decimal digits each to a WORD
  (83181001 → `0x207E03E9`); Gate fixed `0x00` for platform-linked commands; Bill 8 bytes hex literal;
  LineCode decimal → WORD; **Key 10 digits → first 4 digits WORD + last 6 digits DWORD (RF lock) or 6 ASCII digits (password lock)**;
  AbsTime BCD `YYMMDDhhmmss`; LockStatus downlink = `0x00`.
- Full result-code table (Appendix 1) incl. 0x92, 0x94–0x96, 0x98 and clear-alarm codes 0x70–0x75, 0xA1/0xA3.
- LockStatus high nibble (Appendix 3): 1 open, 2 standby, 3 not closed, 4 sealed, 5 locally sealed, 6 unsealed,
  B locally unsealed, 7 alarm, 8 local alarm, 9 alarm released, A abnormal; alarm low-nibble bits: bit0 rod cut,
  bit1 opened, bit2 shell removed, bit3 knob damaged.
- Voltage code 0x30–0x37 → 3.3–4.2 V.

### 4.5 Location report (0x0200, §8.18)
- Basic info = **28 bytes**: alarm DWORD, status DWORD, lat DWORD (deg×10⁶), lon DWORD (deg×10⁶), altitude WORD (m),
  speed WORD (0.1 km/h), direction WORD (0–359), time BCD[6] **GMT+8**.
- Hemisphere comes from status bits 2 (S) and 3 (W); fix valid = status bit 1; **status bits 24–31 = LockStatus** (0x00 = not present).
- Alarm flags Table 24 (32 bits; bit0 emergency, bit31 illegal door opening, …).
- TT additional items: 0xE1 (7B LBS, 2G lock), **0x5D (1+n×10 LBS, 4G lock)**, 0xE2 IMEI, 0xE3 version, 0xE6 ICCID,
  0xE7 24-bit alarm status (bit0 cable cut, bit1 emergency unlock, bit2 removal, bit3 cover open, bit4 vibration,
  bit5 tilt, bit6 roll-over, bit7 high temp, bit8 low temp), 0xE8 24-bit switch status (+ network type bits 20–23),
  0xE9 battery %, 0x56 battery %/voltage (50 mV units), 0x30 RSSI, 0x31 satellites, 0x51 temperatures, 0x58 humidity,
  0xEA G-sensor.

## 5. Discrepancies found (documents vs documents)

Recorded in full in `docs/DECISIONS.md` / `docs/PROTOCOL_NOTES.md`. Summary:

| ID | Where | Finding | Decision |
|---|---|---|---|
| DOC-01 | TDD §5.1/5.3 vs protocol §10.1 | TDD omits the business envelope (LEN, `*`/`#`, business serial, CRC) | Implement protocol envelope (TDD would not interoperate) |
| DOC-02 | TDD §5.4 | TDD says reply `Cmd` "echoes which command"; protocol shows reply `Cmd` = result code (example `55 97` = "unseal without seal") | Follow protocol |
| DOC-03 | TDD §5.2 | Result-code list incomplete (missing 0x92, 0x94–0x96, 0x98, 0x70–0x75, 0xA1, 0xA3) | Implement full Appendix 1 |
| DOC-04 | English App.0 Key | English: last 6 digits → "2B"; Chinese: → **4B**; the example (`04D2 0008AA52` = "1234567890") confirms 4B | Follow Chinese |
| DOC-05 | English §10.2.1 example | English drops a byte of the Seal example (`0810164318`); Chinese `08 10 10 16 43 18` is self-consistent. English reply example also drops a `05` | Use Chinese example as the known-value test |
| DOC-06 | §10.1 LEN semantics | Text: "length from business data to CRC". Both examples give LEN = (bytes `0x2A`…`0x23` inclusive) + 1 and appear to pre-date the serial field | **UNKNOWN — hardware validation**; decoder auto-detects, encoder configurable |
| DOC-07 | §10.1 CRC | CRC algorithm and coverage are **not specified anywhere** | **UNKNOWN — hardware validation**; candidate CRC-8/MAXIM from BLE evidence (H-06) |
| DOC-08 | Table 23 offsets | Direction at 20 (WORD) but Time listed at 21; must be 22 (basic info = 28 B, matching "28B GPS" in §10.1) | Time at offset 22 |
| DOC-09 | TDD §5.7 | TDD calls GMT+8 "India-adjacent"; GMT+8 is China time (India = GMT+5:30) | Store UTC; convert with configurable device offset (default +8 h, see H-07) |
| DOC-10 | TDD §6 | TDD omits the 0x8103/0x002A time-sync-after-auth step highlighted in the protocol | Implement, configurable |
| DOC-11 | Protocol §10.3 | "Normal reply 0x61 …" vs table "center business reply: none" for SubCmd 0x01–0x05 | **UNKNOWN**; configurable, default = no 0x61 reply (JT808 0x8001 ack always sent) |
| DOC-12 | English App.3 bit2 | English "Removal alarm"; Chinese 拆壳 = shell/housing removed | Follow Chinese |
| DOC-13 | TDD §4.4 | TDD: "rest of body properties = 0"; protocol defines encryption & sub-packet bits | Decode all bits; flag encrypted/sub-packet frames |

## 6. Hardware observations (physical device, via BLE — no TCP traffic yet)

The lock was discovered over BLE during this step. All interaction was **read-only**: advertisement scan,
GATT enumeration, reading readable characteristics, and subscribing to the notify characteristic. **Nothing was
written to the device.** Raw evidence: `docs/evidence/2026-09-26_ble_notify_capture.log`.

| ID | Observation | Label |
|---|---|---|
| H-01 | BLE advertisement name **`82637294`**, MAC `DD:78:A9:81:04:A4`, service UUID 0x0001, manufacturer data (company 0x7A68) = MAC reversed | HARDWARE-SPECIFIC |
| H-02 | GAP Device Name characteristic = **`TT_LOCK7`** | HARDWARE-SPECIFIC |
| H-03 | Vendor service 0x0001: char 0x0002 *write*, char 0x0003 *notify* (UART-style). Vendor service 0xFF00: char 0xFF01 read/write (value `0000`) | HARDWARE-SPECIFIC |
| H-04 | While connected, the lock notifies frames like `01 0E 01 20 47 1C 7E 37 50 FD 26 09 26 03 15 40 67` | HARDWARE-SPECIFIC |
| H-05 | Bytes `20 47 1C 7E` = **82637294 encoded with the Appendix 0 LockID rule** (8263 = 0x2047, 7294 = 0x1C7E). ⇒ **The displayed ID 82637294 is the LockID.** It is *not yet known* whether it is also the JT/T808 Terminal ID | CONFIRMED (BLE); TCP pending |
| H-06 | Last byte of every BLE frame = **CRC-8/MAXIM** (poly 0x31 reflected, init 0, xorout 0) over all preceding bytes; unique match among ~8,000 CRC-8/sum/xor variants on 5/5 frames | HARDWARE-SPECIFIC |
| H-07 | Frame contains BCD time `26 09 26 03 15 40` received at 2026-09-25 19:16:33 UTC ⇒ **device clock runs on GMT+8** (≈1 min slow); timestamps advance 3 s per frame regardless of arrival spacing | HARDWARE-SPECIFIC |
| H-08 | By analogy with the protocol's field order (LockID, Voltage, LockStatus, MotoStatus, time): `0x37` = 4.2 V (full), `0x50` = **locally sealed**, `0xFD` = motor status (meaning unknown); `0x0E` = payload length (14 bytes between it and the CRC) | INFERRED |
| H-10 | (2026-09-26, user photos) Display: `TT ELOCK`, `ID:82637294`, `79A-EN-V146_2625`, `78A-V5.1 7AVT1`; idle screen shows a locked padlock icon and `InputKey`. User: lock is physically locked, keypad password `00000000` (8 digits) — consistent with H-08 "locally sealed" | HARDWARE-SPECIFIC |
| H-09 | Note: LockID contains `0x7E` ⇒ every TCP business frame carrying this LockID **will exercise the escaping code** | CONFIRMED (arithmetic) |

BLE conclusions:
- BLE exposes a vendor UART-style command channel. Its command protocol is **UNKNOWN** (not in any supplied document).
  It *may* be the vendor's provisioning path (server IP/APN), but we will **not write to it blindly**.
- BLE is **not** part of the primary architecture; it remains a diagnostic/provisioning aid (tools in `tools/ble/`).

## 7. Unknowns (require hardware validation or vendor input)

| ID | Unknown | How we will resolve it |
|---|---|---|
| U-01 | **Server IP/port/APN currently configured in the device, and how to change it** (SMS? BLE? vendor platform? device menu?) | Ask vendor / user; `0x8104` query once connected anywhere we control |
| U-02 | Terminal ID used in the JT/T808 header | First captured TCP packet |
| U-03 | Auth code the device will present (factory ICCID+version, or a vendor-issued code) | First `0x0102` |
| U-04 | Heartbeat interval, sleep/wake behaviour, whether it stays connected | Traffic capture, `0x8104` |
| U-05 | Business LEN semantics (DOC-06) | First `0x0900` — decoder records which interpretation matches |
| U-06 | Business CRC algorithm/coverage (DOC-07) | First `0x0900` — decoder tests candidates (CRC-8/MAXIM, XOR, SUM over several ranges) |
| U-07 | **Lock type (RF 10-digit key vs password 6-ASCII key) and the current seal key**. BLE suggests the lock is "locally sealed" — local password unknown | Vendor / user; `0x55` replies carry OpIdent incl. entered password |
| U-08 | Whether a `0x61` business reply is expected for lock info uploads (DOC-11) | Observe device retransmissions |
| U-09 | LBS variant on this 4G unit (0x5D vs 0xE1) | First `0x0200` |
| U-10 | Whether the Airtel SIM has an active data plan / correct APN | Device connecting at all |
| U-11 | Whether the ISP puts our public IP behind CGNAT (affects port-forwarding option) | Router check / external port test |
| U-12 | BLE command protocol (chars 0x0002, 0xFF01) | Vendor documentation only |

## 8. Network requirements

1. A **publicly reachable IPv4 address + TCP port** that the Airtel mobile network can reach. The dev machine is
   behind NAT; options, in order of preference for a stable POC:
   - **Cloud VM** with a public IP (recommended; stable, no home-router dependency).
   - **Router port-forward** 192.168.1.1 → 192.168.1.3:<port> + Windows Firewall inbound rule (requires router admin; fails if CGNAT).
   - **TCP tunnel** (e.g. bore / pinggy / ngrok-TCP) for a quick first capture (third-party relay; traffic is unencrypted).
2. The device must be configured with that address (param 0x0013 main server, 0x0018 TCP port; possibly 0x0010 APN).
   **How to do this on this unit is U-01** — this is the main hardware blocker.
3. The protocol has no encryption; the POC listener should only expose the device TCP port publicly. The REST API
   binds to localhost by default.

## 9. Proposed POC architecture

```
Physical TT ELOCK / Simulator ──TCP (JT/T808 + TT e-lock business layer)──► TCP listener (Node net)
                                                                             │  FrameDecoder (stream reassembly)
                                                                             │  protocol/ (codec, escaping, XOR, header, bodies, business layer)
                                                                             ▼
                                                               SessionManager (per-connection state, duplicate-session handling,
                                                                               online/offline, serial counters)
                                                                  │                          │
                                                        CommandService              Telemetry/Alarm service
                                                     (build 0x8900, correlate       (0x0200, 0x0900 uploads,
                                                      0x0001 + 0x0900/0x55,          alarms, lock status, battery)
                                                      timeouts, result codes)
                                                                  └────────────┬─────────────┘
                                                                        PostgreSQL 16 (migrations)
                                                                  devices · sessions · message_log · commands · locations · alarms
                                                                               │
                                                                        REST API (Express, localhost)
                                                                               │
                                                                     React dashboard (Vite + Leaflet, polling)
```

- Protocol code is pure (no I/O) and shared by server and simulator.
- Every RX/TX frame (and raw TCP chunk in verbose mode) goes to `message_log` and to an optional JSONL capture file.
- Uncertain protocol points (DOC-06, DOC-07, DOC-11, time offset, key format) are **configuration**, and the decoder
  records which candidate matched so hardware evidence settles them.

Project layout:
```
server/      src/{protocol,tcp-listener,services,api,db,config,logging}, migrations/, tests/
simulator/   simulate-device.js, scenarios/
dashboard/   React + Vite
tools/ble/   read-only BLE diagnostics (Python/bleak)
docs/        discovery, architecture, protocol notes, hardware validation, test plan/results, decisions, troubleshooting
docker-compose.yml, .env.example, README.md
```

## 10. Recommended technology stack

The TDD stack is kept; inspection found no reason to change it.

| Layer | Choice | Note |
|---|---|---|
| TCP listener / protocol | Node.js 24 (ESM), `net` + `Buffer` | installed; no protocol framework needed |
| API | Express 5 | minimal |
| DB | PostgreSQL 16 (Docker, port 5433) + `pg` | own SQL migration runner (plain `.sql` files) |
| Tests | Node built-in `node:test` | no Jest dependency |
| Simulator | Node.js, same protocol module | |
| Dashboard | React + Vite + Leaflet | polling, minimal |
| Config | env vars via Node's built-in `process.loadEnvFile` | no dotenv dependency |
| BLE diagnostics | Python + bleak | dev tool only, not part of the runtime |

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Cannot point the device at our server (U-01) | Blocks all hardware phases | Ask vendor early; investigate device menu/SMS; BLE only with vendor docs |
| Business CRC/LEN wrong (U-05/U-06) | Device ignores/rejects Seal/Unseal | Configurable encoder; learn from first uplink `0x0900`; device `0x0001` result shows rejection |
| Unknown seal key / local password (U-07) | Unseal fails with 0x93 | Get key from vendor; start tests from an unsealed state; record every attempt |
| Device sleeps and disconnects | Commands cannot be delivered | Track online state; API refuses commands to offline devices |
| Public exposure of an unencrypted port | Security | Expose only the device port; API on localhost; allow-list where possible |
| Airtel SIM data/APN issue | No connection | Check with user/vendor; `0x8104` read-back |
| Firmware deviations from A13 | Parser mismatches | Raw capture of everything; discrepancy log |

## 12. Immediate next steps

1. **Protocol module + tests** (escaping worked example first, then checksum, header, bodies, business layer with the
   Chinese Seal example as a known-value test).
2. Simulator on the same protocol module.
3. TCP listener, Postgres migrations, services, REST API, minimal dashboard; full simulated end-to-end run.
4. In parallel, resolve **U-01** (how to point the device at our server) and the public endpoint choice — these need
   information/access from the user or vendor.
