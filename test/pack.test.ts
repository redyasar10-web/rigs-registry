/**
 * `rigs pack` verification. Run: node --experimental-strip-types test/pack.test.ts
 *
 * pack() is the only command that reads a live ~/.claude, so its exclusion list
 * is a safety boundary rather than a convenience. Two things must hold:
 *   1. Everything on the hard-deny list stays out, and .rigsignore cannot put
 *      it back — settings.local.json sits at the root next to publishable files.
 *   2. If a credential survives into the packed set, NOTHING is written. A
 *      half-written directory holding a live key is the worst possible failure.
 *
 * Fixtures are synthetic ~/.claude-shaped trees in os.tmpdir(). Every credential
 * below is invented; none is or ever was live.
 */

import { pack, matchesIgnore, loadRigsignore, type PackResult } from "../cli/pack.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  \x1b[32m✔\x1b[0m ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  \x1b[31m✘\x1b[0m ${name}${detail ? "  " + detail : ""}`); }
}

const temps: string[] = [];

/** Build a synthetic ~/.claude from a path → contents map. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rigs-pack-src-"));
  temps.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

/** A destination path that does not exist yet, so "wrote nothing" is checkable. */
function destination(): string {
  const parent = mkdtempSync(join(tmpdir(), "rigs-pack-out-"));
  temps.push(parent);
  return join(parent, "packed");
}

const skill = (desc: string, body = "Body.\n") =>
  `---\nname: thing\ndescription: ${desc}\n---\n\n${body}`;

const reasonFor = (r: PackResult, path: string) => r.excluded.find((e) => e.path === path)?.reason ?? "";
const rejects = (r: PackResult) => r.findings.filter((f) => f.severity === "reject");

console.log("\n── exclusion ──");

const messy = fixture({
  "CLAUDE.md": "# my rig\n",
  "settings.json": '{"model":"opus"}\n',
  "settings.local.json": '{"permissions":{"allow":["Bash(ls)"]}}\n',
  "settings.json.bak": '{"permissions":{"allow":["Bash(ls)"]}}\n',
  ".claude.json": '{"mcpServers":{}}\n',
  "history.jsonl": '{"prompt":"what did I type"}\n',
  "projects/some-project/notes.md": "a prompt log\n",
  "sessions/abc.json": "{}\n",
  "telemetry/events.json": "{}\n",
  "plugins/marketplaces/x/SKILL.md": skill("A vendored plugin."),
  "backups/settings.json": "{}\n",
  "randomdir/notes.md": "unknown component\n",
  "skills/alpha/SKILL.md": skill("Alpha skill."),
  "skills/alpha/notes.md.bak": "stale copy of a redacted file\n",
  "agents/coder.md": "# coder\n",
  "commands/ship.md": "# ship\n",
  "rules/style.md": "# style\n",
  "hooks/pre-commit.sh": "#!/bin/sh\necho hi\n",
});
const messyDest = destination();
const messyResult = pack(messy, messyDest, "my-rig");

ok("settings.local.json excluded", !messyResult.included.includes("settings.local.json"));
ok("...as never-published, not as unrecognised",
  reasonFor(messyResult, "settings.local.json").startsWith("never published"),
  reasonFor(messyResult, "settings.local.json"));
ok(".claude.json excluded", reasonFor(messyResult, ".claude.json").startsWith("never published"));
ok("history.jsonl excluded", !messyResult.included.includes("history.jsonl"));
ok("projects/ excluded", !messyResult.included.some((p) => p.startsWith("projects/")));
ok("sessions/ excluded", !messyResult.included.some((p) => p.startsWith("sessions/")));
ok("telemetry/ excluded", !messyResult.included.some((p) => p.startsWith("telemetry/")));
ok("plugins/ excluded", !messyResult.included.some((p) => p.startsWith("plugins/")));
ok("backups/ excluded", !messyResult.included.some((p) => p.startsWith("backups/")));
ok("settings.json.bak excluded",
  reasonFor(messyResult, "settings.json.bak") === "denied file type (.bak)",
  reasonFor(messyResult, "settings.json.bak"));
ok("nested .bak excluded too", !messyResult.included.includes("skills/alpha/notes.md.bak"));
ok("unrecognised dir excluded with the right reason",
  reasonFor(messyResult, "randomdir") === "not a recognised rig component",
  reasonFor(messyResult, "randomdir"));

