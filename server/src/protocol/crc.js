// 1-byte check algorithms. The TT e-lock business-layer CRC algorithm is NOT specified in the protocol documents
// (DOC-07). CRC-8/MAXIM is the candidate because it is what the same device uses on its BLE frames (H-06).
function crc8Maxim(buf) {
  let crc = 0x00;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x8c : crc >>> 1;
  }
  return crc & 0xff;
}

function xor8(buf) {
  let c = 0;
  for (const b of buf) c ^= b;
  return c;
}

function sum8(buf) {
  let c = 0;
  for (const b of buf) c = (c + b) & 0xff;
  return c;
}

export const CRC_ALGORITHMS = {
  crc8_maxim: crc8Maxim,
  xor: xor8,
  sum: sum8,
};

export function computeCrc(algo, buf) {
  const fn = CRC_ALGORITHMS[algo];
  if (!fn) throw new Error(`Unknown CRC algorithm: ${algo}`);
  return fn(buf);
}
