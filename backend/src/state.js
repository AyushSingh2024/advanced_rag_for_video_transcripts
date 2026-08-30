import { Annotation } from "@langchain/langgraph";
import { config } from "./config.js";

const replace = (current, next) => next ?? current;
export const StateAnnotation = Annotation.Root({
  originalQuery: Annotation({ reducer: replace, default: () => "" }),
  videoId: Annotation({ reducer: replace, default: () => null }),
  /** How far the student has got, as a lesson order from curriculum.json. */
  upToLesson: Annotation({ reducer: replace, default: () => null }),
  /** Where the answer lives if it lives past the student's position. */
  lookahead: Annotation({ reducer: replace, default: () => null }),
  currentTime: Annotation({ reducer: replace, default: () => null }),
  conversationId: Annotation({ reducer: replace, default: () => null }),
  conversationHistory: Annotation({ reducer: replace, default: () => [] }),
  mode: Annotation({ reducer: replace, default: () => "ask" }),
  filters: Annotation({ reducer: replace, default: () => ({}) }),
  rewrittenQuery: Annotation({ reducer: replace, default: () => "" }),
  stepBackQuery: Annotation({ reducer: replace, default: () => "" }),
  subQuestions: Annotation({ reducer: replace, default: () => [] }),
  hydeDoc: Annotation({ reducer: replace, default: () => "" }),
  queryVariants: Annotation({ reducer: replace, default: () => [] }),
  retrievedChunks: Annotation({ reducer: replace, default: () => [] }),
  rerankedChunks: Annotation({ reducer: replace, default: () => [] }),
  answer: Annotation({ reducer: replace, default: () => "" }),
  citationNumbers: Annotation({ reducer: replace, default: () => [] }),
  citations: Annotation({ reducer: replace, default: () => [] }),
  citationValidationFailed: Annotation({ reducer: replace, default: () => false }),
  insufficientContext: Annotation({ reducer: replace, default: () => false }),
  score: Annotation({ reducer: replace, default: () => 0 }),
  gradeMetrics: Annotation({ reducer: replace, default: () => ({}) }),
  feedback: Annotation({ reducer: replace, default: () => "" }),
  attempts: Annotation({ reducer: replace, default: () => 0 }),
  maxAttempts: Annotation({ reducer: replace, default: () => config.maxAttempts }),
  bestAnswer: Annotation({ reducer: replace, default: () => null }),
  bestCitations: Annotation({ reducer: replace, default: () => [] }),
  bestScore: Annotation({ reducer: replace, default: () => -1 }),
  /** True when bounded retrieval returned too few results and the pipeline
   *  fell back to an unbounded (whole-course) search. The answer may contain
   *  material from lessons the student has not reached yet. */
  fallbackUsed: Annotation({ reducer: replace, default: () => false }),
  trace: Annotation({ reducer: replace, default: () => ({}) }),
});