ok("skills/ included", messyResult.included.includes("skills/alpha/SKILL.md"));
ok("agents/ included", messyResult.included.includes("agents/coder.md"));
ok("commands/ included", messyResult.included.includes("commands/ship.md"));
ok("rules/ included", messyResult.included.includes("rules/style.md"));
ok("hooks/ included", messyResult.included.includes("hooks/pre-commit.sh"));
ok("CLAUDE.md included", messyResult.included.includes("CLAUDE.md"));

ok("clean rig was written", messyResult.written === true);
ok("no denied file reached disk",
  !existsSync(join(messyDest, "settings.local.json")) &&
  !existsSync(join(messyDest, ".claude.json")) &&
  !existsSync(join(messyDest, "projects")) &&
  !existsSync(join(messyDest, "plugins")) &&
  !existsSync(join(messyDest, "skills", "alpha", "notes.md.bak")));
ok("included files reached disk", existsSync(join(messyDest, "skills", "alpha", "SKILL.md")));

console.log("\n── credential backstop ──");

// Synthetic, never live: a Groq-shaped key (gsk_ + 40 alnum) that no
// placeholder rule downgrades.
const SYNTHETIC_KEY = "gsk_" + "9fK2mQ7rT4wZ1bV6nH8jL3pD5sG0cY2zA7eR4tU6";

const leaky = fixture({
  "CLAUDE.md": "# my rig\n",
  "agents/coder.md": "# coder\n",
  "skills/x/SKILL.md": skill(
    "Calls an API.",
    `Run it with:\n\n    curl -H "Authorization: Bearer ${SYNTHETIC_KEY}" https://api.groq.com/v1\n`,
  ),
});
const leakyDest = destination();
const leakyResult = pack(leaky, leakyDest, "leaky-rig");

ok("refuses to write when a credential survives", leakyResult.written === false);
ok("destination does not exist at all", !existsSync(leakyDest), leakyDest);
ok("reports exactly one blocking finding", rejects(leakyResult).length === 1,
  rejects(leakyResult).map((f) => `${f.file} ${f.location} ${f.kind}`).join(", "));
ok("names the file that carries it", rejects(leakyResult)[0]?.file === "skills/x/SKILL.md",
  rejects(leakyResult)[0]?.file ?? "");
ok("finding never carries the value", !JSON.stringify(leakyResult.findings).includes("gsk_"));
ok("the leaky file was otherwise going to ship", leakyResult.included.includes("skills/x/SKILL.md"));

const placeholders = fixture({
  "CLAUDE.md": "Set your API key in the environment.\n",
  "mcp-configs/servers.json":
    JSON.stringify({ mcpServers: { a: { env: { API_KEY: "${MY_TOKEN}" } } } }, null, 2) + "\n",
  "skills/y/SKILL.md": skill(
    "Documents its own config.",
    'export TOKEN="${API_TOKEN}"\nexport LEGACY="sk-YOURAPIKEYHEREYOURAPIKEYHEREYOURAPIKEY"\n',
  ),
});
const placeholderDest = destination();
const placeholderResult = pack(placeholders, placeholderDest, "clean-rig");

ok("placeholder rig packs successfully", placeholderResult.written === true);
ok("placeholder rig has no blocking findings", rejects(placeholderResult).length === 0,
  rejects(placeholderResult).map((f) => `${f.file} ${f.kind}`).join(", "));
ok("placeholder rig kept its skill", placeholderResult.included.includes("skills/y/SKILL.md"));

console.log("\n── .rigsignore ──");

const ignored = fixture({
  ".rigsignore": "# things I keep to myself\nskills/private-thing/\n*.secret\n",
  "CLAUDE.md": "# my rig\n",
  "skills/private-thing/SKILL.md": skill("Private."),
  "skills/private-thing/notes.md": "private notes\n",
  "skills/public-thing/SKILL.md": skill("Public."),
  "skills/public-thing/creds.secret": "nothing key-shaped, just private\n",
  "agents/coder.md": "# coder\n",
});
const ignoredResult = pack(ignored, destination(), "ignored-rig");

ok("named directory excluded", !ignoredResult.included.some((p) => p.startsWith("skills/private-thing/")));
ok("...and nothing else", ignoredResult.included.includes("skills/public-thing/SKILL.md") &&
  ignoredResult.included.includes("agents/coder.md") &&
  ignoredResult.included.includes("CLAUDE.md"));
