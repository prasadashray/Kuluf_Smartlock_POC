"""Read-only GATT enumeration. Never writes to the device.
Subscribes to notify characteristics briefly (enabling CCCD is a standard, non-persistent client action)
only if --listen is given."""
import asyncio, sys, json, datetime
from bleak import BleakClient, BleakScanner

ADDR = sys.argv[1] if len(sys.argv) > 1 else "DD:78:A9:81:04:A4"
LISTEN = "--listen" in sys.argv

def show(b):
    if b is None:
        return None
    try:
        s = b.decode("ascii")
        printable = all(32 <= c < 127 for c in b)
    except Exception:
        s, printable = None, False
    return {"hex": b.hex(), "ascii": s if printable else None, "len": len(b)}

async def main():
    dev = await BleakScanner.find_device_by_address(ADDR, timeout=20)
    if not dev:
        print("device not found"); return
    async with BleakClient(dev, timeout=30) as c:
        print("connected:", c.is_connected, "mtu:", getattr(c, "mtu_size", None))
        out = []
        notifiable = []
        for svc in c.services:
            s = {"service": svc.uuid, "desc": svc.description, "chars": []}
            for ch in svc.characteristics:
                entry = {"uuid": ch.uuid, "handle": ch.handle, "desc": ch.description, "props": ch.properties}
                if "read" in ch.properties:
                    try:
                        entry["value"] = show(await c.read_gatt_char(ch))
                    except Exception as e:
                        entry["read_error"] = str(e)
                if "notify" in ch.properties or "indicate" in ch.properties:
                    notifiable.append(ch)
                entry["descriptors"] = []
                for d in ch.descriptors:
                    de = {"uuid": d.uuid, "handle": d.handle, "desc": d.description}
                    try:
                        de["value"] = show(await c.read_gatt_descriptor(d.handle))
                    except Exception as e:
                        de["read_error"] = str(e)
                    entry["descriptors"].append(de)
                s["chars"].append(entry)
            out.append(s)
        print(json.dumps(out, indent=1))
        if LISTEN and notifiable:
            def h(sender, data):
                print(datetime.datetime.now().isoformat(), "NOTIFY", sender, show(bytes(data)))
            for ch in notifiable:
                try:
                    await c.start_notify(ch, h)
                    print("subscribed", ch.uuid)
                except Exception as e:
                    print("subscribe failed", ch.uuid, e)
            await asyncio.sleep(20)

asyncio.run(main())
