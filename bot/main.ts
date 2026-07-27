/**
 * Rigs indexer.
 *
 * discover -> skip-unchanged -> clone -> pin sha -> validate -> lint ->
 * extract -> derivative check -> owner quota -> score -> emit
 *
 * Emits .claude-plugin/marketplace.json (what Claude Code consumes) and
 * data/index.json (what the website renders). We host nothing: every entry
 * points at the author's own repo, pinned to a commit sha.
 *
 * There is no human approval path anywhere in this file, by design. The only
 * human lever is data/blocklist.json, which can subtract but never approve.
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { extract } from "./extract.ts";
import { scanJsonTree, scanText, scanUrl, formatFinding, type SecretFinding } from "./rules/secrets.ts";
import {
  searchTopic, fetchRepoMeta, mergeSources, resolveCanonicalRepo,
  DISCOVERY_TOPIC, type DiscoveredRepo,
} from "./discover.ts";
import {
  EMPTY_STATE, initRepo, applyOutcome, markWithdrawn, selectBatch, isUnchanged,
  tombstoneExpired, renameRepoKey, type IndexState, type RepoState,
} from "./state.ts";
import {
  loadNames, allocateSlug, findSlug, recordRename, serializeNames, checkEmitAgrees,
  type NameRegistry,
} from "./names.ts";
import { trustScore, isStale, detectDerivative, applyOwnerQuota } from "./score.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARKETPLACE_NAME = "rigs";
const REGISTRY_REPO = "redyasar10-web/rigs-registry";
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? "120");
/** Abort rather than commit if a run would delist more than this share. */
const CANARY_DELIST_RATIO = 0.2;
const MAX_FILES = 20_000;

interface Blocklist {
  repos?: Record<string, { reason: string }>;
  owners?: Record<string, { reason: string }>;
  slugs?: Record<string, { reason: string }>;
}

interface RigRecord {
  slug: string;
  repo: string;
  owner: string;
  name: string;
  tier: "A" | "B";
  listable: boolean;
  publishSha: string | null;
  headSha: string | null;
  servingStale: boolean;
  health: string;
  note?: string;
  description: string;
  counts: Record<string, number>;
  componentTotal: number;
  rawFileCount: number;
  droppedMirror: number;
  warnings: string[];
  rejectReasons: string[];
  components: { kind: string; name: string; description?: string }[];
  stars: number;
  pushedAt: string;
  createdAt: string;
  license: string | null;
  isFork: boolean;
  isDerivative: boolean;
  derivativeOf?: string;
  stale: boolean;
  score: number;
}

function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function slugify(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(out) ? out : `rig-${out}`;
}

const LINT_TARGET_JSON = /(^|\/)(settings[^/]*\.json|\.claude\.json|\.mcp\.json|mcp[^/]*\.json)(\.bak)?$/;
const LINT_TARGET_TEXT = /\.(md|sh|bash|zsh|js|cjs|mjs|ts|py)$/;
const ABS_PATH_RE = /(^|["'\s=:])(\/Users\/|\/home\/|\/root\/|[A-Z]:\\\\)/;

function* walkFiles(dir: string, root: string, budget: { n: number }): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules") continue;
    if (budget.n++ > MAX_FILES) return;
    const abs = join(dir, entry);
    let st; try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) yield* walkFiles(abs, root, budget);
    else if (st.isFile() && st.size < 512 * 1024) yield abs.slice(root.length + 1);
  }
}

