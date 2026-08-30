import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings } from "@langchain/openai";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { config, requireConfig } from "../config.js";
import { pool, withTransaction } from "../db.js";
import { qdrant, ensureQdrantCollection, deleteSourceVectors } from "../storage/qdrant.js";
import { deterministicUuid, sha256 } from "../utils/hash.js";
import { loadFile, supportedExtensions } from "./loaders.js";
import { createTranscriptChunks, preferVttTranscripts } from "./subtitles.js";

/**
 * Sidecar files that describe the corpus rather than belong to it. `.json` is an
 * ingestable type, so without this list the curriculum spine, the manifest and
 * the concept graph would be embedded as documents and answer questions about
 * themselves.
 *
 * Every generated `.json` that lands next to the transcripts must be listed
 * here. The concept graph files were added to the pipeline after this set was
 * written and were briefly missing from it.
 */
const SIDECAR_FILES = new Set([
  "transcript-manifest.json",
  "curriculum.json",
  "concept-graph.json",
  "concept-graph-raw.json",
]);

/** Exported for testing: the sidecar exclusion is easy to regress and expensive to notice. */
export async function discoverIngestableFiles(inputPath) {
  const absolute = resolve(inputPath);
  const info = await stat(absolute);
  if (info.isFile()) {
    if (SIDECAR_FILES.has(basename(absolute).toLowerCase())) return [];
    return supportedExtensions.has(extname(absolute).toLowerCase()) ? [absolute] : [];
  }
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => discoverIngestableFiles(join(absolute, entry.name))));
  return nested.flat();
}

async function loadTranscriptManifest(inputPath) {
  const absolute = resolve(inputPath);
  const info = await stat(absolute);
  const manifestPath = join(info.isDirectory() ? absolute : dirname(absolute), "transcript-manifest.json");
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    const entries = Array.isArray(parsed) ? parsed : parsed.videos ?? [];
    return new Map(entries.map((entry) => [resolve(dirname(manifestPath), entry.file).toLowerCase(), entry]));
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw new Error(`Invalid transcript manifest at ${manifestPath}: ${error.message}`);
  }
}

