import { useEffect, useRef, useState } from "react";

let counter = 0;

export function Mermaid({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
      try {
        const { svg } = await mermaid.render(`mermaid-${counter++}`, chart);
        if (alive && ref.current) ref.current.innerHTML = svg;
      } catch {
        if (alive) setFailed(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [chart]);

  if (failed) {
    return (
      <pre className="my-3 overflow-x-auto rounded bg-slate-100 p-3 text-sm">
        <code>{chart}</code>
      </pre>
    );
  }
  return <div ref={ref} className="my-4 flex justify-center" />;
}
