// Stream reassembly. TCP does not preserve message boundaries: one read may hold a partial frame, several frames,
// or garbage. Every non-empty run of bytes between two 0x7E delimiters is emitted as a candidate frame; validation
// (escape/checksum/header) happens in decodePacket. Bytes before the first delimiter are emitted as garbage.
import { FLAG } from './escape.js';

export class FrameDecoder {
  constructor({ maxFrameLength = 4096 } = {}) {
    this.maxFrameLength = maxFrameLength;
    this.buffer = Buffer.alloc(0);
    this.synced = false;
  }

  /** @returns {Array<{type:'frame'|'garbage', data:Buffer, reason?:string}>} */
  push(chunk) {
    const out = [];
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    let idx;
    while ((idx = this.buffer.indexOf(FLAG)) !== -1) {
      const segment = this.buffer.subarray(0, idx);
      if (!this.synced) {
        if (segment.length) out.push({ type: 'garbage', data: Buffer.from(segment), reason: 'before_first_delimiter' });
        this.synced = true;
      } else if (segment.length) {
        out.push({ type: 'frame', data: Buffer.from(segment) });
      }
      this.buffer = this.buffer.subarray(idx + 1);
    }
    if (this.buffer.length > this.maxFrameLength) {
      out.push({ type: 'garbage', data: Buffer.from(this.buffer), reason: 'oversize_without_delimiter' });
      this.buffer = Buffer.alloc(0);
      this.synced = false;
    }
    return out;
  }

  get pendingBytes() {
    return this.buffer.length;
  }
}
