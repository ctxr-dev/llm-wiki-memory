import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../scripts/lib/redact.mjs";

// redact() is the SINGLE barrier that keeps secrets out of the git-versioned
// wiki, the .flush.log, and the failed-distill stash. It had zero coverage.
// Each case: a representative secret must be replaced by its sentinel, and the
// sensitive substring must NOT survive in the output.

// Assembled at runtime: GitHub push protection's OpenAI detector matches the
// contiguous "sk-...T3BlbkFJ..." literal and blocks any push containing it,
// fixture or not. Our own sk- rule matches the assembled value regardless.
const FAKE_OPENAI_KEY = "sk-" + "T3Blbk" + "FJ0123456789abcdefXY";

const CASES = [
  {
    name: "Bearer token",
    input: "Authorization: Bearer abcDEF123ghiJKL456mno",
    secret: "abcDEF123ghiJKL456mno",
    sentinel: "Bearer [REDACTED]",
  },
  {
    name: "generic api_key=value",
    input: "api_key=SUPERSECRETVALUE123",
    secret: "SUPERSECRETVALUE123",
    sentinel: "[REDACTED]",
  },
  {
    name: "generic password: value",
    input: 'password: "hunter2hunter2"',
    secret: "hunter2hunter2",
    sentinel: "[REDACTED]",
  },
  {
    name: "OpenAI sk- key (not sk-ant)",
    input: `key ${FAKE_OPENAI_KEY} here`,
    secret: FAKE_OPENAI_KEY.slice("sk-".length),
    sentinel: "sk-[REDACTED]",
  },
  {
    name: "Anthropic sk-ant- key",
    input: "ANTHROPIC_API_KEY was sk-ant-api03-abcdefghijklmnopqrstuvwxyz in prose",
    secret: "abcdefghijklmnopqrstuvwxyz",
    sentinel: "sk-ant-[REDACTED]",
  },
  {
    name: "ctx7sk- key",
    input: "ctx7sk-0123456789abcdefghij token",
    secret: "0123456789abcdefghij",
    sentinel: "ctx7sk-[REDACTED]",
  },
  {
    name: "GitHub ghp_ token",
    input: "ghp_0123456789abcdefghijABCD in a note",
    secret: "0123456789abcdefghijABCD",
    sentinel: "ghp_[REDACTED]",
  },
  {
    name: "GitHub fine-grained PAT",
    input: "github_pat_0123456789abcdefghij_more in a note",
    secret: "0123456789abcdefghij",
    sentinel: "github_pat_[REDACTED]",
  },
  {
    name: "AWS access key id",
    input: "aws AKIAIOSFODNN7EXAMPLE here",
    secret: "AKIAIOSFODNN7EXAMPLE",
    sentinel: "AKIA[REDACTED]",
  },
  {
    name: "Slack token",
    input: "slack xoxb-0123456789-abcdefghij here",
    secret: "0123456789-abcdefghij",
    sentinel: "xox-[REDACTED]",
  },
  {
    name: "Google API key",
    input: "AIzaSyD0123456789abcdefghijklmnopqrstuv key",
    secret: "SyD0123456789abcdefghijklmnopqrstuv",
    sentinel: "AIza[REDACTED]",
  },
  {
    name: "Stripe live secret key",
    input: "sk_live_0123456789abcdefABCD here",
    secret: "0123456789abcdefABCD",
    sentinel: "sk_live_[REDACTED]",
  },
  {
    // No trigger word (token/secret/key/password) before it, so the
    // JWT-specific rule is what fires — not the generic key/value rule.
    name: "JWT",
    input: "saw eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N here",
    secret: "dozjgNryP4J3jVmNHl0w5N",
    sentinel: "eyJ[REDACTED-JWT]",
  },
  {
    name: "npm token in prose",
    input: "npm_abcdefghij0123456789ABCDEFGHIJ012345 here",
    secret: "abcdefghij0123456789ABCDEFGHIJ012345",
    sentinel: "npm_[REDACTED]",
  },
  {
    name: "Discord webhook",
    input: "post to https://discord.com/api/webhooks/123456789012345678/AbCd-Ef_tokenXYZ now",
    secret: "AbCd-Ef_tokenXYZ",
    sentinel: "https://discord.com/api/webhooks/[REDACTED]",
  },
  {
    name: "PEM private key block",
    input: "-----BEGIN RSA PRIVATE KEY-----\nMIIBversecretkeymaterial\n-----END RSA PRIVATE KEY-----",
    secret: "MIIBversecretkeymaterial",
    sentinel: "[REDACTED-PRIVATE-KEY]",
  },
  {
    name: "Azure AccountKey",
    input: "AccountKey=abcdefghijklmnopqrstuvwxyz0123456789+/==;Endpoint=x",
    secret: "abcdefghijklmnopqrstuvwxyz0123456789",
    sentinel: "AccountKey=[REDACTED]",
  },
  {
    name: "Azure SAS sig",
    input: "https://x.blob.core.windows.net/c/b?sig=AbC0123456789defGHIjklMNO%2Bpq&se=2026",
    secret: "AbC0123456789defGHIjklMNO",
    sentinel: "sig=[REDACTED]",
  },
  {
    name: "npm authToken in .npmrc",
    input: "//registry.npmjs.org/:_authToken=npmAuthSecret0123456789",
    secret: "npmAuthSecret0123456789",
    sentinel: "_authToken=[REDACTED]",
  },
  // ─── compound key names: the trigger word is embedded in a larger key ──────
  {
    name: "AWS secret access key (compound key, =)",
    input: "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    secret: "wJalrXUtnFEMI",
    sentinel: "aws_secret_access_key=[REDACTED]",
  },
  {
    name: "secret_key= (compound key)",
    input: "secret_key=mysupersecretvalue123",
    secret: "mysupersecretvalue123",
    sentinel: "secret_key=[REDACTED]",
  },
  {
    name: "SECRET_ACCESS_KEY: (compound key, colon, uppercase)",
    input: "SECRET_ACCESS_KEY: AbCdEf0123456789xyz",
    secret: "AbCdEf0123456789xyz",
    sentinel: "SECRET_ACCESS_KEY: [REDACTED]",
  },
  {
    name: "secretAccessKey (camelCase, quoted JSON value)",
    input: '{"secretAccessKey": "wJalrPlusValue0123456789"}',
    secret: "wJalrPlusValue0123456789",
    sentinel: 'secretAccessKey": "[REDACTED]"',
  },
  {
    name: "my_api_key= (compound api key)",
    input: "my_api_key=abc123def456ghi",
    secret: "abc123def456ghi",
    sentinel: "my_api_key=[REDACTED]",
  },
  {
    name: "private_key= (base64 value, not a PEM block)",
    input: "private_key=MIIEvQIBADANBgkqhkiG9w0BAQ",
    secret: "MIIEvQIBADANBgkqhkiG9w0BAQ",
    sentinel: "private_key=[REDACTED]",
  },
  {
    name: "passphrase=",
    input: "passphrase=correct-horse-battery-staple",
    secret: "correct-horse-battery-staple",
    sentinel: "passphrase=[REDACTED]",
  },
  {
    name: "client_secret= (OAuth)",
    input: "client_secret=oauthClientSecretValue123",
    secret: "oauthClientSecretValue123",
    sentinel: "client_secret=[REDACTED]",
  },
  {
    name: "credentials=",
    input: "credentials=topSecretCredentialValue",
    secret: "topSecretCredentialValue",
    sentinel: "credentials=[REDACTED]",
  },
  {
    name: "Authorization: Basic header (scheme kept, credential redacted)",
    input: "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    secret: "dXNlcjpwYXNzd29yZA",
    sentinel: "Authorization: Basic [REDACTED]",
  },
  {
    name: "authorization: Digest header",
    input: "authorization: Digest abc123digestcredential",
    secret: "abc123digestcredential",
    sentinel: "authorization: Digest [REDACTED]",
  },
];

