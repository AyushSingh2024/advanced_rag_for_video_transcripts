import "dotenv/config";
import { z } from "zod";

const optionalUrl = z.string().url().or(z.literal(""));
const schema = z.object({
  OPENAI_API_KEY: z.string().default(""),
  COHERE_API_KEY: z.string().default(""),
  QDRANT_URL: optionalUrl.default("http://localhost:6333"),
  QDRANT_API_KEY: z.string().default(""),
  DATABASE_URL: z.string().default("postgresql://rag:rag@localhost:5432/rag"),
  QDRANT_COLLECTION: z.string().default("lecture_chunks"),
  CHAT_MODEL: z.string().default("gpt-4o-mini"),
  GENERATION_MODEL: z.string().default("gpt-4o-mini"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  RERANK_MODEL: z.string().default("rerank-v3.5"),
  CHUNK_SIZE: z.coerce.number().int().min(200).default(1000),
  CHUNK_OVERLAP: z.coerce.number().int().min(0).default(150),
  VECTOR_LIMIT: z.coerce.number().int().positive().default(12),
  KEYWORD_LIMIT: z.coerce.number().int().positive().default(20),
  FUSED_LIMIT: z.coerce.number().int().positive().default(25),
  RERANK_LIMIT: z.coerce.number().int().positive().default(6),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  SCORE_THRESHOLD: z.coerce.number().min(0).max(10).default(7),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  PORT: z.coerce.number().int().positive().default(3000),
  EXTENSION_ORIGINS: z.string().default("chrome-extension://,http://localhost:3000"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
  EXTENSION_API_TOKEN: z.string().default(""),
  CURRICULUM_PATH: z.string().default("transcripts/class-subtitle/curriculum.json"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

export const config = Object.freeze({
  openAiApiKey: parsed.data.OPENAI_API_KEY,
  cohereApiKey: parsed.data.COHERE_API_KEY,
  qdrantUrl: parsed.data.QDRANT_URL,
  qdrantApiKey: parsed.data.QDRANT_API_KEY || undefined,
  databaseUrl: parsed.data.DATABASE_URL,
  qdrantCollection: parsed.data.QDRANT_COLLECTION,
  chatModel: parsed.data.CHAT_MODEL,
  generationModel: parsed.data.GENERATION_MODEL,
  embeddingModel: parsed.data.EMBEDDING_MODEL,
  embeddingDimensions: parsed.data.EMBEDDING_DIMENSIONS,
  rerankModel: parsed.data.RERANK_MODEL,
  chunkSize: parsed.data.CHUNK_SIZE,
  chunkOverlap: parsed.data.CHUNK_OVERLAP,
  vectorLimit: parsed.data.VECTOR_LIMIT,
  keywordLimit: parsed.data.KEYWORD_LIMIT,
  fusedLimit: parsed.data.FUSED_LIMIT,
  rerankLimit: parsed.data.RERANK_LIMIT,
  maxAttempts: parsed.data.MAX_ATTEMPTS,
  scoreThreshold: parsed.data.SCORE_THRESHOLD,
  requestTimeoutMs: parsed.data.REQUEST_TIMEOUT_MS,
  port: parsed.data.PORT,
  extensionOrigins: parsed.data.EXTENSION_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
  rateLimitPerMinute: parsed.data.RATE_LIMIT_PER_MINUTE,
  extensionApiToken: parsed.data.EXTENSION_API_TOKEN,
  curriculumPath: parsed.data.CURRICULUM_PATH,
});

export function requireConfig(...keys) {
  const missing = keys.filter((key) => !config[key]);
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(", ")}`);
}
