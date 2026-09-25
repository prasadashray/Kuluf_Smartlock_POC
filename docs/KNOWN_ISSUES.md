# Known Issues

Labels: CONFIRMED / INFERRED / UNKNOWN / HARDWARE-SPECIFIC / REQUIRES VENDOR CONFIRMATION / REQUIRES HARDWARE TEST.

## Open — protocol uncertainties (must be resolved on real hardware)
| ID | Issue | Impact | Status | Where |
|---|---|---|---|---|
| DOC-06 | Business-frame LEN byte semantics not specified | Wrong LEN may make the lock reject Seal/Unseal | UNKNOWN, REQUIRES HARDWARE TEST | `server/src/protocol/tt-elock.js`, config `BIZ_LEN_MODE` |
| DOC-07 | Business-frame CRC algorithm/coverage not specified | Wrong CRC → lock rejects our commands | UNKNOWN, REQUIRES HARDWARE TEST. Default `crc8_maxim/from_len` inferred from BLE (H-06) | config `BIZ_CRC_ALGO`/`BIZ_CRC_RANGE`/`BIZ_CRC_ENFORCE` |
| KEY-01 | Lock keypad password is 8 digits; protocol Key is 6 bytes (rf10=10 digits / ascii6=6 digits). This lock's encoding unknown | Unseal may fail with 0x93 | UNKNOWN, REQUIRES VENDOR CONFIRMATION / HARDWARE TEST | `docs/HARDWARE_VALIDATION.md` §2 |
| DOC-11 | 0x61 "normal reply" to lock uploads vs "no reply" ambiguity | Possible device retransmissions | UNKNOWN | config `BIZ_REPLY_TO_LOCK_UPLOAD` (default off) |
| TZ-01 | Device times are GMT+8 (protocol + BLE agree); applied via offset | Wrong times if a unit differs | INFERRED, REQUIRES HARDWARE TEST over TCP | config `DEVICE_TZ_OFFSET_MINUTES=480` |

## Open — hardware uncertainties
| ID | Issue | Status | Where |
|---|---|---|---|
| HW-A | Lock has never connected to our TCP server | REQUIRES HARDWARE TEST | blocker (endpoint + vendor) |
| HW-B | Terminal ID (JT/T808 header) of this lock unknown; relation to LockID 82637294 unknown | UNKNOWN | first TCP frame |
| HW-C | Auth code the lock will present unknown (likely ICCID+version) | UNKNOWN | first 0x0102 |
| HW-D | Keypad unseal reported LockStatus 0x60, Appendix 3 suggests 0xBx "local unsealed" | Candidate discrepancy, REQUIRES HARDWARE TEST | `docs/HARDWARE_VALIDATION.md` TEST-HW-022 obs.2 |
| HW-E | Why a keypad unseal also reports 0x70 "alarm released" | UNKNOWN | BLE capture |
| HW-F | "Battery" byte in BLE frames read 0x37 then 0x23 (0x23 not a valid voltage code; maybe %) | UNKNOWN | `tools/ble/ble_monitor.py`, evidence jsonl |
| HW-G | 7B vs 4G hardware variant (affects LBS item 0xE1 vs 0x5D) | UNKNOWN (4G inferred from Airtel 4G SIM) | first 0x0200 |
| HW-H | Whether Airtel SIM has active data / correct APN | UNKNOWN | connection attempt |

## Open — vendor uncertainties
| ID | Issue | Status |
|---|---|---|
| VEN-A | How to set the lock's server address/APN | REQUIRES VENDOR CONFIRMATION (VENDOR_QUESTIONS A1–A4) |
| VEN-B | Recovery path if remote unseal fails after a platform seal | REQUIRES VENDOR CONFIRMATION (A5) — safety-critical |
| VEN-C | Whether the vendor gps51 API supports TT e-lock seal/unseal with result codes | REQUIRES VENDOR CONFIRMATION (C1); current evidence says no |
| VEN-D | BLE command (write) protocol | UNKNOWN, REQUIRES VENDOR CONFIRMATION (C5) — do not guess-write |

## Open — environment / tooling
| ID | Issue | Workaround |
|---|---|---|
| ENV-A | LibreOffice not installed; skill's `soffice.py` helper is Unix-only (AF_UNIX) | Export docx→PDF via Word COM, render with PyMuPDF (`python -c "import pymupdf..."`) |
| ENV-B | `pdftoppm` not on PATH | Use PyMuPDF to rasterise PDFs |
| ENV-C | Native PostgreSQL on :5432 (unknown credentials) | POC uses its own Docker Postgres on :5433; do not touch :5432 |
| ENV-D | A separate `indialock-connect-poc` Docker project exists (earlier SSLockPOC) | Our project is `kuluf-smartlock-poc`; never run compose in the other folder from here |
| ENV-E | Stray Word lock file `docs/~$NDOR_QUESTIONS.docx` appears while the docx is open in Word | Git-ignored via `~$*`; close Word before committing if it reappears |

## Failed approaches (do not repeat)
- Starting `docker compose` under the default project name replaced the older project's stopped `db` container. Fixed by
  renaming the project to `kuluf-smartlock-poc`. Do not revert the name.
- The earlier SSLockPOC implementation was reviewed and **not reused**: it omits the §10.1 business envelope, encodes the
  LockID as a plain 32-bit int (hardware shows the per-4-digit Appendix 0 encoding), and treats device time as UTC
  (protocol + hardware say GMT+8). See DECISIONS D-26.

## Resolved this session (for context; do not redo)
- Race where a fast device reply could be processed before the command was registered, and a stale timer could downgrade
  a completed command → fixed in `command-service.js` (register before write; capture serial synchronously).
- Platform shutdown closed the DB pool before disconnect handling finished ("Cannot use a pool after calling end") →
  fixed by having the listener await each session's disconnect processing.
- Type-based reply correlation could attach a keypad/local operation reply to a pending platform command → restricted to
  replies with cmdSRC = platform; regression test added.
