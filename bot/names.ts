/**
 * Slug identity, and the assertion that the two emitted artefacts agree.
 *
 * The slug is the install key: `claude plugin install <slug>@rigs`. Once
 * published it can never change, because changing it breaks every existing
 * install silently — no error, just a name that stops resolving.
 *
 * So a rig's identity is NOT its owner/repo string. GitHub renames are free and
 * common, and keying on the repo string means a rename mints a brand new slug
 * and orphans everyone already installed. That shipped:
 * affaan-m/everything-claude-code became affaan-m/ECC, the lookup missed, and
 * the indexer allocated `ecc` beside the live `everything-claude-code`.
 * Hence aliases here, and hence checkEmitAgrees at the bottom.
 */

export interface NameEntry {
  /** Canonical owner/repo as of the most recent run that saw this rig. */
  repo: string;
  /** Every owner/repo it was published under before, oldest first. */
  aliases?: string[];
}

export type NameRegistry = Record<string, NameEntry>;

/** GitHub repo names are case-insensitive, so a case-only rename is not one. */
function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Read data/names.json, migrating the legacy flat `{slug: "owner/repo"}` form.
 * Migration happens on read so the file on disk keeps working untouched; the
 * new shape is written back on the next emit. Nothing is dropped.
 */
export function loadNames(raw: unknown): NameRegistry {
  const out: NameRegistry = {};
  if (!raw || typeof raw !== "object") return out;

  for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[slug] = { repo: value };
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const entry = value as { repo?: unknown; aliases?: unknown };
    if (typeof entry.repo !== "string") continue;
    const aliases = Array.isArray(entry.aliases)
      ? entry.aliases.filter((a): a is string => typeof a === "string" && !sameRepo(a, entry.repo as string))
      : [];
    out[slug] = aliases.length ? { repo: entry.repo, aliases } : { repo: entry.repo };
  }
  return out;
}

/** The slug this repo is published under, matching its current name or any alias. */
export function findSlug(names: NameRegistry, repo: string): string | undefined {
  for (const [slug, entry] of Object.entries(names)) {
    if (sameRepo(entry.repo, repo)) return slug;
    if (entry.aliases?.some((a) => sameRepo(a, repo))) return slug;
  }
  return undefined;
}

/**
 * A rig we already know moved from `from` to `to`. Keep its slug — that is the
 * whole point — and demote the name it moved off to an alias so the old string
 * still resolves. Returns the preserved slug, or undefined if `from` was never
 * known to us.
 */
export function recordRename(names: NameRegistry, from: string, to: string): string | undefined {
  const slug = findSlug(names, from);
  if (!slug) return undefined;

  const entry = names[slug];
  if (sameRepo(entry.repo, to)) return slug;

  // Renaming back to a former name retires that alias rather than duplicating it.
  const aliases: string[] = [];
  for (const a of [...(entry.aliases ?? []), entry.repo]) {
    if (!sameRepo(a, to) && !aliases.some((seen) => sameRepo(seen, a))) aliases.push(a);
  }
  names[slug] = aliases.length ? { repo: to, aliases } : { repo: to };
  return slug;
}

/**
 * Append-only. A published name can never change — installs key on it.
 * Looks the rig up by its current name or any name it used to have, so a
 * rename keeps the slug instead of minting a second one.
 */
export function allocateSlug(names: NameRegistry, repo: string, preferred: string): string {
  const existing = findSlug(names, repo);
  if (existing) {
    // Matched through an alias: `repo` is the new canonical name, so promote it.
    if (!sameRepo(names[existing].repo, repo)) recordRename(names, names[existing].repo, repo);
    return existing;
  }

  let slug = preferred;
  if (names[slug]) slug = `${preferred}-${repo.split("/")[0].toLowerCase()}`;
  let n = 2;
  while (names[slug]) slug = `${preferred}-${n++}`;
  names[slug] = { repo };
  return slug;
}

/** Serialise back to data/names.json, dropping empty alias lists. */
export function serializeNames(names: NameRegistry): NameRegistry {
  const out: NameRegistry = {};
  for (const [slug, entry] of Object.entries(names)) {
    out[slug] = entry.aliases?.length ? { repo: entry.repo, aliases: entry.aliases } : { repo: entry.repo };
  }
  return out;
}

export interface EmitRig {
  slug: string;
  tier: "A" | "B";
  listable: boolean;
  publishSha: string | null;
}

/**
 * The two emitted artefacts must describe the same set of installable rigs.
 * data/index.json is what the website renders; .claude-plugin/marketplace.json
 * is what `claude plugin install` resolves. A slug in one and not the other is
 * either a dead link or a broken install, and both have already shipped.
 *
 * Returns one line per disagreement; empty means they agree.
 */
export function checkEmitAgrees(rigs: EmitRig[], plugins: { name: string }[]): string[] {
  const expected = new Set(
    rigs.filter((r) => r.listable && r.tier === "A" && r.publishSha).map((r) => r.slug),
  );
  const published = new Set(plugins.map((p) => p.name));
  const problems: string[] = [];

  for (const slug of expected) {
    if (!published.has(slug)) problems.push(`${slug}: installable in data/index.json but missing from marketplace.json`);
  }
  for (const slug of published) {
    if (!expected.has(slug)) problems.push(`${slug}: published in marketplace.json but not an installable rig in data/index.json`);
  }
  return problems;
}
