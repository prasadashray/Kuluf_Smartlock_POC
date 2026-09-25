// Records every RX/TX protocol frame (and optionally raw TCP chunks) to the database, the JSONL capture file and the
// console. A logging failure must never break protocol processing.
import { toHex, messageName, hex16 } from '../protocol/index.js';

export class MessageLogger {
  constructor({ cfg, store, capture, logger }) {
    this.cfg = cfg;
    this.store = store;
    this.capture = capture;
    this.log = logger.child({ scope: 'proto' });
  }

  chunk(session, direction, buf) {
    if (!this.cfg.logging.logRawChunks) return;
    this.capture?.write({ kind: 'chunk', direction, session: session.id, remote: session.remoteLabel, terminalId: session.terminalId, hex: toHex(buf) });
  }

  async rx(session, { rawHex, packet = null, parsed = null, processingResult, error = null }) {
    const header = packet?.header ?? null;
    const row = {
      direction: 'rx',
      device_id: session.device?.id ?? null,
      session_id: session.dbId ?? null,
      terminal_id: header?.terminalId ?? session.terminalId ?? null,
      msg_id: header?.msgId ?? null,
      msg_id_hex: header ? hex16(header.msgId) : null,
      msg_name: header ? messageName(header.msgId) : null,
      serial: header?.serial ?? null,
      raw_hex: rawHex,
      unescaped_hex: packet?.unescapedHex ?? null,
      checksum_ok: packet?.checksum ? packet.checksum.valid : null,
      parsed: parsed ? { body: parsed, warnings: packet?.warnings?.length ? packet.warnings : undefined } : null,
      processing_result: processingResult,
      error,
    };
    return this.persist(row, session);
  }

  async tx(session, { msgId, serial, frame, unescaped, parsed = null }) {
    const row = {
      direction: 'tx',
      device_id: session.device?.id ?? null,
      session_id: session.dbId ?? null,
      terminal_id: session.terminalId ?? null,
      msg_id: msgId,
      msg_id_hex: hex16(msgId),
      msg_name: messageName(msgId),
      serial,
      raw_hex: toHex(frame),
      unescaped_hex: toHex(unescaped),
      checksum_ok: true,
      parsed: parsed ? { body: parsed } : null,
      processing_result: 'sent',
      error: null,
    };
    return this.persist(row, session);
  }

  async persist(row, session) {
    this.capture?.write({ kind: 'frame', ...row, remote: session.remoteLabel });
    if (this.cfg.logging.protocolVerbose || row.error) {
      const what = row.msg_id_hex ? `${row.msg_id_hex} ${row.msg_name}` : row.processing_result;
      const line = `${row.direction.toUpperCase()} ${what} term=${row.terminal_id ?? '?'} serial=${row.serial ?? '-'} raw=${row.raw_hex}`;
      if (row.error) this.log.warn(`${line} ERROR=${row.error}`);
      else this.log.info(line);
    }
    if (!this.cfg.logging.messageLogDb) return { ...row, id: null };
    try {
      return await this.store.insertMessage(row);
    } catch (e) {
      this.log.error(`message_log insert failed: ${e.message}`);
      return { ...row, id: null };
    }
  }
}
