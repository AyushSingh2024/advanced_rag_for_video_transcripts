import { ChatOpenAI } from "@langchain/openai";
import { config } from "../config.js";
import { deduplicateQueries } from "../utils/retrieval.js";

export async function hydeNode(state) {
  const llm = new ChatOpenAI({ model: config.chatModel, temperature: 0.2, apiKey: config.openAiApiKey });
  const response = await llm.invoke([
    ["system", "Write a short hypothetical educational passage that would answer the query. It is a retrieval probe, not evidence. Use likely source terminology and do not add citations."],
    ["human", state.rewrittenQuery],
  ]);
  const hydeDoc = typeof response.content === "string" ? response.content : String(response.content);
  return { hydeDoc, queryVariants: deduplicateQueries([...state.queryVariants, hydeDoc]) };
}
