/**
 * `rigs pack` — take a live ~/.claude folder and produce a publishable rig.
 *
 * This is the answer to "why not just use GitHub." Publishing your setup by
 * hand means knowing which of ~30 directories under ~/.claude are safe. Most
 * are not: settings.local.json holds captured shell commands with live API
 * keys, projects/ and history.jsonl hold every prompt you have ever typed,
 * .claude.json holds inline MCP credentials, and *.bak copies outlive any
 * redaction of the live file.
 *
 * So: allowlist what ships, hard-deny what never ships, honour a .rigsignore
 * for anything you personally want to hold back, then scan the RESULT and
 * refuse to emit if a credential survived.
 */

import {
  readdirSync, statSync, mkdirSync, copyFileSync, writeFileSync,
  readFileSync, existsSync, rmSync,
} from "node:fs";
import { join, dirname, relative, basename } from "node:path";
import { scanJsonTree, scanText, type SecretFinding } from "../bot/rules/secrets.ts";

/** Directories and files that are genuinely someone's rig. */
export const PUBLISHABLE = new Set([
  "skills", "agents", "commands", "rules", "hooks", "helpers",
  "mcp-configs", "output-styles", "statusline",
  "CLAUDE.md", "AGENTS.md", "README.md", "LICENSE",
]);

/**
 * Never published, and NOT overridable by .rigsignore — these are the paths
 * that leak credentials, prompt history, or machine state. Derived from a real
 * ~/.claude, not guessed.
 */
export const NEVER_PUBLISH = new Set([
  // credentials
  "settings.local.json", ".claude.json", ".credentials.json",
  // prompt + session history
  "projects", "sessions", "session-data", "session-env", "shell-snapshots",
  "history.jsonl", "memory.db", "todos",
  // machine state and telemetry
  "telemetry", "metrics", "statsig", "cost-tracker.log", "bash-commands.log",
  "stats-cache.json", "daemon", "jobs", "tasks", "plans", "debug", "cache",
  "downloads", "uploads", "paste-cache", "backups", "scheduled-tasks",
  "homunculus", "ide", "plugins",
]);

const DENY_SUFFIX = [".bak", ".log", ".db", ".sqlite", ".jsonl", ".pem", ".key", ".p12"];
const DENY_PREFIX = ["settings.json.bak", ".env"];

export interface PackResult {
  included: string[];
  excluded: { path: string; reason: string }[];
  findings: SecretFinding[];
  bytes: number;
  written: boolean;
}

/** gitignore-style: comments, plain paths, trailing slash, and * globs. */
export function loadRigsignore(root: string): string[] {
  const f = join(root, ".rigsignore");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/\/$/, ""));
}

export function matchesIgnore(rel: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p.includes("*")) {
      const re = new RegExp(
        "^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$",
      );
      return rel.split("/").some((seg) => re.test(seg)) || re.test(rel);
    }
    return rel === p || rel.startsWith(p + "/") || basename(rel) === p;
  });
}

function denied(name: string): string | null {
  if (NEVER_PUBLISH.has(name)) return "never published (credentials, history or machine state)";
  if (DENY_SUFFIX.some((s) => name.endsWith(s))) return `denied file type (${name.slice(name.lastIndexOf("."))})`;
  if (DENY_PREFIX.some((p) => name.startsWith(p))) return "denied file";
  return null;
}

function walk(
  dir: string,
  root: string,
  out: string[],
  budget: { n: number },
  excluded: { path: string; reason: string }[],
): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (budget.n++ > 50_000) return;
    const abs = join(dir, e);
    const rel = relative(root, abs).split("\\").join("/");
    // Record rather than silently skip: a nested settings.json.bak was being
    // filtered correctly but never reported, so the CLI told the user
    // "0 sensitive filtered" while having dropped two credential-shaped files.
    const why = denied(e);
    if (why) { excluded.push({ path: rel, reason: why }); continue; }
    let st; try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, root, out, budget, excluded);
    else if (st.isFile()) out.push(rel);
  }
}

