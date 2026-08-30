export function reciprocalRankFusion(lists, { k = 60, limit = 25 } = {}) {
  const byId = new Map();
  for (const { name, documents } of lists) {
    documents.forEach((document, index) => {
      if (!document?.id) return;
      const current = byId.get(document.id) ?? { ...document, rrfScore: 0, matchedBy: [] };
      current.rrfScore += 1 / (k + index + 1);
      if (!current.matchedBy.includes(name)) current.matchedBy.push(name);
      byId.set(document.id, current);
    });
  }
  return [...byId.values()].sort((a, b) => b.rrfScore - a.rrfScore).slice(0, limit);
}

export function deduplicateQueries(queries) {
  const seen = new Set();
  return queries.filter((query) => {
    const normalized = query?.trim().toLowerCase().replace(/\s+/g, " ");
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}
