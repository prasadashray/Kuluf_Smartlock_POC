# Test Results

## Summary (2026-09-26, Windows 11, Node v24.18.0)

| Suite | Result |
|---|---|
| Unit — protocol (72 tests) | **72/72 pass** |
| Integration — simulator ↔ TCP ↔ services ↔ store ↔ API (27 tests) | **27/27 pass** (incl. keypad-operation test added 2026-09-26) |
| End-to-end with PostgreSQL 16 (`tests/e2e/postgres.test.js`, 4 tests) | **4/4 pass** (2026-09-26, container `kuluf-smartlock-poc-db-1`) |
| Live simulated run (real server process + simulator CLI + REST) | **PASS** (capture-only mode, in-memory store) |
| Dashboard | builds; dev server serves it and proxies `/api` (checked with curl); **not yet visually checked in a browser** |
| Docker images (`--profile full build`) | **built** (server, simulator, dashboard); containers not yet run |
| Hardware | TEST-HW-000 (BLE, read-only) PASS; everything else BLOCKED — see `HARDWARE_VALIDATION.md` |

**Simulator results only prove our implementation is self-consistent with our reading of the documents. They do
not prove interoperability with the physical lock.** Two protocol details used for commands (business LEN
semantics, business CRC) are still unverified on hardware.

## Live simulated run (Step 15)

Command sequence: server `DB_ENABLED=false TCP_PORT=6808 API_PORT=3000 COMMAND_TIMEOUT_S=10`; simulator
`--device-id 000082637294 --lock-id 82637294 --heartbeat 5 --location-interval 4 --lock-upload-interval 6
--simulate-location --reply-delay-ms 1500`; `node tools/e2e-api-check.mjs`.

```
health {"ok":true,"tcpPort":6808,"liveSessions":1}
device {"online":true,"auth":true,"terminal":"000082637294","lock":"82637294","state":"unsealed","voltage":"0x36","pct":80,"loc":[28.619439,77.212321]}
200 seal:        completed 0x80 "Sealed"                   outcome=success   succeeded=true  ack=success correlation=business_serial
200 unseal:      completed 0x93 "Unseal failed: wrong key" outcome=failure   succeeded=false ack=success correlation=business_serial
200 unseal:      completed 0x90 "Unsealed"                 outcome=success   succeeded=true  ack=success correlation=business_serial
200 clear_alarm: completed 0x72 "Lock not in alarm state"  outcome=no_change succeeded=false ack=success correlation=business_serial
seal TX  7E89000029000082637294001281272A153220471C7D02000000000000000000000004D20008AA5200000000002609260359412355C428B57E
seal RX  7E090000500000826372940013814E2A558020471C7D020000000000000000003640000000433204D20008AA520426092603594323000000004004000201B4B4A3049A2BCD00D80144001F26092603594301945A1234015012341F55C4E5957E
0x0104 params [["0x0001","heartbeat_interval_s",5],["0x0013","main_server_address","127.0.0.1"],["0x0018","server_tcp_port",6808],["0x0010","apn","simulated.apn"]]
locations: 18  commands: 4  messages: 62  events: 22  checksum failures: 0
```