for (const c of CASES) {
  test(`redact: ${c.name} — secret removed, sentinel present`, () => {
    const out = redact(c.input);
    assert.ok(out.includes(c.sentinel), `expected sentinel "${c.sentinel}" in: ${out}`);
    assert.equal(out.includes(c.secret), false, `secret "${c.secret}" must NOT survive in: ${out}`);
  });
}

// ─── routing preserved: DB URL keeps host/db, redacts only the userinfo ──────

test("redact: DB connection URL redacts userinfo but keeps host/db routing", () => {
  const out = redact("postgres://admin:s3cretPw@db.example.com:5432/mydb");
  assert.equal(out.includes("s3cretPw"), false, "password must be gone");
  assert.equal(out.includes("admin"), false, "username must be gone");
  assert.ok(out.includes("db.example.com"), "host stays (tells the reader which DB)");
  assert.ok(out.includes("mydb"), "db name stays");
  assert.ok(out.includes("[REDACTED]:[REDACTED]@"), "userinfo replaced");
});

test("redact: mongodb+srv URL userinfo redacted", () => {
  const out = redact("mongodb+srv://u:p4ssw0rd@cluster0.mongodb.net/app");
  assert.equal(out.includes("p4ssw0rd"), false);
  assert.ok(out.includes("cluster0.mongodb.net"));
});

