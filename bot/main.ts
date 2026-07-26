/**
 * Rigs indexer — Phase 0.
 *
 * Reads sources/seed.jsonl, and for each rig:
 *   clone (shallow) -> pin sha -> validate -> secret/path lint -> extract -> emit
 *
 * Emits .claude-plugin/marketplace.json (what Claude Code consumes) and
 * data/index.json (what the website renders). We never host a rig's contents;
 * entries point at the author's own repo, pinned by commit sha.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { extract } from "./extract.ts";
import { scanJsonTree, scanText, scanUrl, formatFinding, type SecretFinding } from "./rules/secrets.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARKETPLACE_NAME = "rigs";

interface SeedEntry { repo: string; slug?: string }

interface RigResult {
  repo: string;
  slug: string;
  owner: string;
  name: string;
  tier: "A" | "B";
  sha: string | null;
  status: "ok" | "rejected";
  rejectReasons: string[];
  warnings: string[];
  counts: Record<string, number>;
  rawFileCount: number;
  droppedMirror: number;
  description: string;
  components: { kind: string; name: string; description?: string }[];
}

function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function slugify(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(out) ? out : `rig-${out}`;
}

/** Append-only slug allocation. A published name can never change. */
function allocateSlug(names: Record<string, string>, repo: string, preferred: string): string {
  for (const [slug, r] of Object.entries(names)) if (r === repo) return slug;
  let slug = preferred;
  if (names[slug]) slug = `${preferred}-${repo.split("/")[0].toLowerCase()}`;
  let n = 2;
  while (names[slug]) slug = `${preferred}-${n++}`;
  names[slug] = repo;
  return slug;
}

const LINT_TARGET_JSON = /(^|\/)(settings[^/]*\.json|\.claude\.json|\.mcp\.json|mcp[^/]*\.json)(\.bak)?$/;
const LINT_TARGET_TEXT = /\.(md|sh|bash|zsh|js|cjs|mjs|ts|py)$/;
const ABS_PATH_RE = /(^|["'\s=:])(\/Users\/|\/home\/|\/root\/|[A-Z]:\\\\)/;

function* walkFiles(dir: string, root: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const abs = join(dir, entry);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) yield* walkFiles(abs, root);
    else if (st.isFile() && st.size < 512 * 1024) yield abs.slice(root.length + 1);
  }
}

function lint(dir: string): { findings: SecretFinding[]; pathWarnings: string[] } {
  const findings: SecretFinding[] = [];
  const pathWarnings: string[] = [];

  for (const rel of walkFiles(dir, dir)) {
    const abs = join(dir, rel);
    let text: string;
    try { text = readFileSync(abs, "utf8"); } catch { continue; }

    if (LINT_TARGET_JSON.test(rel)) {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { continue; }
      findings.push(...scanJsonTree(parsed, rel));
      // SEC-04: credentials in MCP server URLs
      const walkUrls = (n: unknown, path: string[]): void => {
        if (typeof n === "string" && /^https?:\/\//.test(n)) {
          const f = scanUrl(n, rel, path.join("."));
          if (f) findings.push(f);
        } else if (Array.isArray(n)) n.forEach((c, i) => walkUrls(c, [...path, String(i)]));
        else if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) walkUrls(v, [...path, k]);
      };
      walkUrls(parsed, []);
    } else if (LINT_TARGET_TEXT.test(rel)) {
      findings.push(...scanText(text, rel));
    }

    // PATH-01: hook commands with machine-specific absolute paths
    if (/hooks\.json$/.test(rel) || /settings[^/]*\.json$/.test(rel)) {
      for (const line of text.split("\n")) {
        if (ABS_PATH_RE.test(line) && /"command"\s*:/.test(line)) {
          pathWarnings.push(`PATH-01 ${rel}: hook command uses a machine-specific absolute path`);
          break;
        }
      }
    }
  }
  return { findings, pathWarnings };
}

function validatePlugin(dir: string): { ok: boolean; strictClean: boolean } {
  const run = (args: string[]): boolean => {
    try { execFileSync("claude", args, { encoding: "utf8", stdio: "pipe" }); return true; }
    catch { return false; }
  };
  // Gate on plain validate. --strict fails even on Anthropic's own marketplace,
  // so its result is only ever a warning badge.
  return { ok: run(["plugin", "validate", dir]), strictClean: run(["plugin", "validate", dir, "--strict"]) };
}

