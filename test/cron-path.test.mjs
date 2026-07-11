import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CURATED_CLI_DIRS, buildCronPath, augmentSpawnEnv } from "../scripts/lib/cron-path.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(SRC, "scripts", "lib", "cron-path.mjs");

const segs = (p) => p.split(":");

test("buildCronPath: user PATH first, then execDir, then expanded curated dirs", () => {
  const out = buildCronPath({
    envPath: "/usr/bin:/bin",
    home: "/home/u",
    execPath: "/opt/node/bin/node",
  });
  const s = segs(out);
  assert.equal(s[0], "/usr/bin");
  assert.equal(s[1], "/bin");
  assert.equal(s[2], "/opt/node/bin");
  assert.ok(s.includes("/home/u/.local/bin"));
  assert.ok(s.includes("/opt/homebrew/bin"));
  assert.ok(s.indexOf("/home/u/.local/bin") > s.indexOf("/opt/node/bin"));
});

test("buildCronPath: empty PATH yields curated + execDir only, no empty segments", () => {
  const out = buildCronPath({ envPath: "", home: "/home/u", execPath: "/n/bin/node" });
  const s = segs(out);
  assert.equal(s[0], "/n/bin");
  assert.ok(!s.includes(""));
  assert.ok(!out.startsWith(":"));
  assert.ok(!out.endsWith(":"));
});

test("buildCronPath: missing PATH arg behaves like empty", () => {
  const a = buildCronPath({ home: "/home/u", execPath: "/n/bin/node" });
  const b = buildCronPath({ envPath: "", home: "/home/u", execPath: "/n/bin/node" });
  assert.equal(a, b);
});

test("buildCronPath: HOME unset drops tilde dirs, keeps absolute curated + execDir", () => {
  const out = buildCronPath({ envPath: "/usr/bin", home: "", execPath: "/n/bin/node" });
  const s = segs(out);
  assert.ok(!out.includes("~"));
  assert.ok(!s.includes("/.local/bin"));
  assert.ok(s.every((d) => !d.endsWith("/.cargo/bin") || d.length > "/.cargo/bin".length));
  assert.ok(s.includes("/opt/homebrew/bin"));
  assert.ok(s.includes("/n/bin"));
});

test("buildCronPath: dedup keeps the user-PATH position for duplicate curated dirs", () => {
  const out = buildCronPath({
    envPath: "/usr/local/bin:/usr/bin",
    home: "/home/u",
    execPath: "/n/bin/node",
  });
  const s = segs(out);
  assert.equal(s[0], "/usr/local/bin");
  assert.equal(s.filter((d) => d === "/usr/local/bin").length, 1);
});

test("buildCronPath: double and trailing colons produce no empty segments", () => {
  const out = buildCronPath({
    envPath: "/usr/bin::/bin:",
    home: "/home/u",
    execPath: "/n/bin/node",
  });
  assert.ok(!segs(out).includes(""));
});

test("buildCronPath: falsy execPath adds no execDir and does not crash", () => {
  const out = buildCronPath({ envPath: "/usr/bin", home: "/home/u", execPath: "" });
  const s = segs(out);
  assert.equal(s[0], "/usr/bin");
  assert.ok(!s.includes("."));
});

test("buildCronPath: a PATH segment containing a space survives verbatim", () => {
  const out = buildCronPath({
    envPath: "/Apps/My Tools/bin:/usr/bin",
    home: "/home/u",
    execPath: "/n/bin/node",
  });
  assert.equal(segs(out)[0], "/Apps/My Tools/bin");
});

test("buildCronPath: every curated entry is either absolute or home-expandable", () => {
  for (const dir of CURATED_CLI_DIRS) {
    assert.ok(dir.startsWith("/") || dir.startsWith("~/"), dir);
  }
});

test("augmentSpawnEnv: appends curated dirs after the env's own PATH", () => {
  const env = { PATH: "/x", HOME: "/h", OTHER: "keep" };
  const out = augmentSpawnEnv(env);
  const s = segs(out.PATH);
  assert.equal(s[0], "/x");
  assert.ok(s.includes("/h/.local/bin"));
  assert.ok(s.includes(path.dirname(process.execPath)));
  assert.equal(out.OTHER, "keep");
  assert.equal(env.PATH, "/x", "input env must not be mutated");
});

test("augmentSpawnEnv: env without PATH falls back to process.env.PATH", () => {
  const out = augmentSpawnEnv({ HOME: "/h" });
  const first = (process.env.PATH || "").split(":")[0];
  if (first) assert.equal(segs(out.PATH)[0], first);
  assert.ok(out.PATH.includes("/h/.local/bin"));
});

test("augmentSpawnEnv: falsy env passes through untouched", () => {
  assert.equal(augmentSpawnEnv(undefined), undefined);
  assert.equal(augmentSpawnEnv(null), null);
});

test("CLI print mode: emits the hybrid PATH for the controlled env, no trailing newline", () => {
  const r = spawnSync(process.execPath, [HELPER], {
    env: { PATH: "/ctl/bin", HOME: "/ctl/home" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.endsWith("\n"));
  const s = segs(r.stdout);
  assert.equal(s[0], "/ctl/bin");
  assert.ok(s.includes("/ctl/home/.local/bin"));
  assert.ok(s.includes(path.dirname(process.execPath)));
});

test("importing the module has no side effects on stdout", () => {
  const r = spawnSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(HELPER)}).then(() => {})`],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
