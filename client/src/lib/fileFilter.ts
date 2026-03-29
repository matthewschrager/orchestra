/**
 * Filter and rank file paths by query relevance.
 *
 * Ranking tiers:
 *   0 — basename starts with query  (e.g., query "App" matches "src/App.tsx")
 *   1 — full path starts with query (e.g., query "src/" matches "src/App.tsx")
 *   2 — substring match anywhere
 *
 * Tiebreak: shorter paths first, then alphabetical.
 */
export function filterFiles(files: string[], query: string, limit = 20): string[] {
  if (!query) return [];
  const q = query.toLowerCase();

  const matches: Array<{ path: string; rank: number }> = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    if (!lower.includes(q)) continue;

    const lastSlash = f.lastIndexOf("/");
    const basename = lastSlash >= 0 ? lower.slice(lastSlash + 1) : lower;

    let rank: number;
    if (basename.startsWith(q)) {
      rank = 0;
    } else if (lower.startsWith(q)) {
      rank = 1;
    } else {
      rank = 2;
    }
    matches.push({ path: f, rank });
  }

  matches.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  });

  return matches.slice(0, limit).map((m) => m.path);
}
