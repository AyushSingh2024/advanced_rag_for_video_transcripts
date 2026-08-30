import { StateGraph, START, END } from "@langchain/langgraph";
import { config } from "./config.js";
import { StateAnnotation } from "./state.js";
import { queryExpansionNode } from "./nodes/queryExpansion.js";
import { hydeNode } from "./nodes/hyde.js";
import { retrieveNode } from "./nodes/retrieve.js";
import { rerankNode } from "./nodes/rerank.js";
import { generateNode } from "./nodes/generate.js";
import { gradeNode } from "./nodes/grade.js";

function routeAfterGrade(state) {
  if (state.score >= config.scoreThreshold || state.attempts >= state.maxAttempts || (state.insufficientContext && !state.rerankedChunks.length)) return "finish";
  if ((state.gradeMetrics.citationAccuracy ?? 10) < config.scoreThreshold && (state.gradeMetrics.groundedness ?? 10) >= config.scoreThreshold) return "regenerate";
  return "retrieve_again";
}

export function buildGraph() {
  return new StateGraph(StateAnnotation)
    .addNode("queryExpansion", queryExpansionNode)
    .addNode("hyde", hydeNode)
    .addNode("retrieve", retrieveNode)
    .addNode("rerank", rerankNode)
    .addNode("generate", generateNode)
    .addNode("grade", gradeNode)
    .addEdge(START, "queryExpansion")
    .addEdge("queryExpansion", "hyde")
    .addEdge("hyde", "retrieve")
    .addEdge("retrieve", "rerank")
    .addEdge("rerank", "generate")
    .addEdge("generate", "grade")
    .addConditionalEdges("grade", routeAfterGrade, {
      finish: END,
      regenerate: "generate",
      retrieve_again: "queryExpansion",
    });
}

export function compileGraph() {
  return buildGraph().compile();
}
