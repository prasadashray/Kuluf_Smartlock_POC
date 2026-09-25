# Vendor Reference Investigation — Gitee `terry3/gwebmgr`

Date: 2026-09-26. Source: https://gitee.com/terry3/gwebmgr (repository + wiki), supplied by the vendor as a
supplementary reference. The wiki (84 pages) and repository were cloned read-only into a scratch folder outside this
project. **No code from the repository (GPL-2.0) has been copied into this project.**

Labels: **CONFIRMED** (stated in the vendor material) · **INFERRED** · **UNKNOWN** ·
**REQUIRES VENDOR CONFIRMATION** · **REQUIRES HARDWARE TEST**

---

## 1. Repository overview

| Finding | Label | Evidence |
|---|---|---|
| `gwebmgr` is the **web front end of the gps51.com GPS-tracking platform** (monitoring, device management, video) | CONFIRMED | `README.md`: "gps51.com 前端网页完整代码" |
| The full platform has 6+ parts: **device gateway**, application server + DB, video server, web front end, iOS/Android apps, WeChat mini-program; only the web front end is open-sourced | CONFIRMED | `README.md` 软件架构 |
| Server side is Java (Linux, Tomcat 7); front end is JavaScript/Vue | CONFIRMED | `README.md` |
| Supported device protocols: **JT/T 808 (2011/2013/2019)**, JT/T 1078 video, Su-standard ADAS, and several tracker brands (Goome, Concox, …) | CONFIRMED | `README.md` |
| TT808ELOCK / TT e-lock / seal-unseal is **not mentioned** anywhere in the README, wiki or front-end code | CONFIRMED (absence) | full-text search for 施封, 解封, 电子锁, 锁绳, ELOCK, TT808, 透传, 0x8900, 锁状态, lockstatus → no matches in platform code |
| License GPL-2.0 | CONFIRMED | `LICENSE` |
| Wiki = HTTP API documentation of the platform (not a device protocol document) | CONFIRMED | wiki tree (§2) |

## 2. Wiki / API documentation

API conventions (`API调用说明.md`), all CONFIRMED:
- Base URL: `https://api.yourdomain.com/openapi?action=<action>&token=<token>&serverid=<id>` — **"data-server domain,
  ask your service provider"**, i.e. each vendor/reseller runs its own instance.
- HTTP POST, JSON body, http or https.
- Login: `action=login` with username + **MD5 password**, `type` USER or DEVICE → `token` (24 h) + `serverid`.
- Limits: IP whitelist (≤5 changes/day), per account ≤ 1440 + 5 × paid devices calls/day, ≤10 requests/min per IP,
  history-track API ≤5 calls/device/day and "servers must not auto-sync tracks".
- Terms: the developer may restrict, suspend, charge for or terminate API access at any time without notice.

Relevant API groups:

| Group (wiki folder) | Actions | Relevance |
|---|---|---|
| 登录 login | `login`, `logout`, password-free login, share-track URL | account + token required |
| 设备列表 device list | `querymonitorlist`, `querydevicetypeownerbyuser` | devices have `deviceid` (global serial), `devicetype` (int), `simnum`, `overduetime`, `isfree` (expiry/disabled) |
| 添加设备 add device | `adddevice`, `editdevicesimple`, delete, device types | add by `deviceid` + `devicetype` (+ timezone, default 8) |
| 最后位置 last position | `lastposition` | lat/lon, speed, course, **`status` = raw JT/T808 status value**, `alarm` = raw JT/T808 alarm value + text, voltage, battery %, IO status |
| 轨迹回放 history | `querytracks` | rate-limited (5/device/day) |
| 查询报表 reports | `reportalarm` (alarm records, 64-bit alarm bits), trips, stops, fuel, etc. | generic tracker reports |
| 下发指令 commands | `sendcmd` with `cmdcode`: **锁车(断电断油) `TYPE_SERVER_LOCK_CAR`**, **解锁(恢复油电) `TYPE_SERVER_UNLOCK_CAR`** for 808 devices (`TYPE_SERVER_SET_RELAY_OIL` for GT06); `cmdpwd` fixed "zhuyi" | see §4 |
| 批量管理 batch | `batchoperate` sendcommand | same command model |
| 数据转发 forwarding | JSON forwarding of positions and alarms; **"raw message (原始报文) forwarding also supported"** (format undocumented) | see §7 |
| Other | fences, video, intercom, renewals (per-device yearly price), accounts, mini-programs | not relevant to the POC |

