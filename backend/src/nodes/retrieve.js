import { OpenAIEmbeddings } from "@langchain/openai";
import { config } from "../config.js";
import { pool } from "../db.js";
import { qdrant } from "../storage/qdrant.js";
import { reciprocalRankFusion } from "../utils/retrieval.js";
import { buildQdrantAheadFilter, buildQdrantVideoFilter, normalizeLessonOrder, normalizeVideoId } from "../utils/video.js";

function qdrantDocument(point) {
  const payload = point.payload ?? {};
  return {
    id: String(payload.chunk_id ?? point.id), content: String(payload.content ?? ""),
    source_id: payload.source_id, source_title: payload.source_title, source_path: payload.source_path,
    source_url: payload.source_url,
    chunk_index: payload.chunk_index, page_number: payload.page_number, video_id: payload.video_id,
    lesson_order: payload.lesson_order ?? null, lesson_label: payload.lesson_label ?? null,
    start_time: payload.start_time, end_time: payload.end_time, vectorScore: point.score,
  };
}

const CHUNK_COLUMNS = `c.chunk_id, c.source_id, s.source_title, s.source_path, s.source_url, c.chunk_index,
        c.content, c.page_number, c.video_id, c.start_time, c.end_time, c.lesson_order, s.lesson_label`;

function keywordDocument(row) {
  return {
    id: row.chunk_id, content: row.content, source_id: row.source_id, source_title: row.source_title,
    source_path: row.source_path, source_url: row.source_url, chunk_index: row.chunk_index,
    page_number: row.page_number, video_id: row.video_id, start_time: row.start_time, end_time: row.end_time,
    lesson_order: row.lesson_order ?? null, lesson_label: row.lesson_label ?? null,
    keywordScore: row.keyword_score == null ? undefined : Number(row.keyword_score),
  };
}

/**
 * The earliest lesson in a result set — the best available guess at where a
 * concept is introduced. The concept graph gives a better answer offline;
 * this is the runtime fallback when a concept has no graph entry.
 */
function earliestLesson(documents) {
  return documents
    .filter((document) => document.lesson_order != null)
    .sort((a, b) => a.lesson_order - b.lesson_order
      || Number(a.start_time ?? 0) - Number(b.start_time ?? 0))[0] ?? null;
}

function bestVectorScore(lists) {
  let best = null;
  for (const list of lists) {
    for (const document of list.documents) {
      if (typeof document.vectorScore === "number" && (best == null || document.vectorScore > best)) best = document.vectorScore;
    }
  }
  return best;
}

/**
 * Looks for the answer in the part of the course the student has not reached.
 *
 * This exists so the pipeline has a third option beyond answering and giving
 * up. If the material genuinely lives ahead, saying "that's introduced in
 * Module 13 · Chapter 3" is more useful than either an answer built from
 * whatever weak evidence happened to be in range, or a flat "I don't know".
 */
async function probeAhead({ vector, query, videoId, upToLesson }) {
  const lists = [];
  try {
    if (!config.qdrantEnabled || !vector) throw new Error("Vector retrieval disabled");
    const response = await qdrant.query(config.qdrantCollection, {
      query: vector, limit: config.vectorLimit, with_payload: true,
      filter: buildQdrantAheadFilter(videoId, upToLesson),
    });
    lists.push({ name: "ahead:vector", documents: response.points.map(qdrantDocument) });
  } catch { /* the bounded answer must not depend on the probe succeeding */ }

  try {
    const keyword = await pool.query(
      `SELECT ${CHUNK_COLUMNS},
              ts_rank_cd(c.search_vector, websearch_to_tsquery('english', $1)) AS keyword_score
       FROM chunks c JOIN sources s USING (source_id)
       WHERE c.search_vector @@ websearch_to_tsquery('english', $1)
         AND ($3::text IS NULL OR c.video_id = $3)
         AND c.lesson_order IS NOT NULL AND c.lesson_order > $4
       ORDER BY keyword_score DESC LIMIT $2`,
      [query, config.keywordLimit, videoId, upToLesson],
    );
    lists.push({ name: "ahead:keyword", documents: keyword.rows.map(keywordDocument) });
  } catch { /* same */ }

  if (!lists.length) return null;
  const fused = reciprocalRankFusion(lists, { limit: config.fusedLimit });
  if (!fused.length) return null;
  const earliest = earliestLesson(fused);
  if (!earliest) return null;
  return {
    lessonOrder: earliest.lesson_order,
    lessonLabel: earliest.lesson_label ?? null,
    sourceTitle: earliest.source_title ?? null,
    videoId: earliest.video_id ?? null,
    startTime: earliest.start_time ?? null,
    topLessonOrder: fused[0].lesson_order ?? null,
    bestVectorScore: bestVectorScore(lists),
  };
}

