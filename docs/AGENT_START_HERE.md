# AGENT — START HERE

**You are continuing an existing IndiaLock Connect project. Do not start from scratch.**

This file is a bootstrap for a new coding agent that has **no access to the previous conversation**. The repository is
the source of truth, not any chat history.

- **Do not restart completed work merely because you do not have the previous conversation.**
- **Do not invent missing context.**
- **Do not change the architecture without evidence.**
- **Do not perform destructive physical lock operations** (seal, unseal, factory reset, firmware update, server-address
  change) **without explicit user confirmation.** See §12.
- **This document may be stale. Verify it** (§13) before trusting any claim.

---

## 1. What this project is
A Proof of Concept ("IndiaLock Connect", internal repo name `Kuluf_Smartlock_POC`, vendor-facing brand "SmartSkale")
for a **physical TT ELOCK** electronic cargo lock that speaks the **TT808ELOCK protocol = JT/T808-2013 + TT A13 e-lock
extension**. The lock is the TCP **client**; our platform is the TCP **server**.

## 2. What the POC must accomplish
Prove we can, with the **real physical lock**: connect, identify, authenticate, keep online (heartbeat), receive
location/telemetry/lock-status/battery/alarms, and remotely **Seal / Unseal / Clear alarm** with correct result codes,
storing everything (telemetry, events, commands, raw protocol log) in a database with an inspectable UI. The simulator
exists only to accelerate development; **the POC is not "done" on simulator results alone.**

## 3. Current architecture (unchanged, evidence-backed — see docs/VENDOR_REFERENCE.md)
`Lock ──TCP (TT808ELOCK)──► Node TCP listener → protocol library → command + telemetry services → PostgreSQL → REST API (Express) → React dashboard`.
A vendor HTTP-API platform (gps51) exists but shows **no evidence of e-lock seal/unseal support**, so the direct TCP
path stays primary. Details: `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (D-01, D-27).

## 4. Current implementation status (verify per §13)
- **Protocol library** `server/src/protocol/` — CONFIRMED working (72 unit tests). Framing, escaping, XOR checksum,
  header, 0x0200 location, TT e-lock business layer, all POC message types.
- **Simulator** `simulator/` — CONFIRMED working, uses the same protocol library.
- **TCP listener + services + PostgreSQL + REST API** `server/src/` — CONFIRMED working end-to-end against the
  simulator (27 integration tests + 4 PostgreSQL e2e tests).
- **Dashboard** `dashboard/` — builds and serves; **not visually verified in a browser**.
- **Docker images** build; only the `db` service has been run.
- **Physical lock over BLE** — read-only status monitoring CONFIRMED (`tools/ble/ble_monitor.py`).

## 5. What has already been PROVEN
- The lock's displayed ID **82637294 is the LockID** (its BLE frames encode it exactly as protocol Appendix 0 says).
- Over BLE, a **keypad unlock** produced protocol-conformant result codes (0x90 unseal success), source (keypad),
  and lock-status codes — real-hardware evidence the firmware uses A13 semantics. Evidence:
  `docs/evidence/2026-09-26_ble_keypad_unlock_test.jsonl`.
- The full simulated pipeline (connect → auth → heartbeat → location → seal/unseal/clear-alarm with correct result
  codes → DB → API) works.

## 6. What has NOT been proven
- The lock has **never connected to our TCP server** (no mobile-network path yet).
- Business-frame **LEN semantics and CRC algorithm** are unconfirmed on hardware (UNKNOWN — DOC-06/07). Defaults are
  best guesses; the decoder records which candidates match so the first real 0x0900 settles it.
- The **Key encoding** for this lock (8-digit keypad password vs 6-byte protocol Key) is UNKNOWN.
- Remote Seal/Unseal has never run against the physical lock.

## 7. Current blockers
1. **No public endpoint yet.** Decision made: cloud VM with static IP (`docs/DEPLOYMENT.md`). Waiting for the VM.
2. **No known method to point the lock at our server.** Needs vendor answers A1–A5 in `docs/VENDOR_QUESTIONS.md`.

## 8. What to read first (in order)
1. This file. 2. `docs/PROJECT_STATE.md`. 3. `docs/SESSION_HANDOFF.md`. 4. `docs/NEXT_STEPS.md`.
5. `docs/PROTOCOL_NOTES.md` + `docs/HARDWARE_VALIDATION.md`. 6. `docs/DECISIONS.md` + `docs/KNOWN_ISSUES.md`.
7. `README.md`. The two protocol PDFs are in `Technical Docs/` (Chinese A13 original is authoritative for bytes).

## 9. What to inspect in the repository
`server/src/protocol/` (the codec), `server/src/services/` (handler, command, telemetry), `server/tests/`,
`server/src/config/index.js` (every unverified protocol choice is a setting here), `simulator/device.js`,
`tools/ble/`, `captures/` (raw traffic evidence, git-ignored).

## 10. Exact first actions when you resume
Remote: `origin` = https://github.com/prasadashray/Kuluf_Smartlock_POC.git (branch `main`).
```bash
git -C /c/Users/SmartSkale/Desktop/Kuluf_Smartlock_POC log --oneline -3   # confirm the checkpoint commit
git -C /c/Users/SmartSkale/Desktop/Kuluf_Smartlock_POC remote -v          # confirm origin = the GitHub repo
docker ps | grep kuluf                                                     # is the db up?
docker compose up -d db                                                    # if not
npm --prefix server test                                                   # expect 99 pass (unit+integration)
npm --prefix server run test:e2e                                           # expect 4 pass if db up, else skipped
```
Then read §8 docs and confirm the blockers in §7 are still current with the user.

## 11. Immediate next milestone
Get the physical lock to connect to our TCP server (cloud VM + vendor server-address change), capture the **first real
packets read-only**, and read back the device's original configuration (`POST /api/devices/:id/diagnostics/query-params`)
**before sending any command**. Then the safe hardware test order in `docs/HARDWARE_VALIDATION.md` §"Safe order".

## 12. Rules for physical hardware
- Never send Seal/Unseal/Clear-alarm/reset/firmware/server-change to the physical lock without explicit user go-ahead.
- Before the **first remote Seal**, confirm with the user how the lock can be opened if remote Unseal fails (vendor A5):
  after a platform seal the keypad password may stop working.
- BLE: **read-only** only. The BLE command (write) format is undocumented; do not write to the lock over BLE.
- Preserve original device configuration; capture state before changing anything.

## 13. Verify before you trust
This document and the others may lag the code. Cross-check against: **actual source code**, `git status`,
`npm --prefix server test`, `captures/*.jsonl` and server logs, `server/src/config/index.js`, the `Technical Docs/`
PDFs, and the physical lock where available. If a doc and the code disagree, the code wins — fix the doc.

## 14. Distinguishing fact from assumption
Labels used across the docs: **CONFIRMED** (docs or hardware), **INFERRED**, **UNKNOWN**, **HARDWARE-SPECIFIC**,
**REQUIRES VENDOR CONFIRMATION**, **REQUIRES HARDWARE TEST**. Do not upgrade a label without new evidence; when you add
findings, cite the file/log that proves them.