export async function ingestFile(filePath, { force = false, metadata = {} } = {}) {
  requireConfig("openAiApiKey", "qdrantUrl", "databaseUrl");
  const loaded = await loadFile(filePath);
  const integer = (value) => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null);
  loaded.metadata = {
    ...loaded.metadata,
    ...metadata,
    sourceTitle: metadata.title ?? metadata.sourceTitle ?? loaded.metadata.sourceTitle,
    videoId: metadata.videoId?.trim() || loaded.metadata.videoId || null,
    sourceUrl: metadata.url?.trim() || metadata.sourceUrl || null,
    // Curriculum position, from the spine in curriculum.json via the manifest.
    // Null is legitimate: an ingested PDF has no place in the lesson order, and
    // every order-bounded query is written to let those through.
    lessonOrder: integer(metadata.lessonOrder ?? loaded.metadata.lessonOrder),
    moduleOrder: integer(metadata.moduleOrder ?? loaded.metadata.moduleOrder),
    lessonLabel: metadata.lessonLabel ?? loaded.metadata.lessonLabel ?? null,
  };
  if (!loaded.text) return { filePath, status: "empty", chunks: 0 };

  const sourceId = sha256(loaded.metadata.sourcePath.toLowerCase());
  const contentHash = sha256(loaded.text);
  const existing = await pool.query("SELECT content_hash, video_id, lesson_order FROM sources WHERE source_id = $1", [sourceId]);
  if (!force
    && existing.rows[0]?.content_hash === contentHash
    && existing.rows[0]?.video_id === loaded.metadata.videoId
    && integer(existing.rows[0]?.lesson_order) === loaded.metadata.lessonOrder) {
    return { filePath, sourceId, status: "unchanged", chunks: 0 };
  }

  const overlap = Math.min(config.chunkOverlap, config.chunkSize - 1);
  let preparedChunks;
  if (loaded.segments?.length) {
    preparedChunks = createTranscriptChunks(loaded.segments, { chunkSize: config.chunkSize, chunkOverlap: overlap });
  } else {
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: config.chunkSize, chunkOverlap: overlap });
    preparedChunks = (await splitter.splitText(loaded.text)).map((content) => ({ content }));
  }
  const chunks = preparedChunks.map(({ content, startTime = null, endTime = null }, chunkIndex) => ({
    chunkId: deterministicUuid(`${sourceId}:${chunkIndex}:${sha256(content)}`),
    chunkIndex,
    content,
    contentHash: sha256(content),
    startTime,
    endTime,
  }));

  const embeddings = new OpenAIEmbeddings({
    model: config.embeddingModel,
    apiKey: config.openAiApiKey,
    dimensions: config.embeddingDimensions,
  });
  const vectors = await embeddings.embedDocuments(chunks.map(({ content }) => content));

  await ensureQdrantCollection();
  if (existing.rowCount) await deleteSourceVectors(sourceId);
  await qdrant.upsert(config.qdrantCollection, {
    wait: true,
    points: chunks.map((chunk, index) => ({
      id: chunk.chunkId,
      vector: vectors[index],
      payload: {
        chunk_id: chunk.chunkId,
        source_id: sourceId,
        source_title: loaded.metadata.sourceTitle,
        source_type: loaded.metadata.sourceType,
        source_path: loaded.metadata.sourcePath,
        source_url: loaded.metadata.sourceUrl,
        video_id: loaded.metadata.videoId,
        channel_id: loaded.metadata.channelId ?? null,
        module: loaded.metadata.module ?? null,
        // Integer so Qdrant can bound a search with a range filter.
        lesson_order: loaded.metadata.lessonOrder,
        module_order: loaded.metadata.moduleOrder,
        lesson_label: loaded.metadata.lessonLabel,
        language: loaded.metadata.language ?? null,
        chunk_index: chunk.chunkIndex,
        start_time: chunk.startTime,
        end_time: chunk.endTime,
        content: chunk.content,
      },
    })),
  });

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO sources (source_id, source_type, source_title, source_path, source_url, content_hash,
                            video_id, channel_id, module, language, duration, metadata,
                            lesson_order, module_order, lesson_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (source_id) DO UPDATE SET source_type = EXCLUDED.source_type,
         source_title = EXCLUDED.source_title, source_path = EXCLUDED.source_path,
         source_url = EXCLUDED.source_url, content_hash = EXCLUDED.content_hash,
         video_id = EXCLUDED.video_id, channel_id = EXCLUDED.channel_id, module = EXCLUDED.module,
         language = EXCLUDED.language, duration = EXCLUDED.duration,
         metadata = EXCLUDED.metadata, lesson_order = EXCLUDED.lesson_order,
         module_order = EXCLUDED.module_order, lesson_label = EXCLUDED.lesson_label,
         updated_at = NOW()`,
      [sourceId, loaded.metadata.sourceType, loaded.metadata.sourceTitle, loaded.metadata.sourcePath,
        loaded.metadata.sourceUrl, contentHash, loaded.metadata.videoId, loaded.metadata.channelId ?? null,
        loaded.metadata.module ?? null, loaded.metadata.language ?? null, loaded.metadata.duration ?? null,
        loaded.metadata, loaded.metadata.lessonOrder, loaded.metadata.moduleOrder, loaded.metadata.lessonLabel],
    );
    await client.query("DELETE FROM chunks WHERE source_id = $1", [sourceId]);
    for (const chunk of chunks) {
      await client.query(
        `INSERT INTO chunks (chunk_id, source_id, chunk_index, content, content_hash, video_id, start_time, end_time, metadata, lesson_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [chunk.chunkId, sourceId, chunk.chunkIndex, chunk.content, chunk.contentHash,
          loaded.metadata.videoId, chunk.startTime, chunk.endTime, loaded.metadata, loaded.metadata.lessonOrder],
      );
    }
  });

  return { filePath, sourceId, status: existing.rowCount ? "updated" : "created", chunks: chunks.length };
}

export async function ingestPath(inputPath, options = {}) {
  const files = preferVttTranscripts(await discoverIngestableFiles(inputPath));
  const manifest = await loadTranscriptManifest(inputPath);
  const results = [];
  for (const file of files) {
    results.push(await ingestFile(file, { ...options, metadata: manifest.get(file.toLowerCase()) ?? {} }));
  }
  return results;
}
