/**
 * A boundary validation failure carrying an actionable, self-correcting envelope
 * (`field` + the `allowed` values + a plain `reason`) so an LLM caller can fix
 * the offending argument on its next turn instead of guessing.
 */
export class ContextValidationError extends Error {
  /**
   * @param {{ field: string, allowed?: readonly string[], reason: string }} envelope
   */
  constructor({ field, allowed, reason }) {
    const allowedList = allowed ? [...allowed] : undefined;
    const suffix = allowedList && allowedList.length ? ` (allowed: ${allowedList.join(", ")})` : "";
    super(`${field}: ${reason}${suffix}`);
    this.name = "ContextValidationError";
    /** @type {{ field: string, allowed: string[] | undefined, reason: string }} */
    this.envelope = Object.freeze({ field, allowed: allowedList, reason });
  }
}
