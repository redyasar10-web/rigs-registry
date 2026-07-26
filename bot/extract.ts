/**
 * Component discovery and metadata extraction for a cloned rig.
 *
 * Discovery walks the whole tree rather than assuming a plugin layout, because
 * a rig is often just someone's `.claude/` directory. Mirror exclusion then
 * removes the tool-specific and translated copies.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { excludeAndDedupe, isMirrorPath, type Discovered } from "./rules/mirrors.ts";

export type ComponentKind = "skill" | "agent" | "command" | "hook" | "mcp";

export interface Component extends Discovered {
  kind: ComponentKind;
  /** Component identifier (skill dir name, agent/command file stem) */
  name: string;
  description?: string;
}

export interface ExtractResult {
  components: Component[];
  counts: Record<ComponentKind, number>;
  rawFileCount: number;
  droppedMirror: number;
  droppedDuplicate: number;
}

const SKIP_WALK = new Set([".git", "node_modules"]);
const MAX_FILE_BYTES = 100 * 1024;

function* walk(dir: string, root: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_WALK.has(entry)) continue;
      yield* walk(abs, root);
    } else if (st.isFile()) {
      yield relative(root, abs).split(sep).join("/");
    }
  }
}

function sha256(buf: string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Normalize so trivial whitespace differences don't defeat dedupe. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

/** Minimal YAML frontmatter reader — only top-level scalar keys. */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    v = v.replace(/^["'](.*)["']$/, "$1");
    if (v) out[kv[1]] = v;
  }
  return out;
}

function classify(path: string): { kind: ComponentKind; name: string } | null {
  const parts = path.split("/");
  const file = parts[parts.length - 1];

  if (file === "SKILL.md" && parts.length >= 2) {
    return { kind: "skill", name: parts[parts.length - 2] };
  }
  if (file === "hooks.json" && parts.includes("hooks")) {
    return { kind: "hook", name: "hooks" };
  }
  if (file === ".mcp.json") {
    return { kind: "mcp", name: "mcp" };
  }
  if (file.endsWith(".md")) {
    const i = parts.lastIndexOf("agents");
    if (i !== -1 && i < parts.length - 1) {
      return { kind: "agent", name: file.replace(/\.md$/, "") };
    }
    const j = parts.lastIndexOf("commands");
    if (j !== -1 && j < parts.length - 1) {
      const group = parts.slice(j + 1, -1).join(":");
      const stem = file.replace(/\.md$/, "");
      return { kind: "command", name: group ? `${group}:${stem}` : stem };
    }
  }
  return null;
}

export function extract(repoDir: string): ExtractResult {
  const found: Component[] = [];
  let rawFileCount = 0;

  for (const rel of walk(repoDir, repoDir)) {
    const c = classify(rel);
    if (!c) continue;
    rawFileCount++;

    let text: string;
    try {
      const st = statSync(join(repoDir, rel));
      if (st.size > MAX_FILE_BYTES) continue;
      text = readFileSync(join(repoDir, rel), "utf8");
    } catch {
      continue;
    }

    const fm = c.kind === "skill" || c.kind === "agent" || c.kind === "command"
      ? parseFrontmatter(text)
      : {};

    found.push({
      kind: c.kind,
      name: fm.name || c.name,
      description: fm.description,
      path: rel,
      hash: sha256(normalize(text)),
    });
  }

  const { kept, droppedMirror, droppedDuplicate } = excludeAndDedupe(found);

  const counts: Record<ComponentKind, number> = {
    skill: 0, agent: 0, command: 0, hook: 0, mcp: 0,
  };
  for (const c of kept) counts[c.kind]++;

  return { components: kept, counts, rawFileCount, droppedMirror, droppedDuplicate };
}

export { isMirrorPath };
