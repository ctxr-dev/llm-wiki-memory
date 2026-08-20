# Skill: verify a change to the live engine tree

`~/.llm-wiki-memory/src` runs LIVE — the MCP server, the Claude Code hook workers, and
cron import it as you edit. What must not break, and why:
`.agents/rules/live-runtime-safety.md`. Commands run from `src/`.

1. Snapshot the embedding-cache stamps BEFORE touching anything — one line per category
   (`<category> <model> <backend> <dtype> <dim> <entries>`). Save it outside the
   `/tmp/lwm-*` pattern, which `run-tests-safely` sweeps:

   ```
   node -e 'const fs=require("fs"),p=require("path"),r=process.argv[1];for(const c of fs.readdirSync(r).sort()){const f=p.join(r,c,".embeddings","embeddings.json");if(!fs.existsSync(f))continue;const j=JSON.parse(fs.readFileSync(f,"utf8"));console.log(c,j.model,j.backend,j.dtype,j.dim,Object.keys(j.entries||{}).length);}' "$(node scripts/cli.mjs where | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).wiki')" | tee /tmp/embed-stamps.before
   ```

2. Make the change. Multi-file edits are NOT atomic — a hook firing mid-edit imports a
   half-updated module graph. Land the edits that must agree (a shared export and its
   callers) back to back, not minutes apart.
3. Parse-gate every touched file without executing it: `node --check <file>`.
4. Run the FULL chain: `npm run gates`. Never a subset — the pass you skip is the one that
   catches the drift. What it chains, and why a partial run may not be reported as green:
   `.agents/rules/verification-completeness.md`.
5. Re-verify the artifact: re-run step 1 into `/tmp/embed-stamps.after` and `diff` the
   two — expect no output. Then `node scripts/cli.mjs warm` (healthy: `"embedded": 0,
   "paused": 0` — all cache hits, done in seconds) and `node scripts/cli.mjs doctor`
   (healthy: `"ok": true`, `"cacheMismatches": []`, `"cacheDimMixes": []`, every `summary`
   counter 0, exit 0;
   exit 3 means findings).
6. A drifted stamp, or a non-zero `embedded`, means the change moved the embedding
   signature (model / backend / dtype / dim) or the leaf embed text, so `loadCache`
   discarded the caches and is re-embedding. Confirm that was intended; either way the
   repair is a full re-warm — `node scripts/cli.mjs warm`, NOT `--if-due` (that honours
   the interval and would skip). It rebuilds every vector from the leaves, is idempotent,
   and never touches leaf content. A cold re-embed of the whole corpus runs for minutes; it is
   duty-cycled on purpose, so let it finish rather than killing and retrying.
7. Never point a test or an ad-hoc probe at the real data dir. Use `setupWorkspace()`
   from `test/harness.mjs`, or `MEMORY_DATA_DIR=$(mktemp -d)` set BEFORE any engine
   import (`env.mjs` captures it at load). Keep the `--import ./test/setup-guard.mjs`
   preload even for a single file — `node --import ./test/setup-guard.mjs --test
   test/<file>.test.mjs` — it turns a leaked real-brain path into a crash instead of
   silent corruption of the real leaves.
