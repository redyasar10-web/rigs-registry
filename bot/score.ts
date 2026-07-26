/**
 * Ranking and derivative detection.
 *
 * Principle: rank aggressively, gate narrowly. Stars and account age influence
 * SORT ORDER ONLY and never admission — gating on them would kill the long tail
 * of genuinely good rigs from small accounts, which is the entire point of the
 * project. The only hard gates are safety (credentials) and substance.
 */

export interface ScoreInput {
  stars: number;
  pushedAt: string;
  createdAt: string;
  componentTotal: number;
  hasDescription: boolean;
  hasLicense: boolean;
  warningCount: number;
  isFork: boolean;
  isDerivative: boolean;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Fresh today = 1, decaying to 0 over a year. */
function recency(pushedAt: string, now: Date): number {
  const days = (now.getTime() - new Date(pushedAt).getTime()) / 86_400_000;
  return clamp01(1 - days / 365);
}

export function trustScore(i: ScoreInput, now = new Date()): number {
  const stars = clamp01(Math.log10(1 + i.stars) / 3);       // ~1000 stars saturates
  const fresh = recency(i.pushedAt, now);
  const age = clamp01(
    (now.getTime() - new Date(i.createdAt).getTime()) / 86_400_000 / 730,
  );
  const substance = clamp01(Math.log10(1 + i.componentTotal) / 2); // ~100 components saturates
  const completeness = (Number(i.hasDescription) + Number(i.hasLicense)) / 2;
  const cleanliness = clamp01(1 - i.warningCount / 10);

  let score =
    0.30 * stars +
    0.20 * fresh +
    0.15 * substance +
    0.10 * age +
    0.15 * completeness +
    0.10 * cleanliness;

  if (i.isDerivative) score -= 0.5;
  else if (i.isFork) score -= 0.25;

  return Math.round(clamp01(score) * 1000) / 1000;
}

/** Stale rigs sort last but are never removed for staleness alone. */
export function isStale(pushedAt: string, now = new Date()): boolean {
  return (now.getTime() - new Date(pushedAt).getTime()) / 86_400_000 > 365;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface DerivativeVerdict {
  isDerivative: boolean;
  derivativeOf?: string;
  overlap?: number;
}

/**
 * The dominant attack on a git-native registry is fork-rename-relist. Compare
 * component content hashes against every already-known rig; first registered
 * wins. `fork: true` from the API catches the lazy case for free, this catches
 * the rest.
 */
export function detectDerivative(
  repo: string,
  hashes: string[],
  known: Record<string, { hashes: string[]; firstIndexedAt: string }>,
  threshold = 0.9,
): DerivativeVerdict {
  if (hashes.length < 3) return { isDerivative: false };
  const mine = new Set(hashes);

  let best: { repo: string; overlap: number } | null = null;
  for (const [other, info] of Object.entries(known)) {
    if (other === repo || info.hashes.length < 3) continue;
    const overlap = jaccard(mine, new Set(info.hashes));
    if (overlap >= threshold && (!best || overlap > best.overlap)) {
      best = { repo: other, overlap };
    }
  }

  return best
    ? { isDerivative: true, derivativeOf: best.repo, overlap: Math.round(best.overlap * 100) / 100 }
    : { isDerivative: false };
}

/** Max rigs indexed per GitHub owner, so one account cannot spray the index. */
export const OWNER_QUOTA = 5;

/** Keep the highest-scoring rigs per owner; the rest are surplus, not rejected. */
export function applyOwnerQuota<T extends { owner: string; score: number; repo: string }>(
  rigs: T[],
  quota = OWNER_QUOTA,
): { kept: T[]; surplus: T[] } {
  const byOwner = new Map<string, T[]>();
  for (const r of rigs) {
    const list = byOwner.get(r.owner) ?? [];
    list.push(r);
    byOwner.set(r.owner, list);
  }
  const kept: T[] = [];
  const surplus: T[] = [];
  for (const list of byOwner.values()) {
    list.sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo));
    kept.push(...list.slice(0, quota));
    surplus.push(...list.slice(quota));
  }
  return { kept, surplus };
}
