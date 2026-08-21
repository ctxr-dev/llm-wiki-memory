import { out } from "./cli-io.mjs";
import { splitLeafFrontmatter } from "./lib/leaf-frontmatter.mjs";

/**
 * @param {string} file
 * @returns {Promise<string | undefined>}
 */
async function inWikiDocumentId(file) {
  const path = await import("node:path");
  const { wikiRoot } = await import("./lib/env.mjs");
  try {
    const rel = path.relative(wikiRoot(), path.resolve(file));
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel)
      ? rel.split(path.sep).join("/")
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Save a leaf whose BODY comes from a file, so document size stops being an
 * agent-side constraint: a large plan or investigation never has to be inlined in a
 * tool-call argument (clients cap and truncate those — a ~46KB inline payload fails
 * to parse), and re-saving an edited doc costs a file write rather than re-emitting
 * the whole body.
 *
 * save-leaf --file <path> --dataset <name> [--name <leaf.md>] [--path <dir>]
 *           [--area=…] [--atom-type=…] [--task-type=…] [--subject=…] [--tags=…]
 *           [--language=…] [--priority=…] [--error-pattern=…] [--dry-run]
 * @param {string[]} rest
 */
export async function handleSaveLeaf(rest) {
  /** @param {string} key @returns {string | undefined} */
  const flag = (key) => {
    const eq = rest.find((a) => a.startsWith(`--${key}=`));
    if (eq) return eq.slice(key.length + 3);
    const i = rest.indexOf(`--${key}`);
    return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : undefined;
  };
  const usage =
    "usage: llm-wiki-memory save-leaf --file <path> --dataset <name> " +
    "[--name <leaf.md>] [--path <dir>] [--area=…] [--atom-type=…] [--task-type=…] " +
    "[--subject=…] [--tags=…] [--language=…] [--priority=…] [--error-pattern=…] [--dry-run]\n";

  const file = flag("file");
  const dataset = flag("dataset");
  if (!file || !dataset) {
    process.stderr.write(usage);
    process.exit(64);
  }
  // The consent gate lives in the MCP layer, so a CLI door must not become a way
  // around it for the one category that requires an in-turn human yes.
  if (dataset === "self_improvement") {
    process.stderr.write(
      "save-leaf refuses self_improvement: that category is write-gated and needs " +
        "the MCP save_lesson tool so the consent prompt is recorded.\n",
    );
    process.exit(2);
  }

  const fs = await import("node:fs");
  const path = await import("node:path");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    process.stderr.write(
      `save-leaf: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(66);
  }
  if (!text.trim()) {
    process.stderr.write(`save-leaf: ${file} is empty\n`);
    process.exit(65);
  }

  const { body, inherited } = splitLeafFrontmatter(text);
  const carried = Object.keys(inherited).length > 0;
  text = body;

  const name = flag("name") || path.basename(file);
  const subject = flag("subject");
  const metadata = {
    ...inherited,
    ...(flag("area") ? { area: flag("area") } : {}),
    ...(flag("atom-type") ? { atom_type: flag("atom-type") } : {}),
    ...(flag("task-type") ? { task_type: flag("task-type") } : {}),
    ...(flag("language") ? { language: flag("language") } : {}),
    ...(flag("priority") ? { priority: flag("priority") } : {}),
    ...(flag("error-pattern") ? { error_pattern: flag("error-pattern") } : {}),
    ...(subject
      ? {
          subject: subject
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : {}),
    ...(flag("tags") ? { tags: flag("tags") } : {}),
  };
  const placementOverride = flag("path");
  const priorId = await inWikiDocumentId(file);

  if (rest.includes("--dry-run")) {
    out({
      ok: true,
      dryRun: true,
      bytes: Buffer.byteLength(text),
      frontmatterStripped: carried,
      priorId,
      metadata,
    });
    return;
  }

  const { saveDocument } = await import("./lib/wiki-store.mjs");
  const { withWikiCommit } = await import("./lib/wiki-commit.mjs");
  try {
    const res = /** @type {Record<string, unknown>} */ (
      await withWikiCommit({ op: "cli-save-leaf", actor: "cli" }, () =>
        saveDocument({
          name,
          text,
          datasetId: dataset,
          metadata,
          ...(placementOverride ? { placementOverride } : {}),
        }),
      )
    );
    const newId = /** @type {{ document?: { id?: string } } | undefined } */ (res.created)?.document
      ?.id;
    const placement =
      !priorId || !newId ? undefined : priorId === newId ? "unchanged" : "relocated";
    out({
      ok: true,
      bytes: Buffer.byteLength(text),
      frontmatterStripped: carried,
      ...(placement ? { placement, priorId } : {}),
      ...res,
    });
  } catch (err) {
    out({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    process.exit(2);
  }
}
