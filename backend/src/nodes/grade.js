import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { config } from "../config.js";

const gradeSchema = z.object({
  groundedness: z.number().min(0).max(10),
  relevance: z.number().min(0).max(10),
  completeness: z.number().min(0).max(10),
  citationAccuracy: z.number().min(0).max(10),
  overallScore: z.number().min(0).max(10),
  feedback: z.string(),
});

export async function gradeNode(state) {
  const attempts = state.attempts + 1;
  if (state.insufficientContext && !state.rerankedChunks.length) {
    return {
      score: 10, attempts, feedback: "", bestAnswer: state.answer, bestScore: 10,
      bestCitations: state.citations,
      gradeMetrics: { groundedness: 10, relevance: 10, completeness: 10, citationAccuracy: 10, abstained: true },
    };
  }

  const invalidCitation = state.citationValidationFailed;
  const context = state.rerankedChunks.map((chunk, index) => `[${index + 1}] ${chunk.content}`).join("\n\n");
  const llm = new ChatOpenAI({ model: config.chatModel, temperature: 0, apiKey: config.openAiApiKey });
  const grade = await llm.withStructuredOutput(gradeSchema).invoke([
    ["system", "Grade a RAG answer strictly against the supplied evidence. Penalize unsupported claims, missing parts, and inaccurate or absent citations. Feedback must state the single most useful correction."],
    ["human", `Question: ${state.originalQuery}\nAnswer: ${state.answer}\nCitations declared: ${state.citationNumbers.join(", ") || "none"}\nEvidence:\n${context}`],
  ]);
  const score = invalidCitation ? Math.min(grade.overallScore, 4) : grade.overallScore;
  const bestScore = score > state.bestScore ? score : state.bestScore;
  const bestAnswer = score > state.bestScore ? state.answer : state.bestAnswer;
  const bestCitations = score > state.bestScore ? state.citations : state.bestCitations;
  return {
    score, attempts, bestScore, bestAnswer, bestCitations,
    gradeMetrics: { groundedness: grade.groundedness, relevance: grade.relevance, completeness: grade.completeness, citationAccuracy: invalidCitation ? 0 : grade.citationAccuracy },
    feedback: score >= config.scoreThreshold ? "" : invalidCitation ? "Use only valid citation numbers from the supplied sources." : grade.feedback,
  };
}