ok("glob pattern excludes the match", !ignoredResult.included.includes("skills/public-thing/creds.secret"));
ok("exclusion is attributed to .rigsignore",
  reasonFor(ignoredResult, "skills/private-thing/SKILL.md") === "listed in .rigsignore",
  reasonFor(ignoredResult, "skills/private-thing/SKILL.md"));
ok(".rigsignore itself is not published", !ignoredResult.included.includes(".rigsignore"));
ok("included is exactly the expected set",
  [...ignoredResult.included].sort().join(",") ===
    ["CLAUDE.md", "agents/coder.md", "skills/public-thing/SKILL.md"].join(","),
  ignoredResult.included.join(","));

const cannotReinclude = fixture({
  ".rigsignore": "settings.local.json\n",
  "CLAUDE.md": "# my rig\n",
  "settings.local.json": '{"permissions":{"allow":["Bash(ls)"]}}\n',
});
const reincludeDest = destination();
const reincludeResult = pack(cannotReinclude, reincludeDest, "deny-wins");

ok(".rigsignore cannot re-include a hard-denied path",
  !reincludeResult.included.includes("settings.local.json"));
ok("hard deny is what fired, not .rigsignore",
  reasonFor(reincludeResult, "settings.local.json").startsWith("never published"),
  reasonFor(reincludeResult, "settings.local.json"));
ok("hard-denied path absent from disk", !existsSync(join(reincludeDest, "settings.local.json")));

console.log("\n── output shape ──");

const manifestPath = join(messyDest, ".claude-plugin", "plugin.json");
ok(".claude-plugin/plugin.json written", existsSync(manifestPath));
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string }
  : {};
ok("manifest name is the slug", manifest.name === "my-rig", manifest.name ?? "(missing)");
ok("README.md written", existsSync(join(messyDest, "README.md")));
ok("README names the slug",
  existsSync(join(messyDest, "README.md")) &&
  readFileSync(join(messyDest, "README.md"), "utf8").includes("my-rig"));

ok("included is populated", messyResult.included.length === 6, `${messyResult.included.length}`);
ok("excluded is populated", messyResult.excluded.length > 0, `${messyResult.excluded.length}`);
ok("nothing is both included and excluded",
  !messyResult.excluded.some((e) => messyResult.included.includes(e.path)));
const expectedBytes = messyResult.included
  .reduce((n, rel) => n + statSync(join(messy, rel)).size, 0);
ok("bytes is the size of what shipped", messyResult.bytes === expectedBytes,
  `${messyResult.bytes} vs ${expectedBytes}`);

console.log("\n── matchesIgnore ──");
ok("exact path matches", matchesIgnore("skills/foo", ["skills/foo"]));
ok("directory prefix matches its children", matchesIgnore("skills/foo/SKILL.md", ["skills/foo"]));
ok("prefix does not match a longer sibling name", !matchesIgnore("skills/foobar/SKILL.md", ["skills/foo"]));
ok("bare name matches any basename", matchesIgnore("agents/private.md", ["private.md"]));
ok("glob matches a single segment", matchesIgnore("skills/a/notes.secret", ["*.secret"]));
ok("glob does not match a different suffix", !matchesIgnore("skills/a/notes.md", ["*.secret"]));
ok("glob stops at the separator", !matchesIgnore("skills/a/b.md", ["skills/*"]));
ok("glob matches a one-level path", matchesIgnore("skills/a", ["skills/*"]));
ok("dot in a pattern is literal", !matchesIgnore("skills/axsecret", ["*.secret"]));
ok("empty pattern list matches nothing", !matchesIgnore("skills/foo", []));

console.log("\n── loadRigsignore ──");
ok("missing file yields no patterns", loadRigsignore(destination()).length === 0);
const ignoreRoot = fixture({
  ".rigsignore": "# a comment\n\n  skills/private/  \n*.secret\nagents/x.md\n",
});
const patterns = loadRigsignore(ignoreRoot);
ok("comments and blank lines dropped", patterns.length === 3, patterns.join("|"));
ok("whitespace and trailing slash stripped", patterns[0] === "skills/private", patterns[0]);
ok("globs preserved verbatim", patterns[1] === "*.secret", patterns[1]);
ok("plain paths preserved", patterns[2] === "agents/x.md", patterns[2]);

for (const t of temps) rmSync(t, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
