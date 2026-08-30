import { config } from "../config.js";

export async function rerankNode(state) {
  if (!state.retrievedChunks.length) return { rerankedChunks: [] };
  const fallback = state.retrievedChunks.slice(0, config.rerankLimit);
  if (!config.cohereApiKey) return { rerankedChunks: fallback, trace: { ...state.trace, reranker: "rrf-fallback" } };
  try {
    const response = await fetch("https://api.cohere.com/v2/rerank", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.cohereApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.rerankModel, query: state.originalQuery, documents: state.retrievedChunks.map(({ content }) => content), top_n: config.rerankLimit }),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`Cohere rerank failed with HTTP ${response.status}`);
    const data = await response.json();
    return {
      rerankedChunks: data.results.map((result) => ({ ...state.retrievedChunks[result.index], relevanceScore: result.relevance_score })),
      trace: { ...state.trace, reranker: config.rerankModel },
    };
  } catch (error) {
    return { rerankedChunks: fallback, trace: { ...state.trace, reranker: "rrf-fallback", rerankerError: error.message } };
  }
}