test("redact: DB URL password containing '@' is redacted in full (last-@ anchoring)", () => {
  const out = redact("postgres://admin:p@ssw0rd@db.example.com:5432/mydb");
  assert.ok(out.includes("db.example.com:5432/mydb"), "routing preserved");
  assert.ok(out.includes("[REDACTED]:[REDACTED]@db.example.com"), "userinfo replaced up to the LAST @");
  assert.equal(out.includes("ssw0rd"), false, "no password fragment may leak past the first @");
  assert.equal(out.includes("admin"), false, "username must be gone");
});

test("redact: DB URL password with multiple '@'s leaves no fragment", () => {
  const out = redact("mysql://svc:a@b@c@db.host/orders");
  assert.equal(out, "mysql://[REDACTED]:[REDACTED]@db.host/orders");
});

// ─── idempotency: redacting twice equals redacting once ──────────────────────

test("redact: idempotent (re-redacting an already-redacted string is a no-op)", () => {
  for (const c of CASES) {
    const once = redact(c.input);
    const twice = redact(once);
    assert.equal(twice, once, `idempotency failed for ${c.name}`);
  }
});

// ─── safety of inputs + non-secret control ───────────────────────────────────

test("redact: non-string input passes through unchanged", () => {
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(42), 42);
  const obj = { a: 1 };
  assert.equal(redact(obj), obj);
});

test("redact: ordinary prose with no secret is untouched", () => {
  const text = "The user asked about caching and we discussed the index rebuild path.";
  assert.equal(redact(text), text);
});

test("redact: trigger words embedded in prose words are NOT over-redacted (no = / : assignment)", () => {
  // The compound-key rule must require an explicit assignment, so English
  // words that merely CONTAIN a trigger token stay intact. (A literal
  // "password reset" is redacted by the older space-separated generic rule —
  // that is pre-existing baseline behaviour and intentionally not asserted here.)
  for (const text of [
    "the secretary signed the document about tokens",
    "tokens and secrets were discussed but no values were shared",
    "our tokenizer and the access keychain are unrelated to credentials",
    "private members of the team verified the credentials were fine",
    "please forward this and remember the passphrase later",
  ]) {
    const out = redact(text);
    assert.equal(out.includes("[REDACTED]"), false, `prose over-redacted: ${out}`);
  }
});

test("redact: no catastrophic backtracking on a large identifier-only input (ReDoS guard)", () => {
  // redact() runs on untrusted, content-controlled transcript text. A long run
  // of [A-Za-z0-9_.-] with no trigger word must NOT blow up: an earlier draft
  // of the compound-key rule was O(n^2) and took ~34s on 300 KB. Anchoring the
  // rule on the trigger word makes it linear. Assert it completes well under a
  // second (generous margin; real time is single-digit ms).
  const hostile = "a_b.c-".repeat(50000); // 300 KB, no secret
  const t0 = process.hrtime.bigint();
  const out = redact(hostile);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(out, hostile, "a no-secret identifier run is returned unchanged");
  assert.ok(ms < 1000, `redact must stay linear on hostile input; took ${ms.toFixed(0)}ms`);
});

test("redact: a transcript with several secrets scrubs ALL of them in one pass", () => {
  const transcript = [
    "### User",
    `here is my key ${FAKE_OPENAI_KEY} and db postgres://u:pw@h/db`,
    "### Assistant",
    "and a token ghp_0123456789abcdefghijABCD",
  ].join("\n");
  const out = redact(transcript);
  assert.equal(out.includes(FAKE_OPENAI_KEY), false);
  assert.equal(out.includes("ghp_0123456789abcdefghijABCD"), false);
  assert.equal(out.includes(":pw@"), false);
  assert.ok(out.includes("### User") && out.includes("### Assistant"), "structure preserved");
});
