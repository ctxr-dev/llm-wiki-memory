export function reorder(list: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function replaceTabId(ids: string[], from: string, to: string): string[] {
  if (from === to || !ids.includes(from)) return ids;
  const swapped = ids.map((id) => (id === from ? to : id));
  return swapped.filter((id, index) => swapped.indexOf(id) === index);
}

export function orderWithPins(tabs: string[], pinned: string[]): string[] {
  const pinnedSet = new Set(pinned);
  const pins = tabs.filter((tab) => pinnedSet.has(tab));
  const rest = tabs.filter((tab) => !pinnedSet.has(tab));
  return [...pins, ...rest];
}