function lint(dir: string): { findings: SecretFinding[]; pathWarnings: string[]; fileCount: number } {
  const findings: SecretFinding[] = [];
  const pathWarnings: string[] = [];
  const budget = { n: 0 };

  for (const rel of walkFiles(dir, dir, budget)) {
    let text: string;
    try { text = readFileSync(join(dir, rel), "utf8"); } catch { continue; }

    if (LINT_TARGET_JSON.test(rel)) {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { continue; }
      findings.push(...scanJsonTree(parsed, rel));
      const urls = (n: unknown, p: string[]): void => {
        if (typeof n === "string" && /^https?:\/\//.test(n)) {
          const f = scanUrl(n, rel, p.join(".")); if (f) findings.push(f);
        } else if (Array.isArray(n)) n.forEach((c, i) => urls(c, [...p, String(i)]));
        else if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) urls(v, [...p, k]);
      };
      urls(parsed, []);
    } else if (LINT_TARGET_TEXT.test(rel)) {
      findings.push(...scanText(text, rel));
    }

    if (/hooks\.json$/.test(rel) || /settings[^/]*\.json$/.test(rel)) {
      for (const line of text.split("\n")) {
        if (ABS_PATH_RE.test(line) && /"command"\s*:/.test(line)) {
          pathWarnings.push(`PATH-01 ${rel}: hook command uses a machine-specific absolute path`);
          break;
        }
      }
    }
  }
  return { findings, pathWarnings, fileCount: budget.n };
}

function validatePlugin(dir: string): { ok: boolean; strictClean: boolean } {
  const run = (args: string[]): boolean => {
    try { execFileSync("claude", args, { encoding: "utf8", stdio: "pipe" }); return true; }
    catch { return false; }
  };
  // Gate on plain validate only. --strict exits 1 on Anthropic's OWN
  // marketplace (missing version/author), so it can never be a gate.
  return { ok: run(["plugin", "validate", dir]), strictClean: run(["plugin", "validate", dir, "--strict"]) };
}

interface Processed {
  passed: boolean;
  headSha: string | null;
  vanished: boolean;
  tier: "A" | "B";
  description: string;
  counts: Record<string, number>;
  componentTotal: number;
  rawFileCount: number;
  droppedMirror: number;
  warnings: string[];
  rejectReasons: string[];
  components: { kind: string; name: string; description?: string }[];
  componentHashes: string[];
}

