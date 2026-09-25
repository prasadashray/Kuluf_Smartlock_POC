export class ProtocolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
