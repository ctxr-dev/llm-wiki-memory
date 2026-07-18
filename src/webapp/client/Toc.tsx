import type { TocItem } from "./headings";

export function Toc({ items }: { items: TocItem[] }) {
  if (items.length === 0) return null;
  return (
    <nav className="text-sm">
      <div className="mb-2 font-semibold text-slate-500">On this page</div>
      <ul className="space-y-1">
        {items.map((item) => (
          <li
            key={`${item.slug}-${item.depth}`}
            style={{ paddingLeft: `${(item.depth - 1) * 12}px` }}
          >
            <a href={`#${item.slug}`} className="text-slate-600 hover:text-slate-900">
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
