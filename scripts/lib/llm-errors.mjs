export class LLMProviderUnavailable extends Error {}
export class LLMOutputInvalid extends Error {
  /**
   * @param {string} message
   * @param {string} [raw]
   */
  constructor(message, raw) {
    super(message);
    /** @type {string | undefined} */
    this.raw = raw;
  }
}
