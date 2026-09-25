// §4.4.2 marker bit and escaping: 0x7E <-> 0x7D 0x02, 0x7D <-> 0x7D 0x01.
export const FLAG = 0x7e;
export const ESC = 0x7d;

export function escape(data) {
  let extra = 0;
  for (const b of data) if (b === FLAG || b === ESC) extra++;
  const out = Buffer.alloc(data.length + extra);
  let j = 0;
  for (const b of data) {
    if (b === FLAG) {
      out[j++] = ESC;
      out[j++] = 0x02;
    } else if (b === ESC) {
      out[j++] = ESC;
      out[j++] = 0x01;
    } else {
      out[j++] = b;
    }
  }
  return out;
}

/**
 * Reverse escaping. Invalid sequences (0x7D followed by anything other than 0x01/0x02, a trailing 0x7D, or a raw 0x7E
 * inside the frame) are reported in `errors`; the frame must then be rejected by the caller.
 */
export function unescape(data) {
  const out = Buffer.alloc(data.length);
  const errors = [];
  let j = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === ESC) {
      const next = data[i + 1];
      if (next === 0x02) {
        out[j++] = FLAG;
        i++;
      } else if (next === 0x01) {
        out[j++] = ESC;
        i++;
      } else {
        errors.push({ offset: i, reason: next === undefined ? 'trailing_escape' : `invalid_escape_0x7D_0x${next.toString(16).padStart(2, '0')}` });
        out[j++] = b;
      }
    } else {
      if (b === FLAG) errors.push({ offset: i, reason: 'unescaped_0x7E_inside_frame' });
      out[j++] = b;
    }
  }
  return { data: out.subarray(0, j), errors };
}
