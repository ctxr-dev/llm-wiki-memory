import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export function useShowArchived(wikiId: string | null) {
  const [showArchived, setShow] = useState(false);

  useEffect(() => {
    if (!wikiId) return undefined;
    let ignore = false;
    setShow(false);
    api
      .getPref(wikiId, "showArchived")
      .then((value) => {
        if (!ignore) setShow(value === "1");
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, [wikiId]);

  const setShowArchived = useCallback(
    (next: boolean) => {
      setShow(next);
      if (wikiId) api.setPref(wikiId, "showArchived", next ? "1" : "0").catch(() => undefined);
    },
    [wikiId],
  );

  return { showArchived, setShowArchived };
}