Note in the Seal TX: LockID `20 47 1C 7E` appears on the wire as `20 47 1C 7D 02` (escaping of the real device's ID).

## Unit + integration test list (last run)

```
✔ WORD / DWORD / BYTE are big-endian and range-checked
✔ BCD encode/decode
✔ BCD time 0x080402152050 = 2008-04-02 15:20:50 GMT+8 = 07:20:50Z (param 0x002A example)
✔ BCD time with a configurable offset (IST +330) and round-trip
✔ hardware BLE timestamp 26 09 26 03 15 40 (GMT+8) = 2026-09-25T19:15:40Z
✔ invalid / zero BCD times are flagged not converted
✔ STRING: ASCII round-trip, GBK decode, non-ASCII encode rejected
✔ §4.4.2 worked example: 30 7E 08 7D 55 -> 7E 30 7D 02 08 7D 01 55 7E
✔ §4.4.2 worked example reverses exactly
✔ escape leaves ordinary bytes untouched
✔ escape/unescape round-trip over every byte value
✔ consecutive special bytes
✔ unescape reports invalid escape sequences instead of guessing
✔ single complete frame in one read
✔ multiple frames in one TCP read
✔ frame split across reads at every possible byte boundary
✔ byte-by-byte delivery
✔ garbage before first delimiter is reported and skipped
✔ garbage between frames surfaces as an invalid frame, next frame still decodes
✔ shared delimiter between frames (7E A 7E B 7E) is tolerated
✔ oversize data without delimiter is discarded and decoder resynchronises
✔ basic location info is 28 bytes with time at offset 22 (DOC-08)
✔ known-value decode: lat/lon x1e6, speed 1/10 km/h, direction, GMT+8 time
✔ southern / western hemisphere sign comes from status bits 2 and 3
✔ status bits 24-31 = 0x00 means no lock status
✔ TT additional items: E7 alarms, E8 switches, E9 battery, 56 voltage, 5D LBS, E6 ICCID, 30/31
✔ truncated additional item is reported, earlier items kept
✔ short body is an error, not an exception
✔ 0x8001 platform general response body
✔ 0x0001 terminal general response result labels
✔ 0x0100 TT registration carries a 20-byte ICCID
✔ 0x8100 registration response: auth code only on success
✔ 0x0102 authentication: factory default ICCID + version is recognised, full string kept as the code
✔ 0x8103 set parameters: time calibration param 0x002A (BCD[6]) and heartbeat 0x0001
✔ 0x0104 query parameters response decodes server address/port/APN
✔ 0x0900 passthrough with type 0x81 decodes the e-lock business frame
✔ passthrough with a non-0x81 type is kept as raw content
✔ text upload / downlink (0x0300 / 0x8300)
✔ unknown message IDs are preserved as hex
✔ checksum known value: heartbeat header for terminal 000082637294 serial 1 = 0x04 (hand-calculated)
✔ encodePacket builds the exact heartbeat frame
✔ decodePacket round-trips header, body and checksum
✔ packets whose header/body/checksum contain 0x7E/0x7D are escaped and restored
✔ checksum that itself needs escaping is escaped
✔ invalid checksum is rejected (not silently accepted) but header is still reported for logging
✔ truncated and badly escaped frames are rejected
✔ body length mismatch and encryption flag are reported as warnings
✔ body properties bit layout (Figure 2)
✔ sub-packet header includes the package item
✔ terminal ID: BCD[6] parsed as 12 digits, leading zeros optional (§4.4.3 example)
✔ non-BCD terminal ID nibbles are preserved, not dropped
✔ LockID conversion, Appendix 0 example: 83181001 -> 0x207E03E9
✔ LockID of the physical sample (hardware BLE evidence): 82637294 -> 20 47 1C 7E
✔ LockID validation
✔ Key rf10 (Chinese Appendix 0): first 4 digits -> WORD, last 6 digits -> DWORD; example 1234567890 -> 04D2 0008AA52
✔ Key ascii6 (password lock) and hex escape hatch
✔ Bill and LineCode
✔ Seal command reproduces the protocol document example byte-for-byte
✔ document example LEN 0x25 equals the doc_example interpretation
✔ decodeLockOperation reads the document example
✔ Unseal and Clear alarm command bytes
✔ Legacy (pre-A10) operation reply example from the Chinese document decodes
✔ A13 operation reply round-trip with operation identifier
✔ result codes keep raw code, protocol meaning and label
✔ lock status (Appendix 3) and voltage codes
✔ lock info upload (§10.3) and 0x61 reply round-trip
✔ business frame downlink round-trip with default options
✔ business frame uplink with 28B GPS + 10B LBS additional information
✔ LockID containing 0x23 does not confuse tail detection
✔ decoder records which LEN / CRC interpretation a frame matches (evidence for DOC-06/07)
✔ CRC-8/MAXIM reproduces the checksums of the frames captured from the device over BLE (H-06)
✔ malformed business frames produce errors, not exceptions
▶ simulator <-> TCP listener <-> protocol <-> services <-> store <-> API
  ✔ connection + factory authentication (ICCID + version) is accepted and recorded
  ✔ time calibration 0x8103/0x002A is sent after authentication and acknowledged
  ✔ heartbeat is acknowledged with 0x8001 and recorded
  ✔ location report is decoded, stored as history and acknowledged
  ✔ commands are refused while the LockID is unknown (it is never guessed)
  ✔ LockID is learned from a 0x0900 lock-info upload
  ✔ seal: command -> 0x8900 -> 0x0001 ack -> 0x0900/0x55 reply 0x80 -> success; key stored
  ✔ repeat seal returns 0x81 "Already sealed" (no_change, not success)
  ✔ unseal with the wrong key returns 0x93 and the lock stays sealed
  ✔ unseal with the stored key returns 0x90 success
  ✔ API returns 202 with status "sent" (not success) when not waiting
  ✔ tamper: alarm upload + lock status alarm + E7 cable cut are raised; clear alarm 0x70 clears them
  ✔ clear alarm when not in alarm returns 0x72
  ✔ low battery: seal returns 0x83 and a low_battery alarm is raised from the voltage code
  ✔ diagnostics: 0x8104 parameter query returns decoded 0x0104
  ✔ diagnostics: 0x8201 location query returns 0x0201 and stores a location
  ✔ every RX/TX frame is in the message log with raw hex, serial and checksum result
  ✔ a second connection with the same terminal ID replaces the first (§5.3)
  ✔ command to an offline device is refused and recorded as send_failed
▶ failure handling
  ✔ no operation reply -> command times out (never reported as success)
  ✔ keypad operation (unsolicited 0x55, cmdSRC keypad) never completes a pending platform command
  ✔ registration flow when authentication is rejected (AUTH_MODE=known_devices)
  ✔ commands are refused for sessions that have not authenticated
  ✔ malformed input never crashes the listener; bad checksum / garbage logged; valid frames still processed
  ✔ fragmented + coalesced frames over TCP are reassembled
  ✔ unknown message IDs are acknowledged with result 3 (not supported) and logged
  ✔ heartbeat timeout marks the device offline and closes the socket
ℹ tests 99  pass 99  fail 0    # unit+integration
ℹ tests 4   pass 4   fail 0    # PostgreSQL e2e (npm run test:e2e, db container up)
```

## Issues found and fixed during testing

| Issue | Fix |
|---|---|
| Test expectation for longitude hand-calculated wrongly (decoder correct) | test corrected (0x0499F2A8 = 77197992) |
| Race: a fast device reply could be processed before the command was registered, and a stale timer could later mark a completed command as timed out | command registered before the socket write; JT/T808 serial captured synchronously at write time; status not downgraded |
| Integration test assumed LockID known without a 0x0900 — server correctly refused | test now exercises LockID learning first (the behaviour is intended) |
| Test runner could hang when tests failed with open sockets | `--test-timeout` and `--test-force-exit` added |
| Postgres e2e: server shutdown closed the DB pool before disconnect processing finished ("Cannot use a pool after calling end") | listener `stop()` now waits for each session's disconnect handling |
| A keypad (local) operation reply could have been attached to a pending platform command by the type-based fallback | fallback restricted to replies with cmdSRC = platform; test added |
