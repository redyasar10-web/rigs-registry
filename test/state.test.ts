/**
 * Health-machine and ranking tests.
 *
 * The behaviour that matters most: a rig whose newest commit breaks must keep
 * serving its last good sha rather than vanishing from people's installs.
 */

import {
  initRepo, applyOutcome, markWithdrawn, selectBatch, isUnchanged,
  tombstoneExpired, FAILURE_TOLERANCE, type IndexState,
} from "../bot/state.ts";
import { trustScore, isStale, detectDerivative, applyOwnerQuota } from "../bot/score.ts";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  \x1b[32m✔\x1b[0m ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  \x1b[31m✘\x1b[0m ${name}${detail ? "  " + detail : ""}`); }
}

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-01T00:00:00.000Z";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

console.log("\n── health state machine ──");

const fresh = initRepo(T0);
const first = applyOutcome(fresh, { passed: true, sha: SHA_A, componentHashes: ["h1", "h2"] }, T0);
ok("first success publishes head", first.resolution.publishSha === SHA_A && first.resolution.listable);
ok("records last good sha", first.next.lastGoodSha === SHA_A);
ok("stores component hashes", first.next.componentHashes?.length === 2);

// The critical one.
const broke = applyOutcome(first.next, { passed: false, sha: SHA_B }, T1);
ok("broken HEAD keeps serving last good sha", broke.resolution.publishSha === SHA_A, broke.resolution.publishSha ?? "null");
ok("stays listable while stale", broke.resolution.listable === true);
ok("flagged as serving stale", broke.resolution.servingStale === true);
ok("health marked failing", broke.next.health === "failing");
ok("failure counter incremented", broke.next.consecutiveFailures === 1);

const recovered = applyOutcome(broke.next, { passed: true, sha: SHA_B }, T1);
ok("recovery publishes new sha", recovered.resolution.publishSha === SHA_B);
ok("recovery resets counter", recovered.next.consecutiveFailures === 0 && recovered.next.health === "ok");

// Never-good rig: fails from the start, so there is nothing safe to publish.
let neverGood = initRepo(T0);
for (let i = 0; i < FAILURE_TOLERANCE; i++) {
  neverGood = applyOutcome(neverGood, { passed: false, sha: SHA_A }, T1).next;
}
const ngResolution = applyOutcome(neverGood, { passed: false, sha: SHA_A }, T1).resolution;
ok("rig with no good sha is never listed", ngResolution.listable === false && ngResolution.publishSha === null);

const vanished = applyOutcome(first.next, { passed: false, sha: null, vanished: true }, T1);
ok("vanished repo is delisted immediately", vanished.resolution.listable === false);
ok("vanished repo even with a good sha", vanished.resolution.publishSha === null);
ok("tombstone timestamp set", Boolean(vanished.next.goneAt));

const withdrawn = markWithdrawn(first.next, T1);
ok("withdrawal marks gone", withdrawn.health === "gone");

ok("tombstone expires after 30d", tombstoneExpired({ ...withdrawn, goneAt: "2026-01-01T00:00:00Z" }, new Date("2026-03-01")));
ok("tombstone fresh within 30d", !tombstoneExpired({ ...withdrawn, goneAt: "2026-02-25T00:00:00Z" }, new Date("2026-03-01")));

console.log("\n── skip-unchanged and batching ──");
const st: IndexState = {
  version: 1, cursor: 0,
  repos: {
    "a/one": { ...initRepo(T0), lastCheckedAt: T1, lastSeenPush: T0, lastGoodSha: SHA_A },
    "a/two": { ...initRepo(T0), lastCheckedAt: T0, lastSeenPush: T0, lastGoodSha: SHA_A },
  },
};
ok("unchanged repo is skipped", isUnchanged(st.repos["a/one"], T0));
ok("pushed repo is not skipped", !isUnchanged(st.repos["a/one"], T1));
ok("unknown repo is not skipped", !isUnchanged(undefined, T0));
const batch = selectBatch(["a/one", "a/two", "a/three"], st, 2);
ok("never-indexed sorts first", batch[0] === "a/three", batch.join(","));
ok("then stalest", batch[1] === "a/two", batch.join(","));
ok("batch respects size", batch.length === 2);

console.log("\n── ranking (never gates) ──");
const base = {
  stars: 10, pushedAt: new Date().toISOString(), createdAt: "2024-01-01T00:00:00Z",
  componentTotal: 20, hasDescription: true, hasLicense: true, warningCount: 0,
  isFork: false, isDerivative: false,
};
const popular = trustScore({ ...base, stars: 5000 });
const obscure = trustScore({ ...base, stars: 0 });
ok("popular outranks obscure", popular > obscure, `${popular} > ${obscure}`);
ok("obscure still scores above zero", obscure > 0, `${obscure}`);
ok("derivative is penalised", trustScore({ ...base, isDerivative: true }) < obscure);
ok("stale detection", isStale("2024-01-01T00:00:00Z") && !isStale(new Date().toISOString()));

console.log("\n── derivative detection ──");
const originalHashes = Array.from({ length: 20 }, (_, i) => `h${i}`);
const known = { "orig/rig": { hashes: originalHashes, firstIndexedAt: T0 } };
const cloneVerdict = detectDerivative("copy/rig", originalHashes, known);
ok("identical component set flagged", cloneVerdict.isDerivative && cloneVerdict.derivativeOf === "orig/rig");
const distinct = detectDerivative("other/rig", Array.from({ length: 20 }, (_, i) => `z${i}`), known);
ok("distinct rig not flagged", !distinct.isDerivative);
const partial = detectDerivative("part/rig", [...originalHashes.slice(0, 8), "x1", "x2", "x3", "x4"], known);
ok("partial overlap not flagged", !partial.isDerivative, `overlap ${partial.overlap ?? 0}`);
ok("tiny rigs exempt from derivative check", !detectDerivative("t/r", ["h1"], known).isDerivative);

console.log("\n── owner quota ──");
const many = Array.from({ length: 8 }, (_, i) => ({ owner: "spammer", repo: `spammer/r${i}`, score: i / 10 }));
const { kept, surplus } = applyOwnerQuota([...many, { owner: "solo", repo: "solo/rig", score: 0.5 }]);
ok("quota caps one owner at 5", kept.filter((k) => k.owner === "spammer").length === 5);
ok("surplus is held back", surplus.length === 3);
ok("other owners unaffected", kept.some((k) => k.owner === "solo"));
ok("highest scoring kept", kept.some((k) => k.repo === "spammer/r7"));

console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
