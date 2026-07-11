// path-compiler-error — the shared error type for path-compiler failures.

export class PathCompilerError extends Error {
  /**
   * @param {string} message
   * @param {{ phase?: string, source?: unknown, cause?: unknown }} [opts]
   */
  constructor(message, { phase, source, cause } = {}) {
    super(message);
    this.name = "PathCompilerError";
    this.phase = phase || "unknown";
    this.source = source;
    this.cause = cause;
  }
}
