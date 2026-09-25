"""Brute-force identification of a 1-byte check over captured frames."""
import sys, itertools

frames = [bytes.fromhex(h) for h in sys.argv[1:]] or [
    bytes.fromhex("010e0120471c7e3750fd26092603154067"),
    bytes.fromhex("010e0120471c7e3750fd26092603154385"),
]

def refl8(x):
    return int(f"{x:08b}"[::-1], 2)

def crc8(data, poly, init, refin, refout, xorout):
    if refin:
        # reflected algorithm
        rpoly = refl8(poly)
        crc = refl8(init)
        for b in data:
            crc ^= b
            for _ in range(8):
                crc = (crc >> 1) ^ rpoly if crc & 1 else crc >> 1
        if not refout:
            crc = refl8(crc)
    else:
        crc = init
        for b in data:
            crc ^= b
            for _ in range(8):
                crc = ((crc << 1) ^ poly) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
        if refout:
            crc = refl8(crc)
    return crc ^ xorout

simple = {
    "xor": lambda d: __import__("functools").reduce(lambda a, b: a ^ b, d, 0),
    "sum": lambda d: sum(d) & 0xFF,
    "neg_sum": lambda d: (-sum(d)) & 0xFF,
    "not_sum": lambda d: (~sum(d)) & 0xFF,
    "not_xor": lambda d: (~__import__("functools").reduce(lambda a, b: a ^ b, d, 0)) & 0xFF,
}

hits = []
n = min(len(f) for f in frames)
for start in range(0, 4):
    for end_trim in range(1, 2):  # check byte is last
        ranges = [(f[start:len(f) - end_trim], f[-1]) for f in frames]
        for name, fn in simple.items():
            if all(fn(d) == c for d, c in ranges):
                hits.append((name, start))
        for poly in range(1, 256):
            for init in (0x00, 0xFF):
                for refin in (False, True):
                    for xorout in (0x00, 0xFF):
                        if all(crc8(d, poly, init, refin, refin, xorout) == c for d, c in ranges):
                            hits.append((f"crc8 poly=0x{poly:02X} init=0x{init:02X} ref={refin} xorout=0x{xorout:02X}", start))
for h in hits:
    print(h)
print("done,", len(hits), "hits")
