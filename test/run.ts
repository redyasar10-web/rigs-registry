/**
 * Phase 0 verification. Run: node --experimental-strip-types test/run.ts
 *
 * Two things must hold before the bot can be trusted:
 *   1. Mirror exclusion turns 397 SKILL.md files into ~125 real skills.
 *   2. The secret scanner catches a key buried in a long shell string, passes
 *      placeholders, and never emits a matched value.
 */

import { scanJsonTree, scanText, scanUrl, formatFinding } from "../bot/rules/secrets.ts";
import { isMirrorPath } from "../bot/rules/mirrors.ts";
import { extract } from "../bot/extract.ts";
import { existsSync } from "node:fs";

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✔\x1b[0m ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✘\x1b[0m ${name}${detail ? "  " + detail : ""}`);
  }
}

console.log("\n── mirror path exclusion ──");
ok("docs/ excluded", isMirrorPath("docs/zh-CN/skills/api-design/SKILL.md"));
ok("locale segment excluded", isMirrorPath("skills/zh-CN/foo/SKILL.md"));
ok(".agents mirror excluded", isMirrorPath(".agents/skills/api-design/SKILL.md"));
ok(".kiro mirror excluded", isMirrorPath(".kiro/skills/x/SKILL.md"));
ok(".cursor mirror excluded", isMirrorPath(".cursor/rules/x.md"));
ok("node_modules excluded", isMirrorPath("node_modules/pkg/skills/x/SKILL.md"));
ok("real skill kept", !isMirrorPath("skills/api-design/SKILL.md"));
ok("real agent kept", !isMirrorPath("agents/code-reviewer.md"));
ok("nested command kept", !isMirrorPath("commands/github/pr-manager.md"));

console.log("\n── secret scanner ──");

// The exact shape that bit us: a live key inside a long captured shell command,
// sitting in an array of permission strings.
const longCurl =
  "Bash(curl -sS -X POST https://api.groq.com/openai/v1/chat/completions " +
  "-H 'Content-Type: application/json' " +
  "-H 'Authorization: Bearer gsk_" + "A".repeat(20) + "b7Kd9Xm2Qp4Rt6Zw8Yv1Nc3Ls5Hj" + "' " +
  "-d '{\"model\":\"llama-3.3-70b\",\"messages\":[]}')";
const settingsLocal = { permissions: { allow: ["Bash(ls)", "Bash(git status)", longCurl] } };
const f1 = scanJsonTree(settingsLocal, "settings.local.json");
ok("finds key inside long permission string", f1.length === 1, f1[0] ? `→ ${f1[0].location}` : "");
ok("reports array index location", f1[0]?.location === "permissions.allow.2", f1[0]?.location ?? "");
ok("never leaks the value", !JSON.stringify(f1).includes("gsk_"));

const placeholders = {
  mcpServers: {
    a: { env: { API_KEY: "${MY_TOKEN}" } },
    b: { env: { API_KEY: "YOUR_API_KEY_HERE" } },
    c: { headers: { Authorization: "Bearer ${API_TOKEN}" } },
    d: { env: { API_KEY: "<your-token-here>" } },
    e: { env: { API_KEY: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" } },
  },
};
ok("placeholders pass clean", scanJsonTree(placeholders, ".mcp.json").length === 0);

ok("anthropic key caught", scanText("key = sk-ant-" + "x9K".repeat(30), "n.md").length === 1);
ok("aws key caught", scanText("AKIAIOSFODNN7EXAMPLX", "n.md").length === 1);
ok("github token caught", scanText("ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8", "n.md").length === 1);
ok("private key block caught", scanText("-----BEGIN RSA PRIVATE KEY-----", "id_rsa").length === 1);
ok("prose is not a secret", scanText("Set your API key in the environment.", "README.md").length === 0);

const u = scanUrl("https://mcp.example.com/sse?api_key=7f3a9c2e8b1d4506af22", ".mcp.json", "servers.x.url");
ok("token in URL query caught", u !== null, u ? `→ ${u.kind}` : "");
ok("URL finding hides value", !JSON.stringify(u).includes("7f3a9c2e"));
ok("placeholder URL passes", scanUrl("https://x/sse?api_key=${TOKEN}", ".mcp.json", "u") === null);


console.log("\n── frontmatter block scalars ──");
import { parseFrontmatter } from "../bot/extract.ts";
const literal = parseFrontmatter(`---
name: thing
description: |
  First line of the description.
  Second line.
---
body`);
ok("literal block scalar parsed", literal.description?.startsWith("First line"), JSON.stringify(literal.description ?? "").slice(0, 46));
ok("literal is not the pipe char", literal.description !== "|");
const folded = parseFrontmatter(`---
description: >
  folded across
  two lines
---`);
ok("folded block scalar joined", folded.description === "folded across two lines", folded.description ?? "");
const plain = parseFrontmatter(`---
name: x
description: "quoted value"
---`);
ok("quoted scalar unwrapped", plain.description === "quoted value");
ok("plain key still works", plain.name === "x");

console.log("\n── extraction against a real rig ──");
const REAL = "/Users/red/.claude/plugins/marketplaces/everything-claude-code";
if (existsSync(REAL)) {
  const r = extract(REAL);
  console.log(
    `  raw component files: ${r.rawFileCount}  ` +
    `dropped(mirror): ${r.droppedMirror}  dropped(dup): ${r.droppedDuplicate}`,
  );
  console.log(`  counts: ${JSON.stringify(r.counts)}`);
  // Assert the INVARIANT, not an absolute count. This folder is live and
  // outside the repo — it grew from 125 to 282 skills and broke a hardcoded
  // bound. What must hold is that mirror trees are removed, whatever the size.
  const dropRatio = r.droppedMirror / r.rawFileCount;
  ok("mirror exclusion removes most raw files", dropRatio > 0.4, `dropped ${(dropRatio * 100).toFixed(0)}%`);
  ok("real skills survive", r.counts.skill > 0, `${r.counts.skill}`);
  ok("kept count is well below raw", r.counts.skill < r.rawFileCount, `${r.counts.skill} < ${r.rawFileCount}`);
  ok("found agents", r.counts.agent > 0, `${r.counts.agent}`);
  ok("found commands", r.counts.command > 0, `${r.counts.command}`);
  ok("no component from an excluded tree", r.components.every((c) => !isMirrorPath(c.path)));
  const withDesc = r.components.filter((c) => c.description).length;
  console.log(`  components carrying a description: ${withDesc}/${r.components.length}`);
} else {
  console.log("  (skipped — reference rig not present)");
}

console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
