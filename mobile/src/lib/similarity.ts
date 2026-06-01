// Simple text similarity for transaction descriptions.
// Ported verbatim from the desktop app (src/lib/similarity.ts) — no external deps.

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(normalize(s).split(" ").filter(Boolean));
}

function tokenSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return intersection / (ta.size + tb.size - intersection);
}

function containsBoost(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.includes(nb) || nb.includes(na)) return 0.3;
  return 0;
}

export function similarity(a: string, b: string): number {
  return Math.min(1, tokenSimilarity(a, b) + containsBoost(a, b));
}

export interface ScoredMatch<T> {
  item: T;
  score: number;
}

export function topMatches<T>(
  query: string,
  candidates: T[],
  getText: (item: T) => string,
  n: number,
  minScore = 0.3,
): ScoredMatch<T>[] {
  const scored = candidates
    .map((item) => ({ item, score: similarity(query, getText(item)) }))
    .filter((s) => s.score >= minScore);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n);
}
