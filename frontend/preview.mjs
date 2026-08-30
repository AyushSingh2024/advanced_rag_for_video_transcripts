#!/usr/bin/env node
/**
 * Design preview server — real curriculum, invented answers.
 *
 * Most of the redesign only becomes visible in states that cost money and
 * infrastructure to reach: a graded answer whose citations land at three
 * different distances from your playhead. Standing up Postgres, Qdrant and an
 * embedding bill to look at a colour is the wrong trade, so this serves the
 * page with the genuine 87-lesson spine and the genuine concept graph read
 * straight off disk, and fabricates the one thing that needs a pipeline: the
 * answer.
 *
 *   node frontend/preview.js                 → http://localhost:4000
 *   node frontend/preview.js --degraded      → the everything-is-down appearance
 *   node frontend/preview.js --insufficient  → the "context was insufficient" answer
 *
 * Every path is resolved from this file's own location rather than from the
 * working directory, so it runs correctly from anywhere — unlike `npm run
 * serve`, where a relative CURRICULUM_PATH means the spine only loads from
 * backend/.
 *
 * This file is imported by nothing, lives outside frontend/public so it is
 * never served, and is outside the Dockerfile's `COPY frontend/public` so it
 * cannot reach an image. Keep it that way: every answer it gives is made up.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
const SPINE_DIR = resolve(HERE, "..", "backend", "transcripts", "class-subtitle");

const PORT = Number(process.env.PREVIEW_PORT ?? 4000);
/** A visible wait, because the spinner and the staggered arrival are the point. */
const LATENCY_MS = Number(process.env.PREVIEW_LATENCY ?? 700);
const DEGRADED = process.argv.includes("--degraded");
const INSUFFICIENT = process.argv.includes("--insufficient");

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
};

