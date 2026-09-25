# Session Handoff

Date: 2026-09-26. This records exactly where work stopped so the next agent can resume without the chat history.

## Where the previous agent stopped
Finished building the full POC against the simulator (protocol, server, DB, API, dashboard, tests), investigated the
vendor Gitee reference, ran a read-only BLE session against the physical lock, produced the vendor question set as
Markdown + a bilingual Word form, and then created this documentation checkpoint. Stopped **before** the physical lock
was connected to our TCP server (that is blocked on external items, §"First when resuming").

## Last successful actions (with evidence)
- `npm --prefix server test` → 99/99 pass; `npm --prefix server run test:e2e` → 4/4 pass (db container up).
- Live simulated end-to-end run via `tools/e2e-api-check.mjs` (see `docs/TEST_RESULTS.md` for the captured output).
- Read-only BLE monitor decoded a real keypad unlock on the lock: evidence
  `docs/evidence/2026-09-26_ble_keypad_unlock_test.jsonl` (result codes 0x70 then 0x90, source keypad).
- Generated `docs/VENDOR_QUESTIONS.docx` (verified rendered via Word→PDF, Chinese renders correctly).

## Last failed / blocked actions
- Could not run the PostgreSQL e2e test earlier in the session because starting the db container was initially blocked;
  later the user approved it and the tests pass. No current failure.
- The skill helper `scripts/office/soffice.py` fails on Windows (uses AF_UNIX). Worked around by exporting the docx to
  PDF with Microsoft Word via COM, then rendering with PyMuPDF. LibreOffice is **not** installed; `pdftoppm` is not on
  PATH (use `python -c "import pymupdf..."` to render PDFs).

## Current error messages
None outstanding. (Historical, now fixed: "Cannot use a pool after calling end on the pool" during platform shutdown —
fixed by making the listener wait for disconnect handling; see KNOWN_ISSUES resolved list.)

## What was being attempted immediately before stopping
Creating this persistent handoff document set and the checkpoint git commit.

## What to do FIRST when development resumes
1. Confirm the two external blockers with the user: (a) is the cloud VM ready with a static public IP and TCP 6808 open
   (`docs/DEPLOYMENT.md`), and (b) have the vendor answered A1–A5 in `docs/VENDOR_QUESTIONS.md` (how to point the lock
   at our server, and how to open it if a remote unseal fails)?
2. If neither is ready, there is no physical progress to make; do simulator/UI polish or await input — do not rebuild
   what already works.
3. When the endpoint is ready: deploy per `docs/DEPLOYMENT.md`, keep capture on, let the lock connect, and capture the
   first packets **read-only**. Then `POST /api/devices/:id/diagnostics/query-params` to record original config before
   any command.

## What should NOT be repeated / redone
- Do not re-implement the protocol library, simulator, services, DB, API, or dashboard — they exist and pass tests.
- Do not re-derive the LEN/CRC candidate machinery; it is in `server/src/protocol/tt-elock.js` and logs matches.
- Do not re-run the vendor Gitee investigation; conclusions are in `docs/VENDOR_REFERENCE.md`.
- Do not guess-write to the lock over BLE (undocumented) or send commands to the physical lock without user go-ahead.
- Do not change the compose project name away from `kuluf-smartlock-poc` (a separate `indialock-connect-poc` project
  exists on this machine and must not be touched).

## Temporary workarounds currently in use
- Business-frame LEN/CRC and Key format are **configured guesses** in `server/src/config/index.js`
  (`BIZ_LEN_MODE=after_len`, `BIZ_CRC_ALGO=crc8_maxim`, `BIZ_CRC_RANGE=from_len`, `BIZ_CRC_ENFORCE=false`,
  `DEFAULT_KEY_FORMAT=rf10`). These are unverified on hardware; the decoder records which candidates actually match.
- PDF rendering uses Word COM + PyMuPDF instead of the skill's LibreOffice helper.

## Assumptions still needing verification
- LEN semantics (DOC-06), CRC algorithm (DOC-07) — REQUIRES HARDWARE TEST (first real 0x0900).
- This lock's Key encoding for the 8-digit keypad password — REQUIRES VENDOR CONFIRMATION / HARDWARE TEST.
- Keypad unseal reporting LockStatus 0x60 vs the expected 0xBx — candidate discrepancy, verify over TCP.
- Device timezone GMT+8 (protocol + BLE agree) applied to TCP times — REQUIRES HARDWARE TEST.
- Dashboard visual correctness in a browser.

## Commands to reproduce the current state
```bash
cd /c/Users/SmartSkale/Desktop/Kuluf_Smartlock_POC
docker compose up -d db                 # PostgreSQL on 127.0.0.1:5433 (project kuluf-smartlock-poc)
npm --prefix server run migrate         # idempotent
npm --prefix server test                # 99 pass
npm --prefix server run test:e2e        # 4 pass (needs db)
# live simulated demo:
DB_ENABLED=false CAPTURE_FILE=captures/demo.jsonl node server/src/index.js &   # capture-only, in-memory
node simulator/simulate-device.js --device-id 000099990001 --lock-id 99990001 --simulate-location --lock-upload-interval 15 --exit-after 40 &
node tools/e2e-api-check.mjs http://127.0.0.1:3000/api 000099990001
# read-only physical BLE monitor (lock nearby):
python tools/ble/ble_monitor.py
```
