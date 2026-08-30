import express from "express";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { compileGraph } from "./graph.js";
import { config } from "./config.js";
import { curriculumView, loadCurriculum, resolveProgress } from "./curriculum.js";
import { pool } from "./db.js";
import { ingestPath } from "./ingestion/ingest.js";
import { qdrant, deleteSourceVectors } from "./storage/qdrant.js";
import { normalizeHistory, normalizeVideoId } from "./utils/video.js";

const querySchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  currentTime: z.coerce.number().min(0).optional(),
  conversationId: z.string().trim().max(100).optional(),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).max(20).optional(),
  mode: z.enum(["ask", "catch_up", "explain", "summarize", "key_points", "quiz", "plan"]).default("ask"),
  /**
   * The student's position in the course, expressed whichever way suits the
   * client. Omit all three to search the whole course with no progress
   * awareness — which is the honest default for someone who has finished it.
   */
  upToLesson: z.coerce.number().int().min(1).optional(),
  lessonId: z.string().trim().max(40).optional(),
  moduleOrder: z.coerce.number().int().min(0).optional(),
  lessonInModule: z.coerce.number().int().min(1).optional(),
});

function corsMiddleware(request, response, next) {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (request.method === "OPTIONS") return response.status(204).end();
  next();
}

function createRateLimiter() {
  const clients = new Map();
  return (request, response, next) => {
    const key = request.ip;
    const now = Date.now();
    const record = clients.get(key);
    if (!record || now - record.startedAt >= 60_000) {
      clients.set(key, { startedAt: now, count: 1 });
      return next();
    }
    record.count += 1;
    if (record.count > config.rateLimitPerMinute) {
      response.set("Retry-After", String(Math.ceil((60_000 - (now - record.startedAt)) / 1_000)));
      return response.status(429).json({ error: "Too many requests" });
    }
    next();
  };
}

function extensionAuth(request, response, next) {
  if (!config.extensionApiToken || !request.path.startsWith("/videos/")) return next();
  const token = request.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (token !== config.extensionApiToken) return response.status(401).json({ error: "Unauthorized" });
  next();
}

function answerPayload(state, conversationId) {
  return {
    answer: state.bestAnswer ?? state.answer,
    citations: state.bestCitations?.length ? state.bestCitations : state.citations,
    insufficientContext: state.insufficientContext,
    /**
     * Present when the question is answered better by material the student has
     * not reached. The client renders it as "this is coming up in …" rather
     * than as an error.
     */
    lookahead: state.lookahead ?? null,
    upToLesson: state.upToLesson ?? null,
    score: state.bestScore,
    grade: state.gradeMetrics,
    attempts: state.attempts,
    trace: state.trace,
    conversationId,
  };
}

async function invokeVideoGraph(graph, videoId, input) {
  const conversationId = input.conversationId || randomUUID();
  const curriculum = await loadCurriculum();
  const { order: upToLesson } = resolveProgress(curriculum, input);
  const state = await graph.invoke({
    originalQuery: input.question,
    videoId,
    upToLesson,
    currentTime: input.currentTime ?? null,
    conversationId,
    conversationHistory: normalizeHistory(input.history),
    mode: input.mode,
    filters: { ...(videoId ? { videoId } : {}), ...(upToLesson != null ? { upToLesson } : {}) },
  });
  return answerPayload(state, conversationId);
}

function sse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * The study app. Served by the API so there is one origin, one port, one process
 * — which is why the page can call `fetch("/query")` with no base URL and no CORS.
 *
 * The page lives in the sibling `frontend/` directory, outside this package. The
 * Docker image mirrors that same layout on purpose (`/app/backend` next to
 * `/app/frontend`), so this one relative path resolves identically in local
 * development and inside the container. Flattening the image to a single
 * directory would silently break it in exactly one of the two places.
 */
const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend", "public");

