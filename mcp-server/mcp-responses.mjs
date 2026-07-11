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
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

export { jsonResponse, errorResponse };
