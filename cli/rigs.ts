#!/usr/bin/env node
/**
 * rigs — publish your Claude Code setup.
 *
 *   rigs check     scan this rig for leaked credentials and broken paths
 *   rigs init      scaffold .claude-plugin/plugin.json
 *   rigs publish   check, then print the two steps to go live
 *
 * `check` runs the SAME scanner the registry runs, but locally and BEFORE
 * anything is public. That ordering is the entire point: the registry's copy
 * protects the registry, this one protects you.
 *
 * Reads only. Writes nothing except plugin.json during `init`, and never
 * transmits your files anywhere.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { scanJsonTree, scanText, scanUrl, type SecretFinding } from "../bot/rules/secrets.ts";
import { extract } from "../bot/extract.ts";

const DIM = "\x1b[2m", RED = "\x1b[31m", YEL = "\x1b[33m", GRN = "\x1b[32m", BLD = "\x1b[1m", OFF = "\x1b[0m";

const JSON_TARGETS = /(^|\/)(settings[^/]*\.json|\.claude\.json|\.mcp\.json|mcp[^/]*\.json)(\.bak)?$/;
const TEXT_TARGETS = /\.(md|sh|bash|zsh|js|cjs|mjs|ts|py)$/;

function* walk(dir: string, root: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === ".git" || e === "node_modules") continue;
    const abs = join(dir, e);
    let st; try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) yield* walk(abs, root);
    else if (st.isFile() && st.size < 512 * 1024) yield abs.slice(root.length + 1);
  }
}

function scan(dir: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rel of walk(dir, dir)) {
    let text: string;
    try { text = readFileSync(join(dir, rel), "utf8"); } catch { continue; }
    if (JSON_TARGETS.test(rel)) {
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
    } else if (TEXT_TARGETS.test(rel)) {
      findings.push(...scanText(text, rel));
    }
  }
  return findings;
}

function cmdCheck(dir: string): number {
  console.log(`\n${BLD}Checking ${basename(dir)}${OFF}\n`);

  const ex = extract(dir);
  const total = Object.values(ex.counts).reduce((a, b) => a + b, 0);
  const parts = Object.entries(ex.counts).filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`).join(", ");
  console.log(`  ${total} components  ${DIM}${parts || "none found"}${OFF}`);
  if (ex.droppedMirror > 0) {
    console.log(`  ${DIM}(ignored ${ex.droppedMirror} files in docs/, translations and other-tool mirrors)${OFF}`);
  }

  const findings = scan(dir);
  const blocking = findings.filter((f) => f.severity === "reject");
  const warned = findings.filter((f) => f.severity === "warn");

  console.log();
  if (blocking.length) {
    console.log(`${RED}${BLD}  ✘ ${blocking.length} possible credential${blocking.length === 1 ? "" : "s"} found${OFF}\n`);
    for (const f of blocking) {
      console.log(`    ${RED}${f.file}${OFF}  ${f.location}`);
      console.log(`      looks like a ${BLD}${f.kind}${OFF} (${f.matchLength} chars)`);
    }
    console.log(`\n  ${BLD}Do not publish until these are resolved.${OFF}`);
    console.log(`  ${DIM}If any is real: rotate the credential first — it may already be in your git history.${OFF}`);
    console.log(`  ${DIM}If it's a placeholder, rewrite it as \${ENV_VAR} and re-run.${OFF}`);
  } else {
    console.log(`${GRN}  ✔ no credentials detected${OFF}`);
  }

  if (warned.length) {
    console.log(`\n${YEL}  ${warned.length} finding${warned.length === 1 ? "" : "s"} in test/fixture files (not blocking)${OFF}`);
    for (const f of warned) console.log(`    ${DIM}${f.file} ${f.location} — ${f.kind}${OFF}`);
  }

  const manifest = join(dir, ".claude-plugin", "plugin.json");
  console.log();
  if (existsSync(manifest)) {
    console.log(`${GRN}  ✔ .claude-plugin/plugin.json present${OFF} ${DIM}— installable${OFF}`);
  } else {
    console.log(`${YEL}  ○ no .claude-plugin/plugin.json${OFF} ${DIM}— run 'rigs init' to make this installable${OFF}`);
  }

  console.log();
  return blocking.length ? 1 : 0;
}

function cmdInit(dir: string): number {
  const dest = join(dir, ".claude-plugin");
  const file = join(dest, "plugin.json");
  if (existsSync(file)) {
    console.log(`\n  ${YEL}.claude-plugin/plugin.json already exists${OFF} — nothing to do\n`);
    return 0;
  }
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const manifest = {
    name: /^[a-z]/.test(name) ? name : `rig-${name}`,
    description: "My Claude Code setup",
  };
  mkdirSync(dest, { recursive: true });
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\n${GRN}  ✔ wrote .claude-plugin/plugin.json${OFF}\n`);
  console.log(`${JSON.stringify(manifest, null, 2).split("\n").map((l) => "    " + l).join("\n")}\n`);
  console.log(`  ${DIM}Edit the description, then run 'rigs publish'.${OFF}\n`);
  return 0;
}

function cmdPublish(dir: string): number {
  const code = cmdCheck(dir);
  if (code !== 0) {
    console.log(`  ${RED}Publish blocked — resolve the findings above first.${OFF}\n`);
    return code;
  }
  if (!existsSync(join(dir, ".claude-plugin", "plugin.json"))) {
    console.log(`  ${YEL}Run 'rigs init' first to make this rig installable.${OFF}\n`);
    return 1;
  }
  console.log(`${BLD}  Two steps to go live${OFF}\n`);
  console.log(`  1. Push your repo to GitHub (public).`);
  console.log(`  2. Add the topic ${BLD}claude-rig${OFF} to it.\n`);
  console.log(`  ${DIM}The indexer picks it up within 6 hours. Remove the topic any time to delist —${OFF}`);
  console.log(`  ${DIM}no account, no approval, no waiting on a maintainer.${OFF}\n`);
  return 0;
}

const [, , cmd = "check", pathArg = "."] = process.argv;
const dir = resolve(pathArg);
if (!existsSync(dir)) {
  console.error(`no such directory: ${dir}`);
  process.exit(2);
}

switch (cmd) {
  case "check": process.exit(cmdCheck(dir));
  case "init": process.exit(cmdInit(dir));
  case "publish": process.exit(cmdPublish(dir));
  default:
    console.log(`
${BLD}rigs${OFF} — publish your Claude Code setup

  ${BLD}rigs check${OFF} [dir]     scan for leaked credentials and broken paths
  ${BLD}rigs init${OFF} [dir]      scaffold .claude-plugin/plugin.json
  ${BLD}rigs publish${OFF} [dir]   check, then show how to go live
`);
    process.exit(cmd === "help" || cmd === "--help" ? 0 : 2);
}
