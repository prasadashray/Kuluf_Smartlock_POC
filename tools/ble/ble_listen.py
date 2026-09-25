"""Passive BLE listener: subscribes to the lock's notify characteristic and logs frames. Never writes."""
import asyncio, sys, datetime
from bleak import BleakClient, BleakScanner

ADDR = sys.argv[1]
SECS = float(sys.argv[2])
OUT = sys.argv[3]
NOTIFY_UUID = "00000003-0000-1000-8000-00805f9b34fb"

async def main():
    dev = await BleakScanner.find_device_by_address(ADDR, timeout=20)
    if not dev:
        print("device not found"); return
    with open(OUT, "a", encoding="utf-8") as fh:
        async with BleakClient(dev, timeout=30) as c:
            def h(_, data):
                line = f"{datetime.datetime.now(datetime.timezone.utc).isoformat()} {bytes(data).hex()}"
                print(line, flush=True); fh.write(line + "\n"); fh.flush()
            await c.start_notify(NOTIFY_UUID, h)
            await asyncio.sleep(SECS)

asyncio.run(main())
