const PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]"],
  [/(api[_-]?key|secret|token|password)(["'\s:=]+)[^"'\s]+/gi, "$1$2[REDACTED]"],
  [/\bsk-(?!ant-)[A-Za-z0-9_-]{16,}\b/g, "sk-[REDACTED]"],
  [/\bctx7sk-[A-Za-z0-9_-]{16,}\b/g, "ctx7sk-[REDACTED]"],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, "ghp_[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]"],
  // Slack tokens (broad: xoxb/xoxa/xoxp/xoxr/xoxs, plus newer xoxe-/xoxc-).
  // a-z covers every published prefix and is forward-compatible.
  [/\bxox[a-z]-[A-Za-z0-9-]{10,}\b/g, "xox-[REDACTED]"],
  // Google API keys (fixed prefix + 35 b64url chars)
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "AIza[REDACTED]"],
  // Stripe live keys
  [/\b(sk|pk|rk)_live_[A-Za-z0-9]{16,}\b/g, "$1_live_[REDACTED]"],
  // Generic JWT (3 base64url segments separated by .)
  [/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "eyJ[REDACTED-JWT]"],
  // npm tokens: 36-char body. The generic key/value rule already catches
  // `token: npm_xxx` but a raw token in prose escapes that rule.
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "npm_[REDACTED]"],
  // Discord webhooks. The token segment after the snowflake id is the
  // sensitive part; the URL itself reveals routing but the token is what
  // grants posting rights.
  [/https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g, "https://discord.com/api/webhooks/[REDACTED]"],
  // PEM private key blocks (SSH, OpenSSL, PKCS#8, GCloud service-account
  // JSON values). Non-greedy match between BEGIN/END headers; `\s\S` so
  // newlines inside the block don't terminate the match. Covers
  // RSA/EC/DSA/OPENSSH/'ENCRYPTED' variants via [A-Z ]*.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED-PRIVATE-KEY]"],
  // Anthropic keys (sk-ant-...).
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, "sk-ant-[REDACTED]"],
  // Database connection URLs with credentials in the userinfo segment:
  //   postgres://user:pw@host/db, postgresql://, mysql://, mongodb://,
  //   mongodb+srv://, redis://, amqp://. Replaces the userinfo only,
  //   leaves the routing visible (host/db) so the message still tells
  //   the reader WHICH DB.
  [/\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|rediss):\/\/)[^\s:@\/]+:[^\s@\/]+@/gi, "$1[REDACTED]:[REDACTED]@"],
  // Azure Storage account keys (AccountKey=...; in connection strings).
  // The key is base64 + padding, ~80 chars; the connection string itself
  // is semicolon-separated key=value pairs.
  [/\bAccountKey=([A-Za-z0-9+/=]{20,})/g, "AccountKey=[REDACTED]"],
  // Azure SAS tokens (sig=... in URLs). The signature is the part that
  // grants access; the rest of the URL is routing.
  [/([?&]sig=)[A-Za-z0-9%/+=_-]{20,}/gi, "$1[REDACTED]"],
  // npm authToken from .npmrc-style config:
  //   //registry.npmjs.org/:_authToken=...
  [/(\/\/[^/\s]+\/:_authToken=)[A-Za-z0-9_=-]+/g, "$1[REDACTED]"],
];

export function redact(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const [re, repl] of PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}
