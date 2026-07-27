/**
 * Rig discovery.
 *
 * Two inputs, unioned: the GitHub topic (self-selected, zero friction) and
 * sources/seed.jsonl (manual override, and the only input during phase 0).
 *
 * Topic-only discovery over a generic term is not viable — `topic:claude-code`
 * is already ~52k repos. `claude-rig` is deliberately specific: adding it is an
 * intentional act by someone who knows what Rigs is, which bounds the corpus
 * and doubles as proof of intent.
 */

export const DISCOVERY_TOPIC = "claude-rig";

export interface DiscoveredRepo {
  repo: string;
  pushedAt: string;
  createdAt: string;
  stars: number;
  fork: boolean;
  archived: boolean;
  license: string | null;
  /** true when it came from seed.jsonl rather than the topic search */
  seeded: boolean;
}

interface GitHubSearchItem {
  full_name: string;
  pushed_at: string;
  created_at: string;
  stargazers_count: number;
  fork: boolean;
  archived: boolean;
  license: { spdx_id: string } | null;
}

const API = "https://api.github.com";

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "rigs-indexer",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export interface RateState {
  remaining: number;
  limit: number;
}

/** Read rate-limit headers so callers can bail before being throttled. */
function readRate(res: Response): RateState {
  return {
    remaining: Number(res.headers.get("x-ratelimit-remaining") ?? "0"),
    limit: Number(res.headers.get("x-ratelimit-limit") ?? "0"),
  };
}

/**
 * Search the topic. GitHub caps search at 1,000 results regardless of paging,
 * which is fine: past that we would be over any sane CI budget anyway and the
 * cursor in state.json handles the backlog across runs.
 */
export async function searchTopic(
  token?: string,
  topic = DISCOVERY_TOPIC,
): Promise<{ repos: DiscoveredRepo[]; rate: RateState }> {
  const found: DiscoveredRepo[] = [];
  let rate: RateState = { remaining: 0, limit: 0 };

  for (let page = 1; page <= 10; page++) {
    const url =
      `${API}/search/repositories` +
      `?q=${encodeURIComponent(`topic:${topic} fork:false`)}` +
      `&sort=updated&order=desc&per_page=100&page=${page}`;

    const res = await fetch(url, { headers: headers(token) });
    rate = readRate(res);

    if (res.status === 403 || res.status === 429) {
      console.warn(`  discovery throttled (HTTP ${res.status}); stopping at page ${page}`);
      break;
    }
    if (!res.ok) {
      throw new Error(`GitHub search failed: ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as { items: GitHubSearchItem[] };
    for (const it of body.items) {
      found.push({
        repo: it.full_name,
        pushedAt: it.pushed_at,
        createdAt: it.created_at,
        stars: it.stargazers_count,
        fork: it.fork,
        archived: it.archived,
        license: it.license?.spdx_id ?? null,
        seeded: false,
      });
    }
    if (body.items.length < 100) break;
  }

  return { repos: found, rate };
}

/** Fetch metadata for a single repo (used for seeded entries). */
export async function fetchRepoMeta(
  repo: string,
  token?: string,
): Promise<DiscoveredRepo | null> {
  const res = await fetch(`${API}/repos/${repo}`, { headers: headers(token) });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) return null;
  const it = (await res.json()) as GitHubSearchItem;
  return {
    repo: it.full_name,
    pushedAt: it.pushed_at,
    createdAt: it.created_at,
    stars: it.stargazers_count,
    fork: it.fork,
    archived: it.archived,
    license: it.license?.spdx_id ?? null,
    seeded: true,
  };
}

/**
 * Resolve a repo to the name GitHub currently knows it by, following the 301 a
 * rename leaves behind. Returns the input unchanged when there was no rename,
 * and null when the repo is gone for good.
 *
 * Deliberately the HTML endpoint rather than /repos/{owner}/{repo}: it needs no
 * token and spends none of the 60/hour unauthenticated API budget, and the
 * indexer must keep working unauthenticated. `git remote get-url origin` after
 * a clone is NOT an option — git follows the redirect silently but records the
 * URL it was handed, so it reports the stale name.
 *
 * Never throws: an unreachable network must not turn a rename check into a
 * failed run. On any error the caller sees the name it already had.
 */
export async function resolveCanonicalRepo(repo: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`https://github.com/${repo}`, {
      method: "HEAD",
      redirect: "manual",
      headers: { "User-Agent": "rigs-indexer" },
    });
  } catch {
    return repo;
  }

  if (res.status === 404 || res.status === 410) return null;
  if (res.status !== 301 && res.status !== 302 && res.status !== 308) return repo;

  const location = res.headers.get("location");
  const moved = location && /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+?)(?:\.git)?\/?$/.exec(location);
  return moved ? moved[1] : repo;
}

/** Union topic results with seeds; seeds win on conflict so overrides stick. */
export function mergeSources(
  topicRepos: DiscoveredRepo[],
  seeded: DiscoveredRepo[],
): DiscoveredRepo[] {
  const byRepo = new Map<string, DiscoveredRepo>();
  for (const r of topicRepos) byRepo.set(r.repo, r);
  for (const r of seeded) byRepo.set(r.repo, { ...r, seeded: true });
  return [...byRepo.values()];
}