/**
 * Build the rig. Nothing is copied until the secret scan passes, so a failed
 * pack never leaves a half-written directory containing a credential.
 */
export function pack(
  source: string,
  dest: string,
  slug: string,
  dropSkills: string[] = [],
): PackResult {
  const ignore = loadRigsignore(source);
  const included: string[] = [];
  const excluded: { path: string; reason: string }[] = [];

  for (const entry of readdirSync(source)) {
    const reason = denied(entry);
    if (reason) { excluded.push({ path: entry, reason }); continue; }
    if (!PUBLISHABLE.has(entry)) {
      excluded.push({ path: entry, reason: "not a recognised rig component" });
      continue;
    }
    if (matchesIgnore(entry, ignore)) {
      excluded.push({ path: entry, reason: "listed in .rigsignore" });
      continue;
    }

    const abs = join(source, entry);
    let st; try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      const files: string[] = [];
      walk(abs, source, files, { n: 0 }, excluded);

      // A SKILL.md without name/description frontmatter fails
      // `claude plugin validate`, which would make the whole packed rig
      // uninstallable. Drop the offending skill, keep the rest.
      const brokenSkills = new Set<string>();
      if (entry === "skills") {
        for (const rel of files) {
          if (!rel.endsWith("/SKILL.md")) continue;
          let head = "";
          try { head = readFileSync(join(source, rel), "utf8").slice(0, 800); } catch { /* unreadable */ }
          const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
          if (!fm || !/^name\s*:/m.test(fm[1]) || !/^description\s*:/m.test(fm[1])) {
            brokenSkills.add(rel.slice(0, rel.length - "/SKILL.md".length));
          }
        }
      }

      for (const rel of files) {
        if (matchesIgnore(rel, ignore)) { excluded.push({ path: rel, reason: "listed in .rigsignore" }); continue; }
        const owner = [...brokenSkills].find((d) => rel === d + "/SKILL.md" || rel.startsWith(d + "/"));
        if (owner) { excluded.push({ path: rel, reason: "skill is missing name/description frontmatter" }); continue; }
        const rejected = dropSkills.find((d) => rel === d + "/SKILL.md" || rel.startsWith(d + "/"));
        if (rejected) { excluded.push({ path: rel, reason: "rejected by claude plugin validate" }); continue; }
        included.push(rel);
      }
    } else {
      included.push(entry);
    }
  }

  // Scan everything that would ship, BEFORE writing a single byte.
  const findings: SecretFinding[] = [];
  let bytes = 0;
  for (const rel of included) {
    const abs = join(source, rel);
    let text: string;
    try {
      const st = statSync(abs);
      bytes += st.size;
      if (st.size > 512 * 1024) continue;
      text = readFileSync(abs, "utf8");
    } catch { continue; }
    if (rel.endsWith(".json")) {
      try { findings.push(...scanJsonTree(JSON.parse(text), rel)); } catch { /* not JSON */ }
    }
    findings.push(...scanText(text, rel));
  }

  if (findings.some((f) => f.severity === "reject")) {
    return { included, excluded, findings, bytes, written: false };
  }

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const rel of included) {
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    try { copyFileSync(join(source, rel), to); } catch { /* skip unreadable */ }
  }

  mkdirSync(join(dest, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dest, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: slug, description: "My Claude Code rig" }, null, 2) + "\n",
  );

  const kept = [...new Set(included.map((r) => r.split("/")[0]))];
  writeFileSync(
    join(dest, "README.md"),
    `# ${slug}\n\nMy Claude Code rig, published with [Rigs](https://github.com/rigs-dev/registry).\n\n` +
      `Contains: ${kept.join(", ")}\n\n## Install\n\n` +
      "```bash\nclaude plugin marketplace add rigs-dev/registry\n" +
      `claude plugin install ${slug}@rigs\n\`\`\`\n`,
  );

  return { included, excluded, findings, bytes, written: true };
}
