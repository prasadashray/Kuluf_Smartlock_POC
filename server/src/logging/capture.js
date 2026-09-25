// Append-only JSONL capture of raw TCP chunks and decoded frames. Independent of the database so that the very first
// hardware packets are preserved even if the DB is unavailable.
import fs from 'node:fs';
import path from 'node:path';
import { toJsonSafe } from './logger.js';

export class CaptureWriter {
  constructor(file) {
    this.file = file;
    this.stream = null;
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.stream = fs.createWriteStream(file, { flags: 'a' });
    }
  }

  write(record) {
    if (!this.stream) return;
    this.stream.write(`${JSON.stringify(toJsonSafe({ ts: new Date().toISOString(), ...record }))}\n`);
  }

  close() {
    return new Promise((resolve) => (this.stream ? this.stream.end(resolve) : resolve()));
  }
}
