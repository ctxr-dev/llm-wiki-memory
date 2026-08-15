import { useEffect, useMemo, useState } from "react";
import { DiagramFrame, svgNaturalSize } from "./DiagramViewer";

let counter = 0;

export function Mermaid({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setSvg(null);
    setFailed(false);
    import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
      try {
        const rendered = await mermaid.render(`mermaid-${counter++}`, chart);
        if (alive) setSvg(rendered.svg);
      } catch {
        if (alive) setFailed(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [chart]);

  const natural = useMemo(() => (svg ? svgNaturalSize(svg) : null), [svg]);

  if (failed) {
    return (
      <pre className="my-3 overflow-x-auto rounded bg-slate-100 dark:bg-slate-800 p-3 text-sm">
        <code>{chart}</code>
      </pre>
    );
  }
  if (!svg) return <div className="my-4 flex justify-center" />;

  return (
    <DiagramFrame
      label="diagram"
      natural={natural}
      preview={
        <div
          data-diagram-preview=""
          className="flex justify-center overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      }
      full={<div data-diagram-full="" dangerouslySetInnerHTML={{ __html: svg }} />}
    />
  );
}
