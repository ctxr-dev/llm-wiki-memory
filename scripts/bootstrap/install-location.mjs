import fs from "node:fs";
import path from "node:path";
import { isSharedWiki } from "./shared-wiki.mjs";
import { samePath } from "../lib/path-equal.mjs";
import { helpGuard, formatHelp, docsUrl } from "../lib/cli-args.mjs";

// Where a PRIVATE brain is allowed to live: $HOME, and nowhere else.
//
// The engine is installed once per machine. That one install registers the MCP
// server + hooks globally and wires the rules, skills and discipline into the
// user-level surfaces, which every agent client reads from every directory on the
// box. A second private brain inside a repo therefore buys no capability — it only
// duplicates that wiring into somebody's project tree, which is exactly the
// per-repo injection this engine no longer does.
//
// A repo may still HOST a shared team wiki (`--template repo`); that is data, and
// it receives no wiring at all. But it presupposes the machine already has its one
// install, so it is refused too when the home brain is missing.
//
// The guard fires only on a FRESH wiki. An existing install re-running bootstrap
// is an upgrade — refusing there would wedge it mid-migration, and it is also how
// an already-provisioned shared mount gets its stale artifacts cleaned up.

export const DECISION = Object.freeze({
  PROCEED: "proceed",
  REFUSE_NO_HOME_BRAIN: "refuse-no-home-brain",
  REFUSE_PRIVATE_OUTSIDE_HOME: "refuse-private-outside-home",
});

/** @param {string} p @returns {boolean} */
function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A usable PRIVATE brain at `home` — a wiki that exists and is not itself a
 * shared (ownership: repo) mount.
 * @param {string} home
 * @returns {boolean}
 */
export function hasHomeBrain(home) {
  const wiki = path.join(home, ".llm-wiki-memory", "wiki");
  return dirExists(wiki) && !isSharedWiki(wiki);
}

/**
 * @param {{ workspaceDir: string, home: string, template: string }} args
 * @returns {{ decision: string, message?: string }}
 */
export function checkInstallLocation({ workspaceDir, home, template }) {
  const ws = path.resolve(workspaceDir);
  const h = path.resolve(home);
  // samePath, not string equality: either side can reach the same directory through a link (a
  // symlinked $HOME, a junctioned or redirected Windows profile), and comparing the unresolved
  // text then reports "outside $HOME" for an install that IS $HOME — and refuses it. This is the
  // same question unregister-global.mjs already answers with the same helper.
  if (samePath(ws, h)) return { decision: DECISION.PROCEED };
  // An existing wiki here means this is an upgrade, not a new install.
  if (dirExists(path.join(ws, ".llm-wiki-memory", "wiki"))) return { decision: DECISION.PROCEED };

  const wantsSharedMount = String(template) === "repo";
  if (!hasHomeBrain(h)) {
    return {
      decision: DECISION.REFUSE_NO_HOME_BRAIN,
      message: [
        `Refusing to install into ${ws}: this machine has no llm-wiki-memory brain yet.`,
        "",
        "The engine is installed ONCE per machine, in your home directory. That one",
        "install registers the MCP server + hooks globally and wires the rules, skills",
        "and discipline into your user-level config, so memory works in EVERY directory",
        "— no per-project setup, and nothing written into your repositories.",
        "",
        "Install the main brain first:",
        "",
        "  git clone https://github.com/ctxr-dev/llm-wiki-memory ~/.llm-wiki-memory/src",
        "  ~/.llm-wiki-memory/src/bootstrap.sh --schedule hourly",
        "",
        wantsSharedMount
          ? `Then re-run this command to give ${path.basename(ws)} a shared TEAM wiki.`
          : `Then you are done — ${path.basename(ws)} needs no install of its own.`,
      ].join("\n"),
    };
  }
  if (wantsSharedMount) return { decision: DECISION.PROCEED };
  return {
    decision: DECISION.REFUSE_PRIVATE_OUTSIDE_HOME,
    message: [
      `Refusing to install a private brain into ${ws}: one already exists at ${h}.`,
      "",
      "That brain already serves this directory — its MCP server, hooks, rules and",
      "skills are registered globally and apply in every repository on this machine.",
      "A second private brain here would only duplicate them into your project tree.",
      "",
      "If you meant to give this repo a SHARED TEAM wiki (committed wiki data that",
      "teammates inherit on clone, with no files written outside .llm-wiki-memory/):",
      "",
      "  ./.llm-wiki-memory/src/bootstrap.sh --template repo",
      "",
      "Otherwise there is nothing to do here — memory already works in this repo.",
    ].join("\n"),
  };
}

// CLI: exits 0 to proceed, 3 with the explanation on stderr to refuse. bootstrap.sh
// shells out to this so the policy lives in ONE testable place rather than in shell.
if (import.meta.main) {
  const args = process.argv.slice(2);
  helpGuard(
    args,
    formatHelp({
      name: "install-location",
      summary:
        "refuse a bootstrap that would create a private brain outside $HOME, or any fresh install on a machine with no home brain",
      usage: "node scripts/bootstrap/install-location.mjs <workspaceDir> <home> <template>",
      docs: docsUrl("docs/install.md"),
    }),
  );
  const [workspaceDir, home, template = "default"] = args;
  const res = checkInstallLocation({ workspaceDir, home, template });
  if (res.decision === DECISION.PROCEED) process.exit(0);
  process.stderr.write(`${res.message}\n`);
  process.exit(3);
}
