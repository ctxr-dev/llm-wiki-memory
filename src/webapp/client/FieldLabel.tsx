import { InformationCircleIcon } from "@heroicons/react/24/outline";
import { humanizeFacet } from "./facets";

export function FieldLabel({
  facet,
  htmlFor,
  description,
}: {
  facet: string;
  htmlFor?: string;
  description?: string;
}) {
  const text = humanizeFacet(facet);
  return (
    <span className="flex items-center gap-1">
      <label
        htmlFor={htmlFor}
        className="cursor-pointer text-xs font-medium text-slate-500 dark:text-slate-400"
      >
        {text}
      </label>
      {description && (
        <span
          role="img"
          aria-label={`About ${text}`}
          title={description}
          className="cursor-help text-slate-400 dark:text-slate-500"
        >
          <InformationCircleIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      )}
    </span>
  );
}
