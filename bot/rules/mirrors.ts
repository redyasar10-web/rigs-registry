/**
 * Mirror-tree exclusion and dedupe.
 *
 * Harness repos ship the same component at many paths: tool-specific mirrors
 * (.agents/, .kiro/, .cursor/) and translated doc copies (docs/zh-CN/...).
 * Measured on affaan-m/everything-claude-code: 397 SKILL.md files, of which
 * only 125 are real. docs/ alone was 214 of them (54%).
 *
 * Content hashing does NOT solve this on its own — translated copies have
 * genuinely different bytes, so hashing collapsed 397 -> 368. Path exclusion
 * must run first; hashing is a cheap second pass for exact duplicates.
 */

/** Directory names that are never the canonical home of a component. */
export const EXCLUDED_SEGMENTS = new Set([
  // other-runtime mirrors
  ".agents", ".kiro", ".opencode", ".codex", ".cursor", ".windsurf", ".gemini",
  // repo infrastructure
  ".github", ".git", "node_modules", "vendor", "dist", "build", "out", "target",
  // fixtures and tests
  "fixtures", "__tests__", "__snapshots__", "tests", "test", "examples", "example",
]);

/** Locale directory segments, e.g. docs/zh-CN/skills/foo/SKILL.md */
const LOCALE_RE =
  /^(zh|zh-cn|zh-tw|zh-hans|zh-hant|ja|ko|es|fr|de|pt|pt-br|ru|tr|it|hi|ar|vi|th|id|pl|nl|uk|cs|sv|da|fi|no|he|fa|ro|hu|el)$/i;

/** Path prefixes that are documentation, not live components. */
const EXCLUDED_PREFIXES = ["docs/", "doc/", "website/", "site/"];

/**
 * True if a repo-relative path lives in a mirror/translation/doc tree and so
 * must not be counted as a real component.
 */
export function isMirrorPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const lower = p.toLowerCase();

  if (EXCLUDED_PREFIXES.some((pre) => lower.startsWith(pre))) return true;

  for (const seg of p.split("/")) {
    if (EXCLUDED_SEGMENTS.has(seg)) return true;
    if (LOCALE_RE.test(seg)) return true;
  }
  return false;
}

export interface Discovered {
  /** repo-relative path */
  path: string;
  /** sha256 of normalized content */
  hash: string;
}

export interface DedupeResult<T extends Discovered> {
  kept: T[];
  droppedMirror: number;
  droppedDuplicate: number;
  rawCount: number;
}

/** Depth is the tiebreak: the shallowest path wins as canonical. */
function depth(p: string): number {
  return p.split("/").length;
}

/**
 * Exclude mirror trees, then collapse exact-content duplicates.
 * Reports both counts so the gap between raw and real stays auditable.
 */
export function excludeAndDedupe<T extends Discovered>(items: T[]): DedupeResult<T> {
  const rawCount = items.length;

  const nonMirror = items.filter((i) => !isMirrorPath(i.path));
  const droppedMirror = rawCount - nonMirror.length;

  // Shallowest path wins; ties broken lexicographically for determinism.
  const ordered = [...nonMirror].sort(
    (a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path),
  );

  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of ordered) {
    if (seen.has(item.hash)) continue;
    seen.add(item.hash);
    kept.push(item);
  }

  return {
    kept,
    droppedMirror,
    droppedDuplicate: nonMirror.length - kept.length,
    rawCount,
  };
}
