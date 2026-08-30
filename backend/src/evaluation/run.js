import { readFile } from "node:fs/promises";
import { compileGraph } from "../graph.js";
import { pool } from "../db.js";

const datasetPath = process.argv[2] ?? new URL("./dataset.json", import.meta.url);
const cases = JSON.parse(await readFile(datasetPath, "utf8"));
const graph = compileGraph();
const results = [];

try {
  for (const item of cases) {
    const startedAt = Date.now();
    const state = await graph.invoke({ originalQuery: item.question });
    const answer = state.bestAnswer ?? state.answer;
    const termRecall = item.expectedTerms.length
      ? item.expectedTerms.filter((term) => answer.toLowerCase().includes(term.toLowerCase())).length / item.expectedTerms.length
      : 1;
    results.push({
      question: item.question,
      score: state.bestScore,
      termRecall,
      abstentionCorrect: Boolean(state.insufficientContext) === Boolean(item.shouldAbstain),
      citations: state.citations.length,
      latencyMs: Date.now() - startedAt,
    });
  }
  console.table(results);
  const mean = (key) => results.reduce((sum, item) => sum + Number(item[key]), 0) / Math.max(results.length, 1);
  console.log({ meanScore: mean("score"), meanTermRecall: mean("termRecall"), abstentionAccuracy: mean("abstentionCorrect"), meanLatencyMs: mean("latencyMs") });
} finally {
  await pool.end();
}
