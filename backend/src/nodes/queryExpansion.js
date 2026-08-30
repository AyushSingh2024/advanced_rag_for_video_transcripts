import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { config, requireConfig } from "../config.js";
import { deduplicateQueries } from "../utils/retrieval.js";
import { normalizeHistory } from "../utils/video.js";

const responseSchema = z.object({
  rewrittenQuery: z.string().min(1),
  stepBackQuery: z.string().min(1),
  subQuestions: z.array(z.string().min(1)).min(1).max(4),
});

export async function queryExpansionNode(state) {
  requireConfig("openAiApiKey");
  const llm = new ChatOpenAI({ model: config.chatModel, temperature: 0, apiKey: config.openAiApiKey });
  const history = normalizeHistory(state.conversationHistory)
    .map(({ role, content }) => `${role}: ${content}`)
    .join("\n");
  const result = await llm.withStructuredOutput(responseSchema).invoke([
    ["system", "Expand questions for hybrid retrieval over one educational video. Resolve follow-up references using the conversation, preserve exact technical terms, and return one semantic rewrite, one broader step-back question, and 2-4 independently searchable sub-questions."],
    ["human", `${history ? `Recent conversation:\n${history}\n\n` : ""}Question: ${state.originalQuery}\nPlayback time: ${state.currentTime ?? "unknown"} seconds\n${state.feedback ? `Previous grader feedback to target: ${state.feedback}` : ""}`],
  ]);
  return {
    rewrittenQuery: result.rewrittenQuery,
    stepBackQuery: result.stepBackQuery,
    subQuestions: result.subQuestions,
    queryVariants: deduplicateQueries([state.originalQuery, result.rewrittenQuery, result.stepBackQuery, ...result.subQuestions]),
  };
}
