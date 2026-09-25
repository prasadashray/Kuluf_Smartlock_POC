"""Live, read-only BLE monitor for the TT ELOCK.

Connects to the lock, subscribes to its notify characteristic and prints every frame decoded with the TT808ELOCK
field tables (LockID per Appendix 0, Voltage per Appendix 0, LockStatus per Appendix 3, BCD time in GMT+8).
Never writes to the lock. Raw frames are appended to captures/ble-monitor-<date>.jsonl.

Frame layouts are INFERRED from captured frames (docs/PROTOCOL_NOTES.md §9, docs/HARDWARE_VALIDATION.md):
    status: 01 | 0E | 01     | LockID(4) | Batt? | LockStatus | MotoStatus |          BCD time(6) | CRC-8/MAXIM
    event:  01 | 0F | Result | LockID(4) | Batt? | LockStatus | MotoStatus | cmdSRC | BCD time(6) | CRC-8/MAXIM
Result / cmdSRC codes match TT808ELOCK Appendix 1 / §10.2.1 (e.g. 0x90 unseal success, cmdSRC 0x02 keypad).
Frames that do not match are printed raw.

Usage:  python tools/ble/ble_monitor.py [--name 82637294 | --address DD:78:A9:81:04:A4] [--seconds N]
"""
import argparse, asyncio, datetime, json, pathlib, sys
from bleak import BleakClient, BleakScanner

NOTIFY_UUID = "00000003-0000-1000-8000-00805f9b34fb"
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
GMT8 = datetime.timezone(datetime.timedelta(hours=8))
ROOT = pathlib.Path(__file__).resolve().parents[2]

LOCK_STATES = {0x1: "Open", 0x2: "Standby", 0x3: "Not closed properly", 0x4: "Sealed (platform)",
               0x5: "Sealed (local)", 0x6: "Unsealed (platform)", 0xB: "Unsealed (local)", 0x7: "ALARM",
               0x8: "ALARM (local)", 0x9: "Alarm released", 0xA: "Abnormal"}
ALARM_BITS = {0: "lock rod cut", 1: "opened", 2: "shell removed", 3: "knob damaged"}
RESULTS = {0x80: "Seal success", 0x81: "Repeat seal", 0x82: "Not locked properly, seal failed", 0x83: "Voltage too low",
           0x84: "Housing opened, not sealed", 0x85: "Emergency unlock, not sealed", 0x86: "Rod cut, not sealed",
           0x87: "Rod open, not sealed", 0x89: "Seal timeout", 0x90: "Unseal success", 0x91: "Repeat unseal",
           0x92: "Lock open when unsealing", 0x93: "Key mismatch", 0x94: "Housing opened, not unsealed",
           0x95: "Emergency unlock, not unsealed", 0x96: "Open alarm, not unsealed", 0x97: "Unseal without seal",
           0x98: "Cut alarm, not unsealed", 0x99: "Unseal timeout", 0x70: "Alarm release success",
           0x71: "Alarm release timeout", 0x72: "Not in alarm state", 0x73: "Key mismatch, alarm not released",
           0x74: "Housing opened, alarm not released", 0x75: "Emergency unlock, alarm not released"}
SOURCES = {0x00: "SMS", 0x01: "automatic", 0x02: "keypad", 0x03: "handheld", 0x04: "platform", 0x05: "checkpoint", 0x06: "IC card"}
VOLTAGES = {0x30: "3.3 V critical", 0x31: "3.6 V low", 0x32: "3.7 V", 0x33: "3.8 V", 0x34: "3.9 V",
            0x35: "4.0 V", 0x36: "4.1 V", 0x37: "4.2 V full"}


def crc8_maxim(data):
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8C if crc & 1 else crc >> 1
    return crc


def lock_status(code):
    hi, lo = code >> 4, code & 0x0F
    label = LOCK_STATES.get(hi, f"unknown 0x{code:02X}")
    if hi in (0x7, 0x8):
        bits = [v for b, v in ALARM_BITS.items() if lo >> b & 1]
        if bits:
            label += " (" + ", ".join(bits) + ")"
    return label


def bcd_time(b):
    s = b.hex()
    try:
        t = datetime.datetime(2000 + int(s[0:2]), int(s[2:4]), int(s[4:6]), int(s[6:8]), int(s[8:10]), int(s[10:12]), tzinfo=GMT8)
        return s, t
    except ValueError:
        return s, None