## 3. Device-management capabilities

| Capability | Label | Notes |
|---|---|---|
| Register a device on the platform (`adddevice`) | CONFIRMED | needs `deviceid` + `devicetype`; JT/T808 generic type is `devicetype = 1` |
| Device identification = `deviceid` ("device serial, globally unique"); for 808 devices the examples look like terminal phone numbers (`00006113323`) | INFERRED | would correspond to our JT/T808 **terminal ID**, not necessarily the LockID 82637294 |
| Device types carry per-type settings and **per-type command definitions** (admin actions `addcmd`, `editcmd`, `editdevicetypecmd`, `adddevicetype`) | CONFIRMED (front-end actions) | an operator could define custom commands for a lock device type — whether the vendor has done so for TT ELOCK is UNKNOWN |
| "JT/T808 additional-information definitions" admin page (`queryjt808add`, menu "部标附加定义") | CONFIRMED (front-end) | the platform can be taught custom 0x0200 extra items (e.g. TT 0xE7/0xE8) — whether it is configured for TT is UNKNOWN |
| Device subscription / expiry (`overduetime`, renewal prices) | CONFIRMED | platform use is paid per device |

## 4. Lock / unlock capabilities

| Question | Answer | Label |
|---|---|---|
| Do "锁车 / 解锁" mean e-lock seal/unseal? | **No.** The titles say 断电断油 / 恢复油电 = *cut / restore vehicle power and fuel* (immobiliser relay). GT06 variant is literally `SET_RELAY_OIL` | CONFIRMED |
| Which JT/T808 message does `TYPE_SERVER_LOCK_CAR` send? | not documented; typical implementations use 0x8500 vehicle control or 0x8105 terminal control | UNKNOWN |
| Is a TT e-lock Seal (0x8900 / 0x81 / 0x15 / 0x32 with LockID + Key) available via the API? | no documentation or code evidence | **REQUIRES VENDOR CONFIRMATION** |
| Can the API pass a seal key / password? | documented commands take `params: []` and a fixed `cmdpwd` "zhuyi" (platform command password, not a lock key) | CONFIRMED (for documented commands) |
| Command result reporting | `status` 0–8: 0 sent/unconfirmed, 2/3 offline (not) cached, **6 = sent and confirmed received**, 7 failed after 3 tries, 8 no confirmation within 60 s | CONFIRMED |
| Does the API return e-lock result codes (0x80 sealed, 0x93 wrong key, …)? | not documented; "confirmed received" is a delivery acknowledgement, equivalent to our 0x0001, **not** a lock operation result | CONFIRMED (not documented) |

**Consequence:** nothing in the vendor material shows that the vendor API can seal or unseal our lock, or report
the lock's operation result. The only documented seal/unseal mechanism remains the TT808ELOCK §10.2.1 command,
which we already implement directly.

## 5. Telemetry / location

| Capability | Label | Notes |
|---|---|---|
| Last position, speed, course, altitude, satellites, signal, voltage/battery % | CONFIRMED | `lastposition` |
| Raw JT/T808 `status` DWORD exposed | CONFIRMED | for a TT lock, bits 24–31 would carry LockStatus (our protocol notes §5) — **REQUIRES HARDWARE TEST** that the platform passes it unchanged |
| History tracks | CONFIRMED, heavily rate-limited | 5 calls/device/day; auto-sync forbidden |
| Timezone default GMT+8 | CONFIRMED | matches the TT device clock (H-07) |
| Lock status / motor status / seal state fields | not present | UNKNOWN whether stored |

## 6. Alarms

| Capability | Label | Notes |
|---|---|---|
| Alarm records (`reportalarm`): 64 alarm bits, text, start/last time, count, disposal status | CONFIRMED | generic JT/T808 alarm flags |
| TT e-lock alarms (0xE7 cable cut / emergency unlock / removal, 0x0900 SubCmd 02–05, LockStatus 7x) | not documented | REQUIRES VENDOR CONFIRMATION |
| Alarm push via forwarding (`devicealarm` object) | CONFIRMED | |

## 7. Vendor gateway architecture and data forwarding

