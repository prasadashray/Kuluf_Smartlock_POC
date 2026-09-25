import asyncio, json, sys
from bleak import BleakScanner

DURATION = float(sys.argv[1]) if len(sys.argv) > 1 else 20.0

async def main():
    seen = {}
    def cb(dev, adv):
        e = seen.setdefault(dev.address, {"address": dev.address, "names": set(), "rssi": [], "services": set(), "mfr": {}, "svc_data": {}})
        if adv.local_name: e["names"].add(adv.local_name)
        if dev.name: e["names"].add(dev.name)
        e["rssi"].append(adv.rssi)
        e["services"].update(adv.service_uuids or [])
        for k, v in (adv.manufacturer_data or {}).items():
            e["mfr"][f"0x{k:04X}"] = v.hex()
        for k, v in (adv.service_data or {}).items():
            e["svc_data"][k] = v.hex()
    scanner = BleakScanner(cb)
    await scanner.start()
    await asyncio.sleep(DURATION)
    await scanner.stop()
    rows = []
    for a, e in seen.items():
        rows.append({
            "address": a,
            "names": sorted(e["names"]),
            "rssi_max": max(e["rssi"]),
            "services": sorted(e["services"]),
            "mfr": e["mfr"],
            "svc_data": e["svc_data"],
        })
    rows.sort(key=lambda r: -r["rssi_max"])
    print(json.dumps(rows, indent=1))

asyncio.run(main())