def decode(frame):
    out = {"hex": frame.hex().upper()}
    if len(frame) < 4:
        return out
    out["crc_ok"] = crc8_maxim(frame[:-1]) == frame[-1]
    out["type"] = f"0x{frame[0]:02X}"
    out["len_ok"] = frame[1] == len(frame) - 3
    p = frame[2:-1]
    if frame[0] == 0x01 and len(p) in (14, 15):
        event = len(p) == 15
        hi, lo = int.from_bytes(p[1:3], "big"), int.from_bytes(p[3:5], "big")
        raw, t = bcd_time(p[9:15] if event else p[8:14])
        if event:
            out.update({
                "event_code": f"0x{p[0]:02X}",
                "event": RESULTS.get(p[0], "unknown code"),
                "source": f"0x{p[8]:02X} {SOURCES.get(p[8], 'other')}",
            })
        out.update({
            "sub": f"0x{p[0]:02X}",
            "lock_id": f"{hi:04d}{lo:04d}" if hi <= 9999 and lo <= 9999 else p[1:5].hex(),
            # 2026-09-26: this byte read 0x37 at 00:46 IST and 0x23 at 02:07 IST. 0x23 is not a documented voltage
            # code, so the field may be battery percent (55 -> 35). Both readings are shown until confirmed.
            "voltage": f"0x{p[5]:02X} = {VOLTAGES[p[5]]}" if p[5] in VOLTAGES else f"0x{p[5]:02X} = {p[5]}% ?",
            "lock_status_code": f"0x{p[6]:02X}",
            "lock_status": lock_status(p[6]),
            "motor": f"0x{p[7]:02X}",
            "device_time_raw": raw,
            "device_time_ist": t.astimezone(IST).strftime("%H:%M:%S") if t else None,
        })
    return out


async def run(args):
    log_path = ROOT / "captures" / f"ble-monitor-{datetime.date.today().isoformat()}.jsonl"
    log_path.parent.mkdir(exist_ok=True)
    log = open(log_path, "a", encoding="utf-8")
    print(f"logging to {log_path}")
    deadline = None if not args.seconds else asyncio.get_event_loop().time() + args.seconds
    last_status = None

    def on_notify(_, data):
        nonlocal last_status
        now = datetime.datetime.now(IST)
        d = decode(bytes(data))
        log.write(json.dumps({"host_time": now.isoformat(), **d}) + "\n")
        log.flush()
        if "event" in d:
            print(f"{now:%H:%M:%S} EVENT {d['event_code']} {d['event']:<24} source {d['source']:<12} "
                  f"status now {d['lock_status_code']} {d['lock_status']}  lock-clock {d['device_time_ist']} IST  "
                  f"crc {'ok' if d['crc_ok'] else 'BAD'}", flush=True)
            last_status = d["lock_status_code"]
        elif "lock_status" in d:
            changed = d["lock_status_code"] != last_status
            mark = "  <== STATUS CHANGED" if changed and last_status is not None else ""
            last_status = d["lock_status_code"]
            print(f"{now:%H:%M:%S} lock {d['lock_id']}  status {d['lock_status_code']} {d['lock_status']:<22} "
                  f"battery byte {d['voltage']:<18} motor {d['motor']}  lock-clock {d['device_time_ist']} IST  "
                  f"crc {'ok' if d['crc_ok'] else 'BAD'}{mark}", flush=True)
        else:
            print(f"{now:%H:%M:%S} OTHER FRAME {d['hex']}  crc_ok={d.get('crc_ok')}  <== new frame type, please report", flush=True)

    while deadline is None or asyncio.get_event_loop().time() < deadline:
        dev = (await BleakScanner.find_device_by_address(args.address, timeout=20) if args.address
               else await BleakScanner.find_device_by_name(args.name, timeout=20))
        if not dev:
            print("lock not found over BLE - is it awake and within range? retrying...", flush=True)
            continue
        try:
            async with BleakClient(dev, timeout=30) as client:
                print(f"connected to {dev.address} ({args.name}); watching - operate the lock now. Ctrl+C to stop.", flush=True)
                await client.start_notify(NOTIFY_UUID, on_notify)
                while client.is_connected and (deadline is None or asyncio.get_event_loop().time() < deadline):
                    await asyncio.sleep(1)
                if not client.is_connected:
                    print("BLE connection dropped, reconnecting...", flush=True)
        except Exception as e:  # keep monitoring through transient BLE errors
            print(f"BLE error: {e}; reconnecting...", flush=True)
            await asyncio.sleep(2)
    log.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", default="82637294")
    ap.add_argument("--address")
    ap.add_argument("--seconds", type=float, default=0, help="stop after N seconds (0 = until Ctrl+C)")
    try:
        asyncio.run(run(ap.parse_args()))
    except KeyboardInterrupt:
        print("stopped")
        sys.exit(0)
