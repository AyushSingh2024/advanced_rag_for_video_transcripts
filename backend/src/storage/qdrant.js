import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "../config.js";

export const qdrant = new QdrantClient({
  url: config.qdrantUrl,
  apiKey: config.qdrantApiKey,
  timeout: config.requestTimeoutMs,
  checkCompatibility: false,
});

export async function ensureQdrantCollection() {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some(({ name }) => name === config.qdrantCollection);
  if (!exists) {
    await qdrant.createCollection(config.qdrantCollection, {
      vectors: { size: config.embeddingDimensions, distance: "Cosine" },
    });
  }
}

export async function deleteSourceVectors(sourceId) {
  await qdrant.delete(config.qdrantCollection, {
    wait: true,
    filter: { must: [{ key: "source_id", match: { value: sourceId } }] },
  });
}