function processRig(repo: string): Processed {
  const url = `https://github.com/${repo}.git`;
  const tmp = mkdtempSync(join(tmpdir(), "rig-"));
  const dir = join(tmp, "r");
  const out: Processed = {
    passed: false, headSha: null, vanished: false, tier: "B", description: "",
    counts: {}, componentTotal: 0, rawFileCount: 0, droppedMirror: 0,
    warnings: [], rejectReasons: [], components: [], componentHashes: [],
  };

  try {
    try {
      sh("git", ["clone", "--depth=1", "--single-branch", "--filter=blob:none", "-q", url, dir]);
    } catch {
      out.vanished = true;
      out.rejectReasons.push("repository could not be cloned (deleted, private, or renamed)");
      return out;
    }

    out.headSha = sh("git", ["rev-parse", "HEAD"], dir).trim();

    const pluginJson = join(dir, ".claude-plugin", "plugin.json");
    const mktJson = join(dir, ".claude-plugin", "marketplace.json");
    out.tier = existsSync(pluginJson) || existsSync(mktJson) ? "A" : "B";

    if (existsSync(pluginJson)) {
      try { out.description = JSON.parse(readFileSync(pluginJson, "utf8")).description ?? ""; } catch { /* keep empty */ }
    }
    if (!out.description) {
      const readme = ["README.md", "readme.md"].map((f) => join(dir, f)).find(existsSync);
      if (readme) {
        const line = readFileSync(readme, "utf8").split("\n")
          .find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("!") && !l.startsWith("[") && !l.startsWith("<"));
        if (line) out.description = line.trim().slice(0, 300);
      }
    }

    const ex = extract(dir);
    out.counts = ex.counts;
    out.rawFileCount = ex.rawFileCount;
    out.droppedMirror = ex.droppedMirror;
    out.components = ex.components.map((c) => ({ kind: c.kind, name: c.name, description: c.description }));
    out.componentHashes = ex.components.map((c) => c.hash);
    out.componentTotal = Object.values(ex.counts).reduce((a, b) => a + b, 0);

    if (out.componentTotal === 0) {
      out.rejectReasons.push("SUB-01 no components found after mirror exclusion");
    }

    const { findings, pathWarnings, fileCount } = lint(dir);
    for (const f of findings) {
      if (f.severity === "reject") out.rejectReasons.push(formatFinding(f));
      else out.warnings.push(`${formatFinding(f)} [test fixture]`);
    }
    out.warnings.push(...pathWarnings);
    if (fileCount > MAX_FILES) out.rejectReasons.push(`SZ-01 repository exceeds ${MAX_FILES} files`);

    if (out.tier === "A") {
      const v = validatePlugin(dir);
      if (!v.ok) out.rejectReasons.push("VAL-01 claude plugin validate failed");
      else if (!v.strictClean) out.warnings.push("VAL-02 missing version or author metadata");
    }

    if (!existsSync(join(dir, "LICENSE")) && !existsSync(join(dir, "LICENSE.md"))) {
      out.warnings.push("LIC-01 no LICENSE file");
    }

    out.passed = out.rejectReasons.length === 0;
  } catch (err) {
    out.rejectReasons.push(`indexing failed: ${(err as Error).message.split("\n")[0]}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

function emptyProcessed(): Processed {
  return {
    passed: true, headSha: null, vanished: false, tier: "B", description: "",
    counts: {}, componentTotal: 0, rawFileCount: 0, droppedMirror: 0,
    warnings: [], rejectReasons: [], components: [], componentHashes: [],
  };
}

/**
 * Reuse the previous run's extracted data for a rig we deliberately skipped.
 * Falls back to matching on the slug, because the previous index still names a
 * renamed rig by the repo string it moved off — and missing here would zero its
 * component count and quietly delist it on the very run that renamed it.
 */
function carriedProcessed(prevIndex: { rigs: RigRecord[] }, repo: string, names: NameRegistry): Processed {
  const slug = findSlug(names, repo);
  const found = prevIndex.rigs.find((r) => r.repo === repo || (slug !== undefined && r.slug === slug));
  if (!found) return emptyProcessed();
  return {
    passed: true, headSha: found.headSha, vanished: false,
    tier: found.tier, description: found.description,
    counts: found.counts, componentTotal: found.componentTotal,
    rawFileCount: found.rawFileCount, droppedMirror: found.droppedMirror,
    warnings: found.warnings, rejectReasons: [],
    components: found.components, componentHashes: [],
  };
}

function buildRecord(a: {
  disc: DiscoveredRepo; owner: string; name: string; prev: RepoState;
  publishSha: string | null; listable: boolean; servingStale: boolean;
  proc: Processed; names: NameRegistry;
  knownHashes: Record<string, { hashes: string[]; firstIndexedAt: string }>;
  now: Date; note?: string;
}): RigRecord {
  const { disc, owner, name, proc } = a;
  const slug = allocateSlug(a.names, disc.repo, slugify(name));
  const der = proc.componentHashes.length
    ? detectDerivative(disc.repo, proc.componentHashes, a.knownHashes)
    : { isDerivative: false as const };

  const score = trustScore({
    stars: disc.stars,
    pushedAt: disc.pushedAt,
    createdAt: disc.createdAt,
    componentTotal: proc.componentTotal,
    hasDescription: Boolean(proc.description),
    hasLicense: !proc.warnings.some((w) => w.startsWith("LIC-01")),
    warningCount: proc.warnings.length,
    isFork: disc.fork,
    isDerivative: der.isDerivative,
  }, a.now);

  return {
    slug, repo: disc.repo, owner, name,
    tier: proc.tier,
    listable: a.listable && proc.componentTotal > 0,
    publishSha: a.publishSha,
    headSha: proc.headSha,
    servingStale: a.servingStale,
    health: a.prev.health,
    note: a.note,
    description: proc.description,
    counts: proc.counts,
    componentTotal: proc.componentTotal,
    rawFileCount: proc.rawFileCount,
    droppedMirror: proc.droppedMirror,
    warnings: proc.warnings,
    rejectReasons: proc.rejectReasons,
    components: proc.components,
    stars: disc.stars,
    pushedAt: disc.pushedAt,
    createdAt: disc.createdAt,
    license: disc.license,
    isFork: disc.fork,
    isDerivative: der.isDerivative,
    derivativeOf: der.derivativeOf,
    stale: isStale(disc.pushedAt, a.now),
    score,
  };
}

/**
 * Reconcile repo renames before anything keys on a repo string.
 *
 * Two directions, because a rename surfaces from either end:
 *  - forward: a seed still names a repo that has since moved. Checked only for
 *    repos we have never indexed — the topic search already reports GitHub's
 *    canonical full_name, and an authenticated fetchRepoMeta follows the 301
 *    itself. Getting it right matters most here, because this is the run that
 *    mints the slug and after that the name is permanent.
 *  - reverse: a rig we already published has dropped out of discovery because
 *    discovery found it under its NEW name. This is the one that broke
 *    production: the lookup missed, a second slug was minted, and everyone on
 *    the first one was silently orphaned.
 *
 * Bounded on purpose — one HEAD per unresolved repo, never one per rig per run.
 */
async function reconcileRenames(
  all: DiscoveredRepo[],
  names: NameRegistry,
  state: IndexState,
): Promise<{ all: DiscoveredRepo[]; state: IndexState }> {
  // Nothing to carry in this direction: we only look when the repo is unknown
  // to both names.json and state.json, so there is no history under either name.
  const resolved: DiscoveredRepo[] = [];
  for (const disc of all) {
    if (findSlug(names, disc.repo) || state.repos[disc.repo]) {
      resolved.push(disc);
      continue;
    }
    const canonical = await resolveCanonicalRepo(disc.repo);
    if (canonical && canonical !== disc.repo) {
      console.log(`  rename: ${disc.repo} -> ${canonical} (before first index)`);
      resolved.push({ ...disc, repo: canonical });
    } else {
      resolved.push(disc);
    }
  }

  let next = state;

  // Canonicalising can collapse two discovery entries onto one repo; seeds win.
  const deduped = new Map<string, DiscoveredRepo>();
  for (const r of resolved) if (!deduped.has(r.repo) || r.seeded) deduped.set(r.repo, r);
  const discovered = new Set(deduped.keys());

  for (const entry of Object.values(names)) {
    if (discovered.has(entry.repo)) continue;
    const canonical = await resolveCanonicalRepo(entry.repo);
    if (!canonical || canonical === entry.repo || !discovered.has(canonical)) continue;
    const slug = recordRename(names, entry.repo, canonical);
    next = renameRepoKey(next, entry.repo, canonical);
    console.log(`  rename: ${entry.repo} -> ${canonical} (slug ${slug} preserved)`);
  }

  return { all: [...deduped.values()], state: next };
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const now = new Date();
  const nowIso = now.toISOString();

  const statePath = join(ROOT, "data", "state.json");
  const namesPath = join(ROOT, "data", "names.json");
  let state = readJson<IndexState>(statePath, EMPTY_STATE);
  const names = loadNames(readJson<unknown>(namesPath, {}));
  const blocklist = readJson<Blocklist>(join(ROOT, "data", "blocklist.json"), {});
  const previousIndex = readJson<{ rigs: RigRecord[] }>(join(ROOT, "data", "index.json"), { rigs: [] });

  // ── discover ────────────────────────────────────────────────────────────
  const seedPath = join(ROOT, "sources", "seed.jsonl");
  const seedRepos: string[] = existsSync(seedPath)
    ? readFileSync(seedPath, "utf8").split("\n").map((l) => l.trim())
        .filter((l) => l && !l.startsWith("//")).map((l) => JSON.parse(l).repo as string)
    : [];

  let topicRepos: DiscoveredRepo[] = [];
  if (token || process.env.RIGS_ALLOW_ANON_SEARCH) {
    try {
      const r = await searchTopic(token);
      topicRepos = r.repos;
      console.log(`discovery: ${topicRepos.length} repos with topic:${DISCOVERY_TOPIC} (rate ${r.rate.remaining}/${r.rate.limit})`);
    } catch (e) {
      console.warn(`discovery failed, continuing with seeds only: ${(e as Error).message}`);
    }
  } else {
    console.log(`discovery: skipped (no GITHUB_TOKEN) — using ${seedRepos.length} seeded repos`);
  }

  const seeded: DiscoveredRepo[] = [];
  for (const repo of seedRepos) {
    const meta = token ? await fetchRepoMeta(repo, token) : null;
    // Offline fallback: reuse the last push marker we recorded rather than
    // stamping "now", otherwise nothing ever looks unchanged and every local
    // run re-clones the entire corpus.
    const carried = state.repos[repo]?.lastSeenPush;
    seeded.push(meta ?? {
      repo,
      pushedAt: carried ?? nowIso,
      createdAt: state.repos[repo]?.firstIndexedAt ?? nowIso,
      stars: 0, fork: false, archived: false, license: null, seeded: true,
    });
  }

  let all = mergeSources(topicRepos, seeded);

  // ── blocklist: subtractive only, applied before any work ────────────────
  const blockedRepos = new Set(Object.keys(blocklist.repos ?? {}));
  const blockedOwners = new Set(Object.keys(blocklist.owners ?? {}));
  const before = all.length;
  all = all.filter((r) => !blockedRepos.has(r.repo) && !blockedOwners.has(r.repo.split("/")[0]));
  if (before !== all.length) console.log(`blocklist: removed ${before - all.length}`);

  // ── renames: before anything keys on a repo string ──────────────────────
  // Must precede the withdrawal sweep below, or a rig that was merely renamed
  // gets tombstoned under the name it moved off.
  ({ all, state } = await reconcileRenames(all, names, state));

  // ── withdrawals: known to us but no longer discoverable ─────────────────
  const discoveredSet = new Set(all.map((r) => r.repo));
  for (const [repo, s] of Object.entries(state.repos)) {
    if (!discoveredSet.has(repo) && s.health !== "gone") {
      state.repos[repo] = markWithdrawn(s, nowIso);
      console.log(`  withdrawn: ${repo} (topic removed or no longer discoverable)`);
    }
  }

  // ── batch ───────────────────────────────────────────────────────────────
  const batch = new Set(selectBatch(all.map((r) => r.repo), state, BATCH_SIZE));
  console.log(`processing ${batch.size} of ${all.length} rigs this run\n`);

  const records: RigRecord[] = [];
  const knownHashes: Record<string, { hashes: string[]; firstIndexedAt: string }> = {};
  for (const [repo, s] of Object.entries(state.repos)) {
    if (s.componentHashes?.length) knownHashes[repo] = { hashes: s.componentHashes, firstIndexedAt: s.firstIndexedAt };
  }

  for (const disc of all) {
    const { repo } = disc;
    const [owner, name] = repo.split("/");
    const prev = state.repos[repo] ?? initRepo(nowIso);

    const shouldSkip = !batch.has(repo) || isUnchanged(prev, disc.pushedAt);

    if (shouldSkip) {
      if (batch.has(repo)) console.log(`  ${repo} … unchanged`);
      if (!prev.lastGoodSha) { state.repos[repo] = { ...prev, lastSeenPush: disc.pushedAt }; continue; }
      records.push(buildRecord({
        disc, owner, name, prev, publishSha: prev.lastGoodSha,
        listable: prev.health === "ok", servingStale: prev.health !== "ok",
        proc: carriedProcessed(previousIndex, repo, names), names, knownHashes, now,
      }));
      state.repos[repo] = { ...prev, lastSeenPush: disc.pushedAt };
      continue;
    }

    process.stdout.write(`  ${repo} … `);
    const proc = processRig(repo);

    const { next, resolution } = applyOutcome(
      prev,
      { passed: proc.passed, sha: proc.headSha, vanished: proc.vanished, componentHashes: proc.componentHashes },
      nowIso,
    );
    next.lastSeenPush = disc.pushedAt;
    state.repos[repo] = next;

    if (disc.archived) {
      resolution.listable = false;
      resolution.note = "repository is archived";
    }

    const rec = buildRecord({
      disc, owner, name, prev: next, publishSha: resolution.publishSha,
      listable: resolution.listable, servingStale: resolution.servingStale,
      proc, names, knownHashes, now, note: resolution.note,
    });
    records.push(rec);

    if (proc.passed && proc.componentHashes.length) {
      knownHashes[repo] = { hashes: proc.componentHashes, firstIndexedAt: next.firstIndexedAt };
    }

    console.log(
      rec.listable
        ? `\x1b[32mok\x1b[0m tier ${rec.tier}, ${rec.componentTotal} components` +
          (rec.servingStale ? " \x1b[33m(serving last good sha)\x1b[0m" : "") +
          (rec.warnings.length ? `, ${rec.warnings.length} warning(s)` : "")
        : `\x1b[31mnot listed\x1b[0m ${rec.rejectReasons[0] ?? rec.note ?? ""}`,
    );
  }

  // ── owner quota ─────────────────────────────────────────────────────────
  const { surplus } = applyOwnerQuota(
    records.filter((r) => r.listable).map((r) => ({ owner: r.owner, score: r.score, repo: r.repo })),
  );
  const surplusRepos = new Set(surplus.map((s) => s.repo));
  for (const r of records) {
    if (surplusRepos.has(r.repo)) {
      r.listable = false;
      r.note = "over the per-owner limit for this account";
    }
  }
  if (surplus.length) console.log(`\nowner quota: ${surplus.length} rig(s) held back`);

  // ── canary: never mass-delist on a tooling change ───────────────────────
  const prevListable = previousIndex.rigs.filter((r) => r.listable).length;
  const nowListable = records.filter((r) => r.listable).length;
  if (prevListable > 0 && nowListable < prevListable * (1 - CANARY_DELIST_RATIO)) {
    console.error(
      `\n\x1b[31mABORT\x1b[0m listable count fell ${prevListable} -> ${nowListable} ` +
      `(more than ${CANARY_DELIST_RATIO * 100}%). Refusing to write.\n` +
      `This is far more likely a validator or tooling change than ${prevListable - nowListable} rigs breaking at once.`,
    );
    process.exit(3);
  }

  // ── emit ────────────────────────────────────────────────────────────────
  records.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));

  const marketplace = {
    $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
    name: MARKETPLACE_NAME,
    description: "Community registry of complete Claude Code setups. See how people actually run Claude.",
    owner: { name: "Rigs", url: `https://github.com/${REGISTRY_REPO}` },
    plugins: records
      .filter((r) => r.listable && r.tier === "A" && r.publishSha)
      .map((r) => ({
        name: r.slug,
        description: (r.description || `${r.owner}'s Claude Code rig`).slice(0, 300),
        author: { name: r.owner, url: `https://github.com/${r.owner}` },
        homepage: `https://github.com/${r.repo}`,
        source: { source: "url" as const, url: `https://github.com/${r.repo}.git`, sha: r.publishSha as string },
      })),
  };

  // Drop expired tombstones so the index cannot grow without bound.
  const visible = records.filter((r) => {
    const s = state.repos[r.repo];
    return !(s && s.health === "gone" && tombstoneExpired(s, now));
  });

  const index = {
    generatedAt: nowIso,
    marketplace: MARKETPLACE_NAME,
    registryRepo: REGISTRY_REPO,
    topic: DISCOVERY_TOPIC,
    rigs: visible,
  };

  // ── consistency: the two artefacts must describe the same install set ───
  // Checked before a single byte is written, so a disagreement leaves the last
  // known-good pair on disk rather than a half-corrected one. A slug present in
  // only one of them is a dead link or a broken install — both have shipped.
  const problems = checkEmitAgrees(index.rigs, marketplace.plugins);
  if (problems.length) {
    console.error(`\n\x1b[31mABORT\x1b[0m data/index.json and marketplace.json disagree:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("\nNothing was written. This is a bug in the indexer, not in the rigs.");
    process.exit(1);
  }

  writeFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), JSON.stringify(marketplace, null, 2) + "\n");
  writeFileSync(join(ROOT, "data", "index.json"), JSON.stringify(index, null, 2) + "\n");
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  writeFileSync(namesPath, JSON.stringify(serializeNames(names), null, 2) + "\n");

  const tierB = visible.filter((r) => r.listable && r.tier === "B").length;
  console.log(
    `\n${marketplace.plugins.length} installable, ${tierB} browsable, ` +
    `${visible.length - marketplace.plugins.length - tierB} not listed`,
  );
  console.log("wrote .claude-plugin/marketplace.json, data/index.json, data/state.json");
}

await main();
