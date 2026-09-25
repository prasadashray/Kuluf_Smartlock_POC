// §4.4.4: XOR of every byte from the first header byte up to the byte before the check code.
export function xorChecksum(buf, start = 0, end = buf.length) {
  let c = 0;
  for (let i = start; i < end; i++) c ^= buf[i];
  return c;
}