```
Device ──JT/T808 TCP──► vendor gateway ──► gps51 application server + DB ──► HTTP API (token, IP whitelist)
                                                      │
                                                      ├─► HTTP JSON forwarding (positions, alarms)   [CONFIRMED]
                                                      ├─► "raw message" forwarding (format undocumented) [CONFIRMED exists, UNKNOWN format]
                                                      └─► JT/T 809 platform-to-platform forwarding     [CONFIRMED: forwarding settings
                                                          (uplink/downlink IP+port, M1/IA1/IC1, GNSS center ID)  have 809 fields]
```

The gateway is a separate, closed-source project. Whether it decodes the TT e-lock business layer is UNKNOWN.

## 8. Can the vendor API be used with our physical ELOCK?

| Question | Finding | Label |
|---|---|---|
| Can our device be registered on the vendor platform? | As a generic JT/T808 device (`devicetype = 1`) most likely yes, if it is pointed at the vendor's gateway | INFERRED — REQUIRES VENDOR CONFIRMATION |
| Is our model / TT808ELOCK supported as such? | No evidence | REQUIRES VENDOR CONFIRMATION |
| Location | Likely (0x0200 is standard JT/T808) | INFERRED |
| Seal / Unseal commands | No evidence; documented 锁车/解锁 are relay commands | REQUIRES VENDOR CONFIRMATION |
| Command results (e-lock result codes) | Not documented | REQUIRES VENDOR CONFIRMATION |
| Alarm information | Generic JT/T808 alarms yes; TT e-lock alarms unknown | INFERRED / UNKNOWN |
| Device status (lock state, battery) | battery/voltage yes; lock state only via raw status bits, if at all | INFERRED |
| Account / credential needed | Yes: platform account, MD5 password, token, IP whitelist, paid device subscription | CONFIRMED |
| Documented endpoint | Only the placeholder `api.yourdomain.com`; the actual domain must come from the service provider | CONFIRMED |
| Intended for third-party integration | Yes, but under restrictive, revocable terms and quotas | CONFIRMED |
| Does the lock currently report to a gps51-based platform? | Unknown; the fact that the vendor sent this link suggests it might | REQUIRES VENDOR CONFIRMATION |

**No claim is made that the vendor API can control our lock.** None of the above has been tested; we have no
account, domain or credentials.

## 9. Architecture options — evidence, not a decision

| | A. Direct TT808ELOCK to our TCP server (current) | B. Via vendor platform API | C. Both |
|---|---|---|---|
| Seal/Unseal with key | **Documented** (§10.2.1), implemented, simulator-tested | not documented | via A |
| Lock operation result codes (0x80/0x93/…) | **Documented**, implemented | not documented (delivery status only) | via A |
| Lock status, TT alarms | Documented (LockStatus, 0xE7/0xE8, 0x0900 uploads) | not documented | via A |
| Location / basic alarms | yes | yes (rate-limited) | either |
| Raw protocol evidence for validation | full | none (raw forwarding format unknown) | A |
| Dependencies | public server + device reconfiguration | vendor account, domain, whitelist, subscription, API terms | both |
| Control over availability | ours | revocable by vendor at any time | mixed |
| Blocker today | how to point the device at our server | vendor confirmation of e-lock support + credentials | both |

Evidence-based recommendation (no architecture change made):
- **Keep A as the primary path.** It is the only path with documented seal/unseal, key handling and result codes.
- **B is useful in two narrower ways, subject to vendor answers:** (1) if the lock currently reports to a
  vendor-run gps51 instance, that platform is the most likely way to **re-point the lock** to our server (JT/T808
  0x8103 params 0x0013/0x0018, or 0x8105 command 2); (2) its JSON/raw forwarding could feed us telemetry while
  commands stay with the vendor — only worthwhile if the vendor confirms e-lock command support.
- **C** (vendor platform keeps the device, we consume API + forwarding) would need the vendor to confirm seal/unseal
  via API with lock result codes. A JT/T808 terminal connects to one main server (plus a backup address), so the
  device cannot normally be connected to both platforms at once.

## 10. Unknowns

1. Whether the lock currently connects to a gps51-based vendor server, and its domain/IP/port.
2. Whether the vendor's gps51 instance has a TT ELOCK device type with seal/unseal commands, and what they send.
3. Whether API command results include the lock's 0x55 result code.
4. Format of "raw message" forwarding, and whether it includes 0x0900 e-lock business frames.
5. Whether the platform keeps LockStatus (status bits 24–31) and TT alarm items.
6. API domain, credentials, pricing for our device.

## 11. Questions for the vendor

Consolidated, with Chinese translations, in `docs/VENDOR_QUESTIONS.md` (§B covers this investigation).