function processRig(entry: SeedEntry, names: Record<string, string>): RigResult {
  const [owner, name] = entry.repo.split("/");
  const url = `https://github.com/${entry.repo}.git`;
  const tmp = mkdtempSync(join(tmpdir(), "rig-"));
  const dir = join(tmp, "r");

  const result: RigResult = {
    repo: entry.repo, owner, name,
    slug: allocateSlug(names, entry.repo, entry.slug || slugify(name)),
    tier: "B", sha: null, status: "rejected", rejectReasons: [], warnings: [],
    counts: {}, rawFileCount: 0, droppedMirror: 0, description: "", components: [],
  };

  try {
    sh("git", ["clone", "--depth=1", "--single-branch", "--filter=blob:none", "-q", url, dir]);
    result.sha = sh("git", ["rev-parse", "HEAD"], dir).trim();

    const hasManifest =
      existsSync(join(dir, ".claude-plugin", "plugin.json")) ||
      existsSync(join(dir, ".claude-plugin", "marketplace.json"));
    result.tier = hasManifest ? "A" : "B";

    if (hasManifest) {
      try {
        const pj = join(dir, ".claude-plugin", "plugin.json");
        if (existsSync(pj)) result.description = JSON.parse(readFileSync(pj, "utf8")).description ?? "";
      } catch { /* description stays empty */ }
    }
    if (!result.description) {
      const readme = ["README.md", "readme.md"].map((f) => join(dir, f)).find(existsSync);
      if (readme) {
        const line = readFileSync(readme, "utf8").split("\n")
          .find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("!") && !l.startsWith("["));
        if (line) result.description = line.trim().slice(0, 300);
      }
    }

    const ex = extract(dir);
    result.counts = ex.counts;
    result.rawFileCount = ex.rawFileCount;
    result.droppedMirror = ex.droppedMirror;
    result.components = ex.components.map((c) => ({ kind: c.kind, name: c.name, description: c.description }));

    const total = Object.values(ex.counts).reduce((a, b) => a + b, 0);
    if (total === 0) result.rejectReasons.push("SUB-01 no components found after mirror exclusion");

    const { findings, pathWarnings } = lint(dir);
    for (const f of findings) {
      if (f.severity === "reject") result.rejectReasons.push(formatFinding(f));
      else result.warnings.push(`${formatFinding(f)} [test fixture]`);
    }
    result.warnings.push(...pathWarnings);

    if (result.tier === "A") {
      const v = validatePlugin(dir);
      if (!v.ok) result.rejectReasons.push("VAL-01 claude plugin validate failed");
      if (v.ok && !v.strictClean) result.warnings.push("VAL-02 missing version or author metadata");
    }

    if (!existsSync(join(dir, "LICENSE")) && !existsSync(join(dir, "LICENSE.md"))) {
      result.warnings.push("LIC-01 no LICENSE file");
    }

    result.status = result.rejectReasons.length === 0 ? "ok" : "rejected";
  } catch (err) {
    result.rejectReasons.push(`clone/index failed: ${(err as Error).message.split("\n")[0]}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  return result;
}

function main(): void {
  const seedPath = join(ROOT, "sources", "seed.jsonl");
  if (!existsSync(seedPath)) throw new Error(`missing ${seedPath}`);
  const seeds: SeedEntry[] = readFileSync(seedPath, "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"))
    .map((l) => JSON.parse(l));

  const namesPath = join(ROOT, "data", "names.json");
  const names: Record<string, string> = existsSync(namesPath)
    ? JSON.parse(readFileSync(namesPath, "utf8")) : {};

  console.log(`indexing ${seeds.length} rigs\n`);
  const results: RigResult[] = [];
  for (const s of seeds) {
    process.stdout.write(`  ${s.repo} … `);
    const r = processRig(s, names);
    results.push(r);
    const n = Object.values(r.counts).reduce((a, b) => a + b, 0);
    console.log(
      r.status === "ok"
        ? `\x1b[32mok\x1b[0m tier ${r.tier}, ${n} components${r.warnings.length ? `, ${r.warnings.length} warning(s)` : ""}`
        : `\x1b[31mrejected\x1b[0m ${r.rejectReasons[0]}`,
    );
  }

  const listable = results.filter((r) => r.status === "ok");
  const marketplace = {
    $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
    name: MARKETPLACE_NAME,
    description: "Community registry of complete Claude Code setups. See how people actually run Claude.",
    owner: { name: "Rigs" },
    plugins: listable
      .filter((r) => r.tier === "A")
      .map((r) => ({
        name: r.slug,
        description: r.description || `${r.owner}'s Claude Code rig`,
        author: { name: r.owner, url: `https://github.com/${r.owner}` },
        homepage: `https://github.com/${r.repo}`,
        source: { source: "url", url: `https://github.com/${r.repo}.git`, ...(r.sha ? { sha: r.sha } : {}) },
      })),
  };

  const index = {
    generatedAt: new Date().toISOString(),
    marketplace: MARKETPLACE_NAME,
    rigs: results.map((r) => ({
      slug: r.slug, repo: r.repo, owner: r.owner, tier: r.tier, status: r.status,
      sha: r.sha, description: r.description, counts: r.counts,
      rawFileCount: r.rawFileCount, droppedMirror: r.droppedMirror,
      warnings: r.warnings, rejectReasons: r.rejectReasons, components: r.components,
    })),
  };

  writeFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), JSON.stringify(marketplace, null, 2) + "\n");
  writeFileSync(join(ROOT, "data", "index.json"), JSON.stringify(index, null, 2) + "\n");
  writeFileSync(namesPath, JSON.stringify(names, null, 2) + "\n");

  const tierA = marketplace.plugins.length;
  console.log(`\n${tierA} installable (tier A), ${listable.length - tierA} browsable (tier B), ${results.length - listable.length} rejected`);
  console.log(`wrote .claude-plugin/marketplace.json and data/index.json`);
}

main();
