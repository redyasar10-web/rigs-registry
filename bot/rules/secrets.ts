/**
 * Secret detection. This is the rule that must not have bugs.
 *
 * The non-obvious hazard: Claude Code's `permissions.allow[]` entries are
 * VERBATIM CAPTURED SHELL COMMANDS. On the author's own machine, live Groq and
 * Mistral API keys sat at permissions.allow[104] and [107], buried inside 281-
 * and 249-character `curl ... -H 'Authorization: Bearer ...'` strings.
 *
 * Consequences for the implementation:
 *   1. Walk EVERY scalar in the JSON tree. Never scan by key name.
 *   2. A finding must never carry the matched value anywhere — GitHub Actions
 *      logs are public, and so is our own index.json.
 */

export interface SecretFinding {
  /** Rule id, e.g. "SEC-01" */
  rule: string;
  /** Repo-relative file path */
  file: string;
  /** JSON pointer-ish location, e.g. "permissions.allow.104" */
  location: string;
  /** Which pattern fired — the name only, never the value */
  kind: string;
  /** Length of the matched span, for triage without disclosure */
  matchLength: number;
  /**
   * "reject" blocks listing; "warn" shows a badge. Findings in test/fixture
   * paths are downgraded — see isTestPath.
   */
  severity: "reject" | "warn";
}

interface Pattern {
  kind: string;
  re: RegExp;
}

/** Ordered most-specific first so `kind` is maximally informative. */
const PATTERNS: Pattern[] = [
  { kind: "private-key-block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { kind: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{80,}/ },
  { kind: "openai-project", re: /\bsk-proj-[A-Za-z0-9_-]{20,}/ },
  { kind: "groq", re: /\bgsk_[A-Za-z0-9]{40,}/ },
  { kind: "github-pat-fine", re: /\bgithub_pat_[A-Za-z0-9_]{60,}/ },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/ },
  { kind: "slack", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "openai-legacy", re: /\bsk-[A-Za-z0-9]{32,}/ },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
];

/**
 * Values that look like secrets but are placeholders. Without this, every
 * legitimate `"Authorization": "Bearer ${API_TOKEN}"` would be rejected.
 * Tested against the matched span, not the whole scalar.
 */
const PLACEHOLDER_RE = [
  /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/, // $VAR / ${VAR}
  /\$\{[^}]+\}/,                       // embedded ${...}
  /YOUR[_-]?[A-Z]/i,
  /^<[^>]+>$/,                          // <your-token-here>
  /\.\.\./,
  // Substring, NOT word-boundary: the canonical AWS docs key is
  // AKIAIOSFODNN7EXAMPLE — "EXAMPLE" is inside the token, so /\bexample\b/
  // never fires. This exact case produced a false positive on the first real
  // indexing run, against a repo whose secret-scanner tests assert on it.
  /example/i,
  /sample/i,
  /fake/i,
  /dummy/i,
  /placeholder/i,
  /redacted/i,
  /changeme/i,
  /notreal/i,
  /x{4,}/i,
];

/**
 * Test and fixture paths. A credential here is worth surfacing but must not be
 * a hard reject: scanners, linters and docs legitimately embed key-shaped
 * literals, and rejecting them would exclude exactly the security-minded rigs
 * we most want listed.
 */
const TEST_PATH_RE =
  /(^|\/)(tests?|__tests__|__mocks__|fixtures?|spec|examples?)(\/|$)|\.(test|spec)\.[a-z]+$/i;

export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

/** Assertion-shaped lines are test data even outside a test path. */
const ASSERTION_RE = /\b(assert|expect|describe|it|test)\s*\(|toEqual|toBe\b|should\b/;

export function looksLikeTestLine(line: string): boolean {
  return ASSERTION_RE.test(line);
}

function isPlaceholder(span: string): boolean {
  if (PLACEHOLDER_RE.some((re) => re.test(span))) return true;
  // Low-entropy spans (e.g. "aaaaaaaa...") are never real credentials.
  const distinct = new Set(span.replace(/^Bearer\s+/i, "")).size;
  return distinct <= 2;
}

/** Scan a single string. Returns the first real finding, if any. */
export function scanString(value: string): { kind: string; matchLength: number } | null {
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(value);
    if (!m) continue;
    if (isPlaceholder(m[0])) continue;
    return { kind, matchLength: m[0].length };
  }
  return null;
}

/**
 * Walk every scalar in a parsed JSON value, reporting its dotted path.
 * Deliberately key-agnostic: the Groq key was in an array of shell strings.
 */
export function scanJsonTree(
  root: unknown,
  file: string,
  rule = "SEC-01",
): SecretFinding[] {
  const findings: SecretFinding[] = [];

  const walk = (node: unknown, path: string[]): void => {
    if (typeof node === "string") {
      const hit = scanString(node);
      if (hit) {
        findings.push({
          rule,
          file,
          location: path.join(".") || "(root)",
          kind: hit.kind,
          matchLength: hit.matchLength,
          severity: isTestPath(file) ? "warn" : "reject",
        });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, [...path, String(i)]));
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    }
  };

  walk(root, []);
  return findings;
}

/** Scan free text (markdown, shell scripts) line by line. */
export function scanText(text: string, file: string, rule = "SEC-02"): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const hit = scanString(lines[i]);
    if (hit) {
      const isTestData = isTestPath(file) || looksLikeTestLine(lines[i]);
      findings.push({
        rule,
        file,
        location: `line ${i + 1}`,
        kind: hit.kind,
        matchLength: hit.matchLength,
        severity: isTestData ? "warn" : "reject",
      });
    }
  }
  return findings;
}

/**
 * SEC-04: a token embedded in an MCP server URL's query string.
 * Query-string credentials evade the patterns above because the token is
 * often an opaque uuid/hex blob with no recognisable prefix.
 */
const CREDENTIAL_PARAM_RE = /[?&](api[_-]?key|token|access[_-]?token|auth|key|secret|password|sig|signature)=([^&\s"']{8,})/i;

export function scanUrl(url: string, file: string, location: string): SecretFinding | null {
  const m = CREDENTIAL_PARAM_RE.exec(url);
  if (!m) return null;
  if (isPlaceholder(m[2])) return null;
  return {
    rule: "SEC-04",
    file,
    location,
    kind: `url-param:${m[1].toLowerCase()}`,
    matchLength: m[2].length,
    severity: isTestPath(file) ? "warn" : "reject",
  };
}

/** Human-readable, disclosure-safe. Never include the matched value. */
export function formatFinding(f: SecretFinding): string {
  return `${f.rule} ${f.file} at ${f.location}: possible ${f.kind} (${f.matchLength} chars)`;
}