export function createApp({ graph = compileGraph() } = {}) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(corsMiddleware);
  app.use(express.json({ limit: "1mb" }));
  /**
   * Static files are served *before* the rate limiter and the auth gate. Loading
   * a page costs four requests, and none of them should eat into a budget meant
   * for the expensive thing — nor should the app shell be unreachable on a
   * deployment that has set EXTENSION_API_TOKEN.
   */
  app.use(express.static(PUBLIC_DIR, { extensions: ["html"], maxAge: "1h" }));
  app.use(createRateLimiter());
  app.use(extensionAuth);

  app.get("/health", async (_request, response) => {
    const health = { status: "ok", postgres: false, qdrant: false };
    try { await pool.query("SELECT 1"); health.postgres = true; } catch { health.status = "degraded"; }
    try { await qdrant.getCollections(); health.qdrant = true; } catch { health.status = "degraded"; }
    response.status(health.status === "ok" ? 200 : 503).json(health);
  });

  /**
   * The course spine, optionally annotated with where the student is and which
   * lessons are actually in the index. One request gives a client everything it
   * needs to draw a progress spine and to know what it can ask about.
   */
  app.get("/curriculum", async (request, response, next) => {
    try {
      const curriculum = await loadCurriculum({ reload: request.query.reload === "1" });
      const { order } = resolveProgress(curriculum, {
        lessonId: request.query.lessonId, upToLesson: request.query.upToLesson,
        moduleOrder: request.query.moduleOrder, lessonInModule: request.query.lessonInModule,
      });
      const view = curriculumView(curriculum, order);
      try {
        const indexed = await pool.query("SELECT video_id, COUNT(*)::int AS chunks FROM chunks WHERE video_id IS NOT NULL GROUP BY video_id");
        const chunksByLesson = new Map(indexed.rows.map((row) => [row.video_id, row.chunks]));
        for (const lesson of view.lessons) lesson.chunks = chunksByLesson.get(lesson.lessonId) ?? 0;
        view.course = { ...view.course, indexedLessons: view.lessons.filter((lesson) => lesson.chunks > 0).length };
      } catch {
        // The spine is useful on its own; a database outage should not hide it.
        view.course = { ...view.course, indexedLessons: null };
      }
      response.json(view);
    } catch (error) { next(error); }
  });

  /**
   * What the course teaches and where. `q` matches the label or any alias, so a
   * client can answer "where is this covered" without a retrieval round trip.
   *
   * `kind` defaults differently depending on why you are asking, which is the
   * whole point of grading concepts:
   *
   *   - browsing (no `q`) shows `core` only, because an unfiltered list is 480
   *     rows of which most are one-off implementation details — that reads as
   *     noise, not as a course outline;
   *   - searching (with `q`) looks everywhere, because someone typing a name
   *     wants to find it whether or not the course builds on it.
   *
   * `?kind=all` and `?kind=background` override both. `background` on its own is
   * the course's entry requirements.
   */
  app.get("/concepts", async (request, response, next) => {
    try {
      const search = String(request.query.q ?? "").trim();
      const requested = String(request.query.kind ?? "").trim().toLowerCase();
      const kinds = ["core", "detail", "background", "all"].includes(requested)
        ? requested
        : (search ? "all" : "core");
      const upToLesson = request.query.upToLesson == null ? null : Number(request.query.upToLesson);
      const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
      const result = await pool.query(
        `SELECT c.concept_id, c.label, c.aliases, c.summary, c.kind, c.lessons, c.dependents,
                c.first_taught_order, c.first_taught_video_id, c.first_taught_at,
                s.lesson_label, s.source_title
         FROM concepts c
         LEFT JOIN sources s ON s.video_id = c.first_taught_video_id
         WHERE ($1 = '' OR c.label ILIKE '%' || $1 || '%' OR EXISTS (
                  SELECT 1 FROM unnest(c.aliases) alias WHERE alias ILIKE '%' || $1 || '%'))
           AND ($2 = 'all' OR c.kind = $2)
         ORDER BY c.first_taught_order NULLS LAST, c.dependents DESC, c.label
         LIMIT $3`,
        [search, kinds, limit],
      );
      response.json({
        kind: kinds,
        concepts: result.rows.map((row) => ({
          ...row,
          // Null rather than false when no position was given: not knowing is
          // different from not having reached it.
          reached: upToLesson == null || row.first_taught_order == null ? null : row.first_taught_order <= upToLesson,
        })),
        /** Concepts with no first_taught_order are the background the course assumes. */
        assumedBackground: result.rows.filter((row) => row.first_taught_order == null).length,
      });
    } catch (error) { next(error); }
  });

  /**
   * One concept with its prerequisite chain. The `reached` flags turn this into
   * the answer to "why is this hard for me right now": the unmet prerequisites,
   * in the order the course teaches them.
   */
  app.get("/concepts/:conceptId", async (request, response, next) => {
    try {
      const conceptId = String(request.params.conceptId).slice(0, 80);
      const upToLesson = request.query.upToLesson == null ? null : Number(request.query.upToLesson);
      const concept = await pool.query("SELECT * FROM concepts WHERE concept_id = $1", [conceptId]);
      if (!concept.rowCount) return response.status(404).json({ error: "Unknown concept" });

      const prerequisites = await pool.query(
        `WITH RECURSIVE deps AS (
           SELECT requires_id AS concept_id, 1 AS depth FROM concept_edges WHERE concept_id = $1
           UNION
           SELECT e.requires_id, d.depth + 1 FROM concept_edges e JOIN deps d ON e.concept_id = d.concept_id
           WHERE d.depth < 5
         )
         SELECT c.concept_id, c.label, c.summary, c.kind, c.dependents, c.first_taught_order,
                c.first_taught_video_id, c.first_taught_at, s.lesson_label, MIN(d.depth) AS depth
         FROM deps d JOIN concepts c USING (concept_id)
         LEFT JOIN sources s ON s.video_id = c.first_taught_video_id
         GROUP BY c.concept_id, c.label, c.summary, c.kind, c.dependents, c.first_taught_order,
                  c.first_taught_video_id, c.first_taught_at, s.lesson_label
         ORDER BY c.first_taught_order NULLS LAST, c.label`,
        [conceptId],
      );
      const coveredIn = await pool.query(
        `SELECT m.video_id, m.lesson_order, m.start_time, m.role, s.lesson_label, s.source_title
         FROM concept_mentions m LEFT JOIN sources s ON s.video_id = m.video_id
         WHERE m.concept_id = $1 ORDER BY m.lesson_order`,
        [conceptId],
      );

      const reached = (order) => (upToLesson == null || order == null ? null : order <= upToLesson);
      response.json({
        concept: { ...concept.rows[0], reached: reached(concept.rows[0].first_taught_order) },
        prerequisites: prerequisites.rows.map((row) => ({ ...row, reached: reached(row.first_taught_order) })),
        /** The subset a student at `upToLesson` has not yet been taught. */
        gaps: upToLesson == null ? null : prerequisites.rows
          .filter((row) => row.first_taught_order != null && row.first_taught_order > upToLesson)
          .map(({ concept_id, label, first_taught_order, lesson_label }) => ({ concept_id, label, first_taught_order, lesson_label })),
        assumedBackground: prerequisites.rows
          .filter((row) => row.first_taught_order == null)
          .map(({ concept_id, label }) => ({ concept_id, label })),
        coveredIn: coveredIn.rows,
      });
    } catch (error) { next(error); }
  });

  /**
   * Whether a student is ready for a lesson: the concepts it introduces, and
   * which of their prerequisites the student has not reached yet.
   */
  app.get("/videos/:videoId/readiness", async (request, response, next) => {
    try {
      const videoId = normalizeVideoId(request.params.videoId);
      if (!videoId) return response.status(400).json({ error: "Invalid lesson ID" });
      const curriculum = await loadCurriculum();
      const lesson = curriculum.byId.get(videoId);
      if (!lesson) return response.status(404).json({ error: "Unknown lesson" });
      const { order } = resolveProgress(curriculum, {
        upToLesson: request.query.upToLesson, lessonId: request.query.lessonId,
        moduleOrder: request.query.moduleOrder, lessonInModule: request.query.lessonInModule,
      });
      // Default to the lesson before this one: the natural reading of "am I
      // ready for this" is "given everything up to here".
      const position = order ?? lesson.order - 1;

      const missing = await pool.query(
        `WITH introduced AS (
           SELECT concept_id FROM concept_mentions WHERE video_id = $1 AND role = 'introduce'
         ), deps AS (
           SELECT e.requires_id AS concept_id FROM concept_edges e JOIN introduced i ON e.concept_id = i.concept_id
         )
         SELECT DISTINCT c.concept_id, c.label, c.kind, c.first_taught_order, c.first_taught_video_id, s.lesson_label
         FROM deps d JOIN concepts c USING (concept_id)
         LEFT JOIN sources s ON s.video_id = c.first_taught_video_id
         WHERE c.first_taught_order IS NOT NULL AND c.first_taught_order > $2
         ORDER BY c.first_taught_order`,
        [videoId, position],
      );
      /**
       * A gap in a `core` concept is a real "go back and watch this first"; a
       * `detail` gap is usually a helper from a later mini-project that happens
       * to share a name. Both are returned, but `ready` is judged on core only,
       * otherwise almost no lesson ever reads as ready.
       */
      const blocking = missing.rows.filter((row) => row.kind === "core");
      response.json({
        lesson, upToLesson: position,
        ready: blocking.length === 0,
        missingPrerequisites: blocking,
        alsoMissing: missing.rows.filter((row) => row.kind !== "core"),
      });
    } catch (error) { next(error); }
  });

  app.get("/videos/:videoId/status", async (request, response, next) => {
    try {
      const videoId = normalizeVideoId(request.params.videoId);
      if (!videoId) return response.status(400).json({ error: "Invalid video ID" });
      const result = await pool.query(
        `SELECT s.video_id, MAX(s.source_title) AS title, MAX(s.duration) AS duration,
                MAX(s.lesson_label) AS lesson_label, MAX(s.lesson_order) AS lesson_order,
                COUNT(DISTINCT s.source_id)::int AS sources, COUNT(c.chunk_id)::int AS chunks
         FROM sources s LEFT JOIN chunks c USING (source_id)
         WHERE s.video_id = $1 GROUP BY s.video_id`, [videoId],
      );
      response.json(result.rows[0] ? { indexed: true, ...result.rows[0] } : { indexed: false, video_id: videoId, sources: 0, chunks: 0 });
    } catch (error) { next(error); }
  });

  /**
   * Openers, phrased for a course rather than a video — there is no player, so
   * "explain this part" has no referent, but "what do I need before this
   * lesson" does. When the lesson is known, the copy names it.
   */
  app.get("/videos/:videoId/suggestions", async (request, response, next) => {
    try {
      const videoId = normalizeVideoId(request.params.videoId);
      if (!videoId) return response.status(400).json({ error: "Invalid video ID" });
      const curriculum = await loadCurriculum();
      const lesson = curriculum.byId.get(videoId) ?? null;
      const subject = lesson ? `"${lesson.title}"` : "this lesson";
      response.json({ lesson, suggestions: [
        { label: "Summarize this lesson", mode: "summarize", question: `Summarize ${subject}.` },
        { label: "Key points", mode: "key_points", question: `What are the key learning points of ${subject}?` },
        { label: "What do I need first?", mode: "plan", question: `Which earlier lessons should I understand before ${subject}?` },
        { label: "Catch me up", mode: "catch_up", question: "Catch me up on everything the course has covered so far." },
        { label: "Quiz me", mode: "quiz", question: "Quiz me on what I have covered so far." },
      ] });
    } catch (error) { next(error); }
  });

  app.post("/videos/:videoId/query", async (request, response, next) => {
    try {
      const videoId = normalizeVideoId(request.params.videoId);
      if (!videoId) return response.status(400).json({ error: "Invalid video ID" });
      const parsed = querySchema.safeParse(request.body);
      if (!parsed.success) return response.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      response.json(await invokeVideoGraph(graph, videoId, parsed.data));
    } catch (error) { next(error); }
  });

  app.post("/videos/:videoId/query/stream", async (request, response) => {
    const videoId = normalizeVideoId(request.params.videoId);
    const parsed = querySchema.safeParse(request.body);
    if (!videoId || !parsed.success) return response.status(400).json({ error: "Invalid video query" });
    response.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    sse(response, "status", { stage: "retrieving" });
    try {
      const payload = await invokeVideoGraph(graph, videoId, parsed.data);
      sse(response, "status", { stage: "generating" });
      const parts = payload.answer.match(/\S+\s*/g) ?? [payload.answer];
      for (let index = 0; index < parts.length; index += 6) {
        sse(response, "answer_delta", { text: parts.slice(index, index + 6).join("") });
      }
      const { answer: _answer, ...completion } = payload;
      sse(response, "complete", completion);
    } catch (error) {
      sse(response, "error", { message: process.env.NODE_ENV === "development" ? error.message : "Unable to answer this question" });
    } finally { response.end(); }
  });

  app.post("/query", async (request, response, next) => {
    try {
      const parsed = querySchema.safeParse(request.body);
      if (!parsed.success) return response.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      response.json(await invokeVideoGraph(graph, normalizeVideoId(request.body?.videoId), parsed.data));
    } catch (error) { next(error); }
  });

  app.post("/ingest", async (request, response, next) => {
    try {
      const path = request.body?.path?.trim();
      if (!path) return response.status(400).json({ error: "path is required" });
      response.status(201).json({ results: await ingestPath(path, { force: Boolean(request.body.force) }) });
    } catch (error) { next(error); }
  });

  app.get("/sources", async (_request, response, next) => {
    try {
      const result = await pool.query("SELECT source_id, source_type, source_title, source_path, source_url, video_id, module, language, lesson_order, module_order, lesson_label, ingested_at, updated_at FROM sources ORDER BY lesson_order NULLS LAST, updated_at DESC");
      response.json({ sources: result.rows });
    } catch (error) { next(error); }
  });

  app.delete("/sources/:sourceId", async (request, response, next) => {
    try {
      await deleteSourceVectors(request.params.sourceId);
      const result = await pool.query("DELETE FROM sources WHERE source_id = $1", [request.params.sourceId]);
      response.status(result.rowCount ? 204 : 404).end();
    } catch (error) { next(error); }
  });

  app.use((error, _request, response, _next) => {
    console.error(error.stack ?? error.message);
    response.status(500).json({ error: "Internal server error", message: process.env.NODE_ENV === "development" ? error.message : undefined });
  });
  return app;
}
