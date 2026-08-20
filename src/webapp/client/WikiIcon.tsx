function BrainChipIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true" data-icon="brain">
      <path d="M8.766 8.766h6.469v6.469H8.766z" stroke="currentColor" strokeWidth={1.5} />
      <path d="M10.25 8.766V6.917" stroke="currentColor" strokeWidth={1.5} />
      <path d="M13.75 8.766V6.917" stroke="currentColor" strokeWidth={1.5} />
      <path d="M10.25 17.083v-1.849" stroke="currentColor" strokeWidth={1.5} />
      <path d="M13.75 17.083v-1.849" stroke="currentColor" strokeWidth={1.5} />
      <path d="M15.234 10.25h1.849" stroke="currentColor" strokeWidth={1.5} />
      <path d="M15.234 13.75h1.849" stroke="currentColor" strokeWidth={1.5} />
      <path d="M6.918 10.25h1.848" stroke="currentColor" strokeWidth={1.5} />
      <path d="M6.918 13.75h1.848" stroke="currentColor" strokeWidth={1.5} />
      <path
        d="M12 5.485a3.78 3.78 0 1 0 -7.362 1.214 5.59 5.59 0 0 0 0 10.601A3.78 3.78 0 1 0 12 18.515"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <path
        d="M12 5.485a3.781 3.781 0 1 1 7.363 1.214 5.59 5.59 0 0 1 0 10.601A3.78 3.78 0 1 1 12 18.515"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <path d="M4.456 18.524a3.76 3.76 0 0 1 1.029 -2.59" stroke="currentColor" strokeWidth={1.5} />
      <path d="M4.456 5.485a3.76 3.76 0 0 0 1.029 2.589" stroke="currentColor" strokeWidth={1.5} />
      <path
        d="M19.544 18.524a3.759 3.759 0 0 0 -1.029 -2.59"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <path
        d="M19.544 5.485a3.76 3.76 0 0 1 -1.029 2.589"
        stroke="currentColor"
        strokeWidth={1.5}
      />
    </svg>
  );
}

function GitIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      data-icon="git"
    >
      <path d="M4 18a2 2 0 1 0 4 0 2 2 0 1 0 -4 0" strokeWidth={2} />
      <path d="M4 6a2 2 0 1 0 4 0 2 2 0 1 0 -4 0" strokeWidth={2} />
      <path d="M16 18a2 2 0 1 0 4 0 2 2 0 1 0 -4 0" strokeWidth={2} />
      <path d="m6 8 0 8" strokeWidth={2} />
      <path d="M11 6h5a2 2 0 0 1 2 2v8" strokeWidth={2} />
      <path d="m14 9 -3 -3 3 -3" strokeWidth={2} />
    </svg>
  );
}

export function WikiIcon({ kind, className = "h-4 w-4" }: { kind: string; className?: string }) {
  return kind === "home" ? (
    <BrainChipIcon className={className} />
  ) : (
    <GitIcon className={className} />
  );
}
