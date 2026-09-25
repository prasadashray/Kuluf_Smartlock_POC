# Test Plan

| Level | Location | Runs with | Needs |
|---|---|---|---|
| Unit (protocol) | `server/tests/unit/*.test.js` | `npm test --workspace server` | nothing |
| Integration (simulator ↔ TCP ↔ services ↔ store ↔ API) | `server/tests/integration/*.test.js` | `npm test --workspace server` | nothing (in-memory store, random ports) |
| End-to-end with PostgreSQL | `server/tests/e2e/postgres.test.js` | `npm run test:e2e --workspace server` | `docker compose up -d db`, `DATABASE_URL` (skips otherwise) |
| Live simulated run | server process + `simulator/simulate-device.js` + `tools/e2e-api-check.mjs` | see README | nothing / DB optional |
| Dashboard | manual, `npm run dashboard` | browser | server running |
| Hardware | `docs/HARDWARE_VALIDATION.md` matrix | manual with the physical lock | public endpoint + device configuration |

## Unit tests (protocol)

| Area | Cases |
|---|---|
| Escaping | §4.4.2 worked example both ways; all 256 byte values round-trip; consecutive specials; invalid escapes rejected |
| Checksum | hand-calculated heartbeat frame (0x04); checksum byte that itself needs escaping; bad checksum rejected with header still reported |
| Header | properties bit layout; terminal ID BCD example; non-BCD nibbles preserved; sub-packet item |
| Framing | one frame; several frames per read; split at every byte boundary; byte-by-byte; garbage before/between frames; shared delimiter; oversize resync |
| BCD / WORD / DWORD / STRING | range checks; BCD time GMT+8 and custom offset; hardware BLE timestamp; invalid/zero times; GBK decode |
| LockID / Key / Bill / LineCode | Appendix 0 example; the sample's LockID `20471C7E`; rf10 example `04D20008AA52`; ascii6; validation |
| Seal / Unseal / Clear alarm | CN §10.2.1 example reproduced byte-for-byte; unseal/clear-alarm bytes |
| Operation reply | CN legacy example decoded; A13 round-trip incl. operation identifier; all result codes → command/outcome |
| Business frame | downlink/uplink round-trip; GPS+LBS additional info; LockID containing 0x23; LEN/CRC evidence recording; CRC-8/MAXIM vs BLE captures; malformed input |
| Location | known-value decode (lat/lon/speed/dir/time/alarms/lock status); hemispheres; TT additional items E7/E8/E9/56/5D/E6/30/31; truncated TLV |
| Messages | 0x8001/0x0001, 0x0100/0x8100, 0x0102 factory code, 0x8103 time param, 0x0104 decode, 0x0900 passthrough, text, unknown IDs |

## Integration tests

Connection + factory authentication; time calibration; heartbeat ack; location history; LockID never guessed;
LockID learned from 0x0900; Seal 0x80 (+ key stored); repeat seal 0x81; unseal wrong key 0x93; unseal 0x90;
202 "sent" is not success; unseal of unsealed lock 0x97; tamper → three alarm sources, seal refused 0x86, clear
alarm 0x70, alarms cleared with history; clear alarm 0x72; low battery 0x83 + low_battery alarm; 0x8104/0x0104;
0x8201/0x0201; message log completeness; duplicate connection replaces old; reconnect; offline command refused and
recorded; command timeout (ack alone ≠ success); registration flow (`known_devices`); unauthenticated session
refused; malformed input (garbage, bad checksum, bad escape, short) survives; fragmented + coalesced TCP; unknown
message → result 3; heartbeat timeout → offline.

## End-to-end with PostgreSQL

Migrations in a throw-away schema; device persisted; location + lock upload + seal/unseal; tamper + clear alarm;
`message_log`/`locations` UPDATE/DELETE rejected by triggers.

## Hardware

See `docs/HARDWARE_VALIDATION.md` §4 (TEST-HW-000 … TEST-HW-021) and the acceptance criteria in the master
instructions §38. The POC is not declared successful on simulator results.
