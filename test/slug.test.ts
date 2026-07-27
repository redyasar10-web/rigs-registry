/**
 * Slug identity tests. Run: node --experimental-strip-types test/slug.test.ts
 *
 * The slug is the install key, so the behaviour that matters most is that a
 * GitHub rename does NOT mint a second one. That bug shipped: keying on the
 * owner/repo string meant affaan-m/everything-claude-code becoming
 * affaan-m/ECC allocated `ecc` and silently orphaned every existing install.
 */

import {
  loadNames, allocateSlug, findSlug, recordRename, serializeNames, checkEmitAgrees,
  type NameRegistry, type EmitRig,
} from "../bot/names.ts";
import { initRepo, renameRepoKey, type IndexState } from "../bot/state.ts";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  \x1b[32m✔\x1b[0m ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  \x1b[31m✘\x1b[0m ${name}${detail ? "  " + detail : ""}`); }
}

const OLD = "affaan-m/everything-claude-code";
const NEW = "affaan-m/ECC";
const T0 = "2026-01-01T00:00:00.000Z";
const SHA = "a".repeat(40);

console.log("\n── legacy names.json migration ──");
const legacy = loadNames({
  "everything-claude-code": OLD,
  "marketingskills": "coreyhaines31/marketingskills",
});
ok("flat string form migrates to an entry", legacy["everything-claude-code"]?.repo === OLD);
ok("every legacy mapping survives", Object.keys(legacy).length === 2, Object.keys(legacy).join(","));
ok("migrated entry has no phantom aliases", legacy["everything-claude-code"].aliases === undefined);
ok("legacy repo is still findable", findSlug(legacy, OLD) === "everything-claude-code");

const modern = loadNames({ ecc: { repo: NEW, aliases: [OLD] } });
ok("new form round-trips", modern.ecc?.repo === NEW && modern.ecc.aliases?.[0] === OLD);
ok("alias is findable", findSlug(modern, OLD) === "ecc");
ok("empty file yields empty registry", Object.keys(loadNames({})).length === 0);
ok("garbage entries never crash the read", Object.keys(loadNames({ a: 5, b: null, c: "x/y" })).length === 1);

console.log("\n── a rename keeps the original slug ──");
const names: NameRegistry = loadNames({ "everything-claude-code": OLD });
const preserved = recordRename(names, OLD, NEW);
ok("rename returns the ORIGINAL slug", preserved === "everything-claude-code", preserved ?? "undefined");
ok("no second slug was minted", Object.keys(names).length === 1, Object.keys(names).join(","));
ok("current repo is now the new name", names["everything-claude-code"].repo === NEW);
ok("old name recorded as an alias", names["everything-claude-code"].aliases?.includes(OLD) === true);
ok("lookup by the NEW name resolves", findSlug(names, NEW) === "everything-claude-code");
ok("lookup by the OLD name still resolves", findSlug(names, OLD) === "everything-claude-code");
ok("`ecc` was never allocated", names.ecc === undefined);

// The production path: allocation is asked for the renamed repo directly.
ok(
  "allocateSlug on the renamed repo returns the original slug",
  allocateSlug(names, NEW, "ecc") === "everything-claude-code",
);
ok("allocateSlug did not add an entry", Object.keys(names).length === 1, Object.keys(names).join(","));

// Reached under a name it has already moved off.
const viaAlias: NameRegistry = { "everything-claude-code": { repo: NEW, aliases: [OLD] } };
ok("allocateSlug via an alias returns the original slug", allocateSlug(viaAlias, OLD, "everything-claude-code") === "everything-claude-code");

console.log("\n── renaming is idempotent and reversible ──");
const twice: NameRegistry = loadNames({ "everything-claude-code": OLD });
recordRename(twice, OLD, NEW);
recordRename(twice, OLD, NEW);
ok("re-running a rename does not duplicate the alias", twice["everything-claude-code"].aliases?.length === 1, JSON.stringify(twice["everything-claude-code"].aliases));
recordRename(twice, NEW, OLD);
ok("renaming back restores the current repo", twice["everything-claude-code"].repo === OLD);
ok("renaming back retires the alias", findSlug(twice, NEW) === "everything-claude-code" && twice["everything-claude-code"].aliases?.includes(OLD) !== true);
ok("renaming an unknown repo is a no-op", recordRename(twice, "nobody/nothing", "nobody/else") === undefined);
ok("case-only rename is not a rename", allocateSlug(loadNames({ ecc: NEW }), "affaan-m/ecc", "ecc") === "ecc");

console.log("\n── a genuinely new repo still gets a fresh slug ──");
const fresh: NameRegistry = loadNames({ "everything-claude-code": OLD });
const newSlug = allocateSlug(fresh, "someone/brand-new", "brand-new");
ok("unknown repo gets its preferred slug", newSlug === "brand-new", newSlug);
ok("registry grew by exactly one", Object.keys(fresh).length === 2, Object.keys(fresh).join(","));
ok("existing mapping untouched", fresh["everything-claude-code"].repo === OLD);

console.log("\n── collision behaviour must not regress ──");
const collide: NameRegistry = {};
const a = allocateSlug(collide, "alice/toolkit", "toolkit");
const b = allocateSlug(collide, "bob/toolkit", "toolkit");
const c = allocateSlug(collide, "carol/toolkit", "toolkit");
ok("first claimant keeps the bare slug", a === "toolkit", a);
ok("second is disambiguated by owner", b === "toolkit-bob", b);
ok("third is disambiguated by owner too", c === "toolkit-carol", c);
ok("all three slugs are distinct", new Set([a, b, c]).size === 3, [a, b, c].join(","));
ok("each slug maps to its own repo", collide[a].repo === "alice/toolkit" && collide[b].repo === "bob/toolkit" && collide[c].repo === "carol/toolkit");
ok("re-allocating an owned repo is stable", allocateSlug(collide, "bob/toolkit", "toolkit") === "toolkit-bob");

// Same owner, two repo names that slugify identically — the only way the
// owner suffix is itself taken, so this is what exercises the counter.
const d = allocateSlug(collide, "alice/tool.kit", "toolkit");
const e = allocateSlug(collide, "alice/tool_kit", "toolkit");
ok("owner suffix is used once", d === "toolkit-alice", d);
ok("a taken owner suffix falls through to a counter", e === "toolkit-2", e);
ok("all five slugs are distinct", new Set([a, b, c, d, e]).size === 5, [a, b, c, d, e].join(","));

console.log("\n── health state follows the rename ──");
const st: IndexState = {
  version: 1, cursor: 0,
  repos: { [OLD]: { ...initRepo(T0), lastGoodSha: SHA, lastSeenPush: T0 } },
};
const moved = renameRepoKey(st, OLD, NEW);
ok("state is carried to the new name", moved.repos[NEW]?.lastGoodSha === SHA);
ok("old key is dropped", moved.repos[OLD] === undefined);
ok("original state object is not mutated", st.repos[OLD]?.lastGoodSha === SHA);
ok("unknown repo is a no-op", renameRepoKey(st, "nobody/nothing", "x/y").repos["x/y"] === undefined);

console.log("\n── serialisation ──");
const ser = serializeNames({ x: { repo: "a/b", aliases: [] }, y: { repo: "c/d", aliases: ["e/f"] } });
ok("empty alias lists are not written", ser.x.aliases === undefined, JSON.stringify(ser.x));
ok("real aliases are written", ser.y.aliases?.[0] === "e/f");
ok("serialised form re-reads identically", JSON.stringify(loadNames(ser)) === JSON.stringify(ser));

console.log("\n── index/marketplace consistency assertion ──");
const rigs: EmitRig[] = [
  { slug: "everything-claude-code", tier: "A", listable: true, publishSha: SHA },
  { slug: "browsable-only", tier: "B", listable: true, publishSha: SHA },
  { slug: "not-listed", tier: "A", listable: false, publishSha: SHA },
  { slug: "no-sha", tier: "A", listable: true, publishSha: null },
];
ok("agreeing pair reports no problems", checkEmitAgrees(rigs, [{ name: "everything-claude-code" }]).length === 0);

// Exactly the shipped bug: the index says one slug, the marketplace says another.
const drifted = checkEmitAgrees(rigs, [{ name: "ecc" }]);
ok("disagreement is detected", drifted.length === 2, `${drifted.length} problem(s)`);
ok("names the slug missing from the marketplace", drifted.some((p) => p.startsWith("everything-claude-code:")), drifted.join(" | "));
ok("names the slug that should not be published", drifted.some((p) => p.startsWith("ecc:")), drifted.join(" | "));
ok("a tier-B rig is not expected in the marketplace", !drifted.some((p) => p.startsWith("browsable-only:")));
ok("an unlisted rig is not expected in the marketplace", !drifted.some((p) => p.startsWith("not-listed:")));
ok("a rig with no publish sha is not expected", !drifted.some((p) => p.startsWith("no-sha:")));
ok("missing from the marketplace alone is caught", checkEmitAgrees(rigs, []).length === 1);
ok("extra in the marketplace alone is caught", checkEmitAgrees([], [{ name: "ghost" }]).length === 1);
ok("two empty sets agree", checkEmitAgrees([], []).length === 0);

console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
