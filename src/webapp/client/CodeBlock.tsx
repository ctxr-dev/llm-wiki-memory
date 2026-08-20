import { useEffect, useState } from "react";

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    import("shiki")
      .then(({ codeToHtml }) =>
        codeToHtml(code, {
          lang,
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: "light",
        }),
      )
      .then((out) => {
        if (alive) setHtml(out);
      })
      .catch(() => {
        if (alive) setHtml(null);
      });
    return () => {
      alive = false;
    };
  }, [code, lang]);

  if (html) {
    return (
      <div
        className="my-3 overflow-x-auto rounded text-sm [&_pre]:p-3"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <pre className="my-3 overflow-x-auto rounded bg-slate-100 p-3 text-sm dark:bg-slate-800">
      <code>{code}</code>
    </pre>
  );
}