async function loadJson(name) {
  try {
    return JSON.parse(await readFile(join(SPINE_DIR, name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Missing ${name}. Expected it at ${SPINE_DIR} — this preview reads the real spine rather than mocking one.`);
    }
    throw error;
  }
}

const spine = await loadJson("curriculum.json");
const graph = await loadJson("concept-graph.json");

/** lessonId is the videoId throughout this corpus, which is what makes the joins below cheap. */
const lessonById = new Map(spine.lessons.map((lesson) => [lesson.lessonId, lesson]));
const lessonByOrder = new Map(spine.lessons.map((lesson) => [lesson.order, lesson]));
const conceptById = new Map(graph.concepts.map((concept) => [concept.conceptId, concept]));
const requiredBy = graph.edges.reduce((map, edge) => {
  if (!map.has(edge.conceptId)) map.set(edge.conceptId, []);
  map.get(edge.conceptId).push(edge.requiresId);
  return map;
}, new Map());
const mentionsByConcept = graph.mentions.reduce((map, mention) => {
  if (!map.has(mention.conceptId)) map.set(mention.conceptId, []);
  map.get(mention.conceptId).push(mention);
  return map;
}, new Map());

/* --------------------------------------------------------------- shaping ---
 * The page reads snake_case from the concept endpoints because those rows come
 * straight out of Postgres, and camelCase from the curriculum because that one
 * is JSON all the way down. The preview has to reproduce that split exactly, or
 * it will look like the page is broken when it is the mock that is wrong.
 */
function conceptRow(concept) {
  const lesson = concept.firstTaughtVideoId ? lessonById.get(concept.firstTaughtVideoId) : null;
  return {
    concept_id: concept.conceptId, label: concept.label, aliases: concept.aliases ?? [],
    summary: concept.summary ?? null, kind: concept.kind, lessons: concept.lessons ?? 0,
    dependents: concept.dependents ?? 0,
    first_taught_order: concept.firstTaughtOrder ?? null,
    first_taught_video_id: concept.firstTaughtVideoId ?? null,
    first_taught_at: concept.firstTaughtAt ?? null,
    lesson_label: lesson?.label ?? null, source_title: lesson?.title ?? null,
  };
}

function curriculumView() {
  const lessons = spine.lessons.map((lesson) => ({
    lessonId: lesson.lessonId, order: lesson.order, title: lesson.title, label: lesson.label,
    moduleId: lesson.moduleId, moduleOrder: lesson.moduleOrder, moduleTitle: lesson.moduleTitle,
    lessonInModule: lesson.lessonInModule, unitKind: lesson.unitKind, unitNumber: lesson.unitNumber,
    bonus: lesson.bonus, duration: lesson.duration, durationSeconds: lesson.durationSeconds,
    reached: null,
    // What a real ingest would report. Degraded stands in for a database outage,
    // where the server still serves the spine and reports the count as unknown.
    chunks: DEGRADED ? 0 : Math.max(4, Math.round((lesson.durationSeconds ?? 300) / 90)),
  }));
  return {
    course: {
      ...spine.course,
      indexedLessons: DEGRADED ? null : lessons.length,
    },
    modules: spine.modules,
    lessons,
    progress: null,
  };
}

/** Depth-bounded prerequisite closure — the recursive CTE, in a loop. */
function prerequisitesOf(conceptId, maxDepth = 5) {
  const depths = new Map();
  let frontier = requiredBy.get(conceptId) ?? [];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
    const next = [];
    for (const id of frontier) {
      if (depths.has(id)) continue;
      depths.set(id, depth);
      next.push(...(requiredBy.get(id) ?? []));
    }
    frontier = next;
  }
  return [...depths]
    .map(([id, depth]) => (conceptById.has(id) ? { ...conceptRow(conceptById.get(id)), depth } : null))
    .filter(Boolean)
    .sort((a, b) => (a.first_taught_order ?? Infinity) - (b.first_taught_order ?? Infinity)
      || a.label.localeCompare(b.label));
}

/* ------------------------------------------------------------- the answer ---
 * Citations are placed relative to the playhead on purpose: one lesson behind
 * it, one on it, one past it. That single spread exercises the whole citation
 * contract in one request — chapter and minute for something covered, the
 * minute alone for the lesson you are on, and a bare chapter name for the one
 * you have not reached.
 *
 * Note that the `ahead` citation is handed a real quote. The page must refuse
 * to render it; that refusal is the contract, and a mock that withheld the
 * quote would prove nothing.
 */
const ANSWER = `Navigation in Expo comes from React Navigation, which arrives as a set of packages rather than one — the core \`@react-navigation/native\` plus whichever navigator you actually need [1].

The shape is always the same three pieces:

- a \`NavigationContainer\` wrapping the entire app, once, at the root
- one navigator inside it, usually \`createNativeStackNavigator\`
- one \`Screen\` per route, each with a \`name\` and a \`component\` [2]

With that in place, moving between screens is \`navigation.navigate("Details")\`, and whatever you pass as the second argument arrives as \`route.params\` on the other side. **The container is not optional** — the hooks read from its context, so a screen rendered outside it throws rather than degrading.

Tab and drawer navigators compose with the stack instead of replacing it, which is how a tab bar ends up with its own stack inside the first tab [3].`;

const QUOTES = [
  "So the container wraps everything — if you forget this, the hook has nothing to read from and it throws.",
  "Name and component, that is the whole screen definition. Everything else is optional.",
  "This is the part people get wrong, so watch it twice.",
];

function buildCitations(upToLesson) {
  const total = spine.lessons.length;
  /* Clamped rather than dropped at the ends of the course: at lesson 1 the
     first two collapse onto the same lesson, which is honest — there is nothing
     behind you — and it keeps every [n] marker in the answer resolvable. */
  const orders = upToLesson
    ? [Math.max(1, upToLesson - 9), upToLesson, Math.min(total, upToLesson + 6)]
    : [12, 34, 61];
  return orders.map((order, index) => {
    const lesson = lessonByOrder.get(order) ?? spine.lessons[0];
    return {
      number: index + 1,
      lessonOrder: lesson.order,
      lessonLabel: lesson.label,
      sourceTitle: lesson.title,
      videoId: lesson.lessonId,
      // Placed inside the lesson's real runtime, so the minute is always a
      // timestamp you could actually scrub to.
      startTime: Math.round((lesson.durationSeconds ?? 300) * (0.28 + index * 0.21)),
      quote: QUOTES[index],
    };
  });
}

function queryPayload(body) {
  const upToLesson = Number.isFinite(Number(body.upToLesson)) ? Number(body.upToLesson) : null;
  const citations = buildCitations(upToLesson);
  const ahead = citations[2];
  return {
    answer: INSUFFICIENT
      ? "I could not find enough covered material to answer this without guessing. The closest thing you have reached is the navigation setup [1], but it does not cover what you asked."
      : ANSWER,
    citations: INSUFFICIENT ? [citations[0]] : citations,
    insufficientContext: INSUFFICIENT,
    lookahead: upToLesson && ahead.lessonOrder > upToLesson
      ? { lessonOrder: ahead.lessonOrder, lessonLabel: ahead.lessonLabel, videoId: ahead.videoId }
      : null,
    upToLesson,
    score: INSUFFICIENT ? 4 : 8,
    attempts: INSUFFICIENT ? 3 : 2,
    grade: { relevance: INSUFFICIENT ? 4 : 9, grounded: INSUFFICIENT ? 3 : 8, completeness: INSUFFICIENT ? 2 : 7, citationsChecked: citations.length },
    trace: [
      { node: "rewrite", ms: 190, note: "3 query variants" },
      { node: "retrieve", ms: 470, note: `vector 12 + keyword 20, bound ${upToLesson ?? "none"}` },
      { node: "rerank", ms: 210, note: "25 fused → 6 kept" },
      { node: "grade", ms: 160, note: INSUFFICIENT ? "below threshold on attempt 3" : "8/10 on attempt 2" },
      { node: "preview", ms: 0, note: "this trace is fabricated by frontend/preview.js" },
    ],
    conversationId: "preview-0000-4000-8000-000000000001",
  };
}

/* ------------------------------------------------------------------ serve --- */
const json = (response, status, payload) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
};

async function serveStatic(response, pathname) {
  const target = resolve(PUBLIC_DIR, `.${pathname === "/" ? "/index.html" : pathname}`);
  // A preview server still should not hand out the rest of the disk.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) return json(response, 403, { error: "Forbidden" });
  try {
    const file = await readFile(target);
    response.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
      // No caching at all, so a reload always shows the edit you just made.
      "cache-control": "no-store",
    });
    response.end(file);
  } catch {
    json(response, 404, { error: "Not found", message: pathname });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // One verb check for everything, up front. Without it the JSON routes below
  // answer DELETE and PUT as happily as GET, which is exactly the sort of thing
  // that looks harmless in a preview and then gets copied somewhere real.
  if (request.method !== "GET" && !(path === "/query" && request.method === "POST")) {
    return json(response, 405, { error: "Method not allowed", message: `${request.method} ${path}` });
  }

  try {
    if (path === "/health") {
      const health = { status: DEGRADED ? "degraded" : "ok", postgres: !DEGRADED, qdrant: !DEGRADED, preview: true };
      return json(response, DEGRADED ? 503 : 200, health);
    }

    if (path === "/curriculum") return json(response, 200, curriculumView());

    if (path === "/concepts") {
      if (DEGRADED) return json(response, 503, { error: "Service unavailable", message: "preview --degraded" });
      const search = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const requested = (url.searchParams.get("kind") ?? "").trim().toLowerCase();
      const kinds = ["core", "detail", "background", "all"].includes(requested) ? requested : (search ? "all" : "core");
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
      const upToLesson = url.searchParams.get("upToLesson") == null ? null : Number(url.searchParams.get("upToLesson"));
      const rows = graph.concepts
        .filter((concept) => kinds === "all" || concept.kind === kinds)
        .filter((concept) => !search || concept.label.toLowerCase().includes(search)
          || (concept.aliases ?? []).some((alias) => alias.toLowerCase().includes(search)))
        .map(conceptRow)
        .sort((a, b) => (a.first_taught_order ?? Infinity) - (b.first_taught_order ?? Infinity)
          || b.dependents - a.dependents || a.label.localeCompare(b.label))
        .slice(0, limit)
        .map((row) => ({
          ...row,
          reached: upToLesson == null || row.first_taught_order == null ? null : row.first_taught_order <= upToLesson,
        }));
      return json(response, 200, {
        kind: kinds,
        concepts: rows,
        assumedBackground: rows.filter((row) => row.first_taught_order == null).length,
      });
    }

    if (path.startsWith("/concepts/")) {
      const conceptId = decodeURIComponent(path.slice("/concepts/".length));
      const concept = conceptById.get(conceptId);
      if (!concept) return json(response, 404, { error: "Unknown concept" });
      const upToLesson = url.searchParams.get("upToLesson") == null ? null : Number(url.searchParams.get("upToLesson"));
      const reached = (order) => (upToLesson == null || order == null ? null : order <= upToLesson);
      const prerequisites = prerequisitesOf(conceptId).map((row) => ({ ...row, reached: reached(row.first_taught_order) }));
      return json(response, 200, {
        concept: { ...conceptRow(concept), reached: reached(concept.firstTaughtOrder ?? null) },
        prerequisites,
        gaps: upToLesson == null ? null : prerequisites
          .filter((row) => row.first_taught_order != null && row.first_taught_order > upToLesson)
          .map(({ concept_id, label, first_taught_order, lesson_label }) => ({ concept_id, label, first_taught_order, lesson_label })),
        assumedBackground: prerequisites.filter((row) => row.first_taught_order == null)
          .map(({ concept_id, label }) => ({ concept_id, label })),
        coveredIn: (mentionsByConcept.get(conceptId) ?? [])
          .sort((a, b) => a.lessonOrder - b.lessonOrder)
          .map((mention) => {
            const lesson = lessonById.get(mention.videoId);
            return {
              video_id: mention.videoId, lesson_order: mention.lessonOrder, start_time: mention.startTime,
              role: mention.role, lesson_label: lesson?.label ?? null, source_title: lesson?.title ?? null,
            };
          }),
      });
    }

    if (path === "/query" && request.method === "POST") {
      if (DEGRADED) return json(response, 503, { error: "Service unavailable", message: "Qdrant is unreachable (preview --degraded)" });
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* treat as empty */ }
      await new Promise((done) => setTimeout(done, LATENCY_MS));
      return json(response, 200, queryPayload(body));
    }

    return await serveStatic(response, path);
  } catch (error) {
    json(response, 500, { error: "Preview server failed", message: error.message });
  }
});

server.listen(PORT, () => {
  const flags = [DEGRADED && "--degraded", INSUFFICIENT && "--insufficient"].filter(Boolean).join(" ") || "none";
  console.log(`Preview  http://localhost:${PORT}`);
  console.log(`  spine    ${spine.lessons.length} lessons, ${spine.modules.length} modules — real, from curriculum.json`);
  console.log(`  concepts ${graph.concepts.length} concepts, ${graph.edges.length} edges — real, from concept-graph.json`);
  console.log(`  answers  fabricated, ${LATENCY_MS}ms latency, citations placed behind / on / ahead of the playhead`);
  console.log(`  flags    ${flags}`);
});