export async function retrieveNode(state) {
  const startedAt = Date.now();
  const videoId = normalizeVideoId(state.videoId ?? state.filters?.videoId);
  const upToLesson = normalizeLessonOrder(state.upToLesson ?? state.filters?.upToLesson);
  const currentTime = Number.isFinite(Number(state.currentTime)) ? Number(state.currentTime) : null;
  const filter = buildQdrantVideoFilter(videoId, upToLesson);
  const keywordQuery = state.rewrittenQuery || state.originalQuery;

  let queryVectors = [];
  if (config.qdrantEnabled) {
    const embeddings = new OpenAIEmbeddings({ model: config.embeddingModel, apiKey: config.openAiApiKey, dimensions: config.embeddingDimensions });
    queryVectors = await embeddings.embedDocuments(state.queryVariants);
  }
  const vectorSettled = await Promise.allSettled(queryVectors.map((vector, index) =>
    qdrant.query(config.qdrantCollection, { query: vector, limit: config.vectorLimit, with_payload: true, ...(filter ? { filter } : {}) })
      .then((response) => ({ name: `vector:${index}`, documents: response.points.map(qdrantDocument) })),
  ));
  const lists = vectorSettled.filter(({ status }) => status === "fulfilled").map(({ value }) => value);

  try {
    const keyword = await pool.query(
      `SELECT ${CHUNK_COLUMNS},
              ts_rank_cd(c.search_vector, websearch_to_tsquery('english', $1)) AS keyword_score
       FROM chunks c JOIN sources s USING (source_id)
       WHERE c.search_vector @@ websearch_to_tsquery('english', $1)
         AND ($3::text IS NULL OR c.video_id = $3)
         AND ($4::int IS NULL OR c.lesson_order IS NULL OR c.lesson_order <= $4)
       ORDER BY keyword_score DESC LIMIT $2`,
      [keywordQuery, config.keywordLimit, videoId, upToLesson],
    );
    lists.push({ name: "keyword", documents: keyword.rows.map(keywordDocument) });

    if (videoId && currentTime != null) {
      const nearby = await pool.query(
        `SELECT ${CHUNK_COLUMNS}
         FROM chunks c JOIN sources s USING (source_id)
         WHERE c.video_id = $1 AND c.start_time IS NOT NULL
         ORDER BY ABS(((c.start_time + COALESCE(c.end_time, c.start_time)) / 2) - $2) ASC
         LIMIT 8`,
        [videoId, currentTime],
      );
      lists.push({ name: "playback-nearby", documents: nearby.rows.map(keywordDocument) });
    }
  } catch (error) {
    if (lists.length === 0) throw new AggregateError([error], "Both vector and keyword retrieval failed");
  }

  const retrievedChunks = reciprocalRankFusion(lists, { limit: config.fusedLimit });

  /* ── Unbounded fallback ──────────────────────────────────────────────────
   * When the spoiler-bounded search returns too few results to be useful,
   * retry without the lesson-order ceiling. The answer will carry a spoiler
   * warning, but an honest answer with a caveat beats a flat "I don't know".
   */
  let finalChunks = retrievedChunks;
  let fallbackUsed = false;

  if (retrievedChunks.length < 2 && upToLesson != null) {
    const fbLists = [];

    // Re-run vector searches without the lesson_order bound
    const fbFilter = buildQdrantVideoFilter(videoId, null);
    const fbSettled = await Promise.allSettled(queryVectors.map((vector, index) =>
      qdrant.query(config.qdrantCollection, { query: vector, limit: config.vectorLimit, with_payload: true, ...(fbFilter ? { filter: fbFilter } : {}) })
        .then((response) => ({ name: `fb-vector:${index}`, documents: response.points.map(qdrantDocument) })),
    ));
    fbLists.push(...fbSettled.filter(({ status }) => status === "fulfilled").map(({ value }) => value));

    // Re-run keyword search without the lesson_order bound
    try {
      const fbKeyword = await pool.query(
        `SELECT ${CHUNK_COLUMNS},
                ts_rank_cd(c.search_vector, websearch_to_tsquery('english', $1)) AS keyword_score
         FROM chunks c JOIN sources s USING (source_id)
         WHERE c.search_vector @@ websearch_to_tsquery('english', $1)
           AND ($3::text IS NULL OR c.video_id = $3)
         ORDER BY keyword_score DESC LIMIT $2`,
        [keywordQuery, config.keywordLimit, videoId],
      );
      fbLists.push({ name: "fb-keyword", documents: fbKeyword.rows.map(keywordDocument) });
    } catch { /* bounded answer already exists; fallback is best-effort */ }

    const fbFused = reciprocalRankFusion(fbLists, { limit: config.fusedLimit });
    if (fbFused.length >= 2) {
      finalChunks = fbFused;
      fallbackUsed = true;
    }
  }

  // Only worth probing when there is a bound to be ahead of, and only using the
  // primary query vector — the point is to locate the lesson, not to rank well.
  let lookahead = null;
  if (upToLesson != null) {
    const ahead = await probeAhead({ vector: queryVectors[0], query: keywordQuery, videoId, upToLesson });
    if (ahead) {
      const boundedBest = bestVectorScore(lists);
      lookahead = {
        ...ahead,
        /**
         * True when the unseen material is a better match than anything in
         * range — i.e. the student is asking about something the course has
         * not taught them yet, rather than something it covers again later.
         */
        strongerThanTaught: ahead.bestVectorScore != null && boundedBest != null
          && ahead.bestVectorScore > boundedBest + 0.02,
        taughtBestScore: boundedBest,
      };
    }
  }

  return { retrievedChunks: finalChunks, fallbackUsed, lookahead, trace: {
    ...state.trace, retrievalMs: Date.now() - startedAt, queryVariantCount: state.queryVariants.length,
    videoId, currentTime, upToLesson, fallbackUsed,
    retrievedCount: finalChunks.length,
    lookaheadLesson: lookahead?.lessonLabel ?? null,
    lookaheadStronger: lookahead?.strongerThanTaught ?? null,
    retrievalLists: lists.map(({ name, documents }) => ({ name, count: documents.length })),
  } };
}
