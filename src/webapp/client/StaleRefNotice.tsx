/**
 * Shown when the id that was opened no longer exists and the server answered with a leaf
 * of the same name under a different lifecycle folder. That match is by NAME, so it is not
 * proof of identity: a second plan saved under the same name reads exactly like a moved
 * one. The tab, the URL and the saved tab list have already been rewritten onto the leaf
 * that was served, so the id that was asked for is stated here — otherwise the substitution
 * would leave no trace anywhere for the reader to check it against.
 */
export function StaleRefNotice({
  requestedId,
  resolvedId,
}: {
  requestedId: string;
  resolvedId: string;
}) {
  return (
    <div
      role="status"
      className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      This plan moved: <code>{requestedId}</code> no longer exists, so <code>{resolvedId}</code> was
      opened instead. Plans keep their name across lifecycle folders — check this is the one the
      reference meant.
    </div>
  );
}
