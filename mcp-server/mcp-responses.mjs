/**
 * @param {unknown} payload
 * @returns {{ content: Array<{ type: "text", text: string }> }}
 */
function jsonResponse(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}
/**
 * @param {unknown} error
 * @returns {{ isError: true, content: Array<{ type: "text", text: string }> }}
 */
function errorResponse(error) {
  const message = error instanceof Error ? error.message : String(error);
  // A ContextValidationError carries a self-correcting `{ field, allowed, reason }`
  // envelope (duck-typed so this stays import-free); surface it as JSON so the LLM
  // can fix the offending argument on its next turn.
  const envelope =
    error && typeof error === "object" && "envelope" in error
      ? /** @type {{ envelope: unknown }} */ (error).envelope
      : undefined;
  const text =
    envelope && typeof envelope === "object"
      ? JSON.stringify({ ok: false, error: "invalid-request", ...envelope, message }, null, 2)
      : message;
  return { isError: true, content: [{ type: "text", text }] };
}

export { jsonResponse, errorResponse };
