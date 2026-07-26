/**
 * Per-rig health state, persisted to data/state.json.
 *
 * The single most valuable behaviour here: when a rig's newest commit fails
 * validation we keep publishing its LAST GOOD SHA rather than delisting it.
 * Nobody's install breaks because an author pushed a bad commit. SHA pinning
 * is what makes that possible, which is why we always resolve one even though
 * the field turned out to be optional.
 */

export type Health = "ok" | "failing" | "gone" | "blocked";

export interface RepoState {
  health: Health;
  consecutiveFailures: number;
  /** The sha we keep publishing while newer commits are broken. */
  lastGoodSha: string | null;
  lastGoodAt: string | null;
  /** Skip-if-unchanged marker. */
  lastSeenPush: string | null;
  firstIndexedAt: string;
  lastCheckedAt: string | null;
  /** Component content hashes, for cross-rig derivative detection. */
  componentHashes?: string[];
  /** Set when delisted, so the site can render a tombstone for 30 days. */
  goneAt?: string | null;
}

export interface IndexState {
  version: 1;
  /** Round-robin cursor so growth is absorbed by run frequency, not job length. */
  cursor: number;
  repos: Record<string, RepoState>;
}

export const EMPTY_STATE: IndexState = { version: 1, cursor: 0, repos: {} };

/** Consecutive failing runs tolerated before a rig with no good sha is dropped. */
export const FAILURE_TOLERANCE = 3;

/** How long a delisted rig keeps a tombstone on the site. */
export const TOMBSTONE_DAYS = 30;

export function initRepo(now: string): RepoState {
  return {
    health: "ok",
    consecutiveFailures: 0,
    lastGoodSha: null,
    lastGoodAt: null,
    lastSeenPush: null,
    firstIndexedAt: now,
    lastCheckedAt: null,
  };
}

export interface Outcome {
  /** Did this run's HEAD pass every hard gate? */
  passed: boolean;
  sha: string | null;
  /** Repo is 404 / private / archived. */
  vanished?: boolean;
  componentHashes?: string[];
}

export interface Resolution {
  /** The sha to publish, or null if the rig must not be listed. */
  publishSha: string | null;
  listable: boolean;
  /** True when we are serving an older commit than HEAD. */
  servingStale: boolean;
  note?: string;
}

/**
 * Fold one run's outcome into a repo's state and decide what to publish.
 * Pure — callers persist the returned state themselves.
 */
export function applyOutcome(
  prev: RepoState,
  outcome: Outcome,
  now: string,
): { next: RepoState; resolution: Resolution } {
  const next: RepoState = { ...prev, lastCheckedAt: now };

  // A repo that has disappeared or gone private must leave the marketplace
  // immediately — a dead source breaks `plugin install` for everyone.
  if (outcome.vanished) {
    next.health = "gone";
    next.goneAt = prev.goneAt ?? now;
    return {
      next,
      resolution: { publishSha: null, listable: false, servingStale: false, note: "repository is no longer reachable" },
    };
  }

  if (outcome.passed && outcome.sha) {
    next.health = "ok";
    next.consecutiveFailures = 0;
    next.lastGoodSha = outcome.sha;
    next.lastGoodAt = now;
    next.goneAt = null;
    if (outcome.componentHashes) next.componentHashes = outcome.componentHashes;
    return {
      next,
      resolution: { publishSha: outcome.sha, listable: true, servingStale: false },
    };
  }

  // HEAD is broken. Fall back to the last known good commit if we have one.
  next.consecutiveFailures = prev.consecutiveFailures + 1;
  next.health = "failing";

  if (prev.lastGoodSha) {
    return {
      next,
      resolution: {
        publishSha: prev.lastGoodSha,
        listable: true,
        servingStale: true,
        note: "latest commit failed validation — serving the last commit that passed",
      },
    };
  }

  const listable = false;
  return {
    next,
    resolution: {
      publishSha: null,
      listable,
      servingStale: false,
      note:
        next.consecutiveFailures >= FAILURE_TOLERANCE
          ? "failed validation on every attempt"
          : "failed validation; will retry",
    },
  };
}

/** Voluntary withdrawal: the author removed the topic. Exit is as automatic as entry. */
export function markWithdrawn(prev: RepoState, now: string): RepoState {
  return { ...prev, health: "gone", goneAt: prev.goneAt ?? now, lastCheckedAt: now };
}

export function tombstoneExpired(s: RepoState, now: Date): boolean {
  if (!s.goneAt) return false;
  const age = (now.getTime() - new Date(s.goneAt).getTime()) / 86_400_000;
  return age > TOMBSTONE_DAYS;
}

/**
 * Order the work queue: never-indexed first, then stalest. Bounded per run so
 * a growing corpus lengthens the cycle rather than the job.
 */
export function selectBatch(
  repos: string[],
  state: IndexState,
  batchSize: number,
): string[] {
  const scored = repos.map((repo) => {
    const s = state.repos[repo];
    const checked = s?.lastCheckedAt ? new Date(s.lastCheckedAt).getTime() : 0;
    return { repo, checked };
  });
  scored.sort((a, b) => a.checked - b.checked);
  return scored.slice(0, batchSize).map((s) => s.repo);
}

/** Has the repo changed since we last looked? */
export function isUnchanged(s: RepoState | undefined, pushedAt: string): boolean {
  return !!s && s.health === "ok" && s.lastSeenPush === pushedAt && !!s.lastGoodSha;
}
