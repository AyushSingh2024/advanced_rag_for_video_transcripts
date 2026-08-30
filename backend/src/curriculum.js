/**
 * Runtime access to the curriculum spine.
 *
 * The spine is built offline (`npm run curriculum`) and read here. It is small
 * — 87 lessons — so it is loaded once and held in memory; nothing about a
 * student's position needs a database round trip.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "./config.js";

let cache = null;

function index(curriculum) {
  const byId = new Map();
  const byOrder = new Map();
  const byFile = new Map();
  for (const lesson of curriculum.lessons) {
    byId.set(lesson.lessonId, lesson);
    byOrder.set(lesson.order, lesson);
    byFile.set(lesson.file.toLowerCase(), lesson);
  }
  return { ...curriculum, byId, byOrder, byFile };
}

/**
 * Absent or unbuilt curriculum is not fatal: the pipeline degrades to
 * course-wide retrieval with no progress awareness, which is exactly how it
 * behaved before the spine existed.
 */
export async function loadCurriculum({ reload = false } = {}) {
  if (cache && !reload) return cache;
  try {
    const path = resolve(config.curriculumPath);
    cache = index(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Cannot read curriculum at ${config.curriculumPath}: ${error.message}`);
    cache = index({ course: { lessonCount: 0, moduleCount: 0, available: false }, modules: [], lessons: [] });
  }
  return cache;
}

export function clearCurriculumCache() { cache = null; }

/**
 * Resolves however the client chose to express the student's position into a
 * single lesson order. Accepts a lesson id ("m04-l09"), a raw order (29), or a
 * module/lesson pair — clients should not have to know the global numbering.
 *
 * Returns `{ lesson, order }` with a null lesson when nothing matches, so a
 * stale bookmark degrades to unbounded search rather than an error.
 */
export function resolveProgress(curriculum, { lessonId, upToLesson, moduleOrder, lessonInModule } = {}) {
  if (lessonId && curriculum.byId.has(lessonId)) {
    const lesson = curriculum.byId.get(lessonId);
    return { lesson, order: lesson.order };
  }
  const order = Number(upToLesson);
  if (Number.isFinite(order) && order >= 1) {
    const clamped = Math.min(Math.trunc(order), curriculum.lessons.length || Math.trunc(order));
    return { lesson: curriculum.byOrder.get(clamped) ?? null, order: clamped };
  }
  if (Number.isFinite(Number(moduleOrder))) {
    const inModule = curriculum.lessons.filter((lesson) => lesson.moduleOrder === Number(moduleOrder));
    if (inModule.length) {
      const position = Number(lessonInModule);
      const lesson = Number.isFinite(position)
        ? inModule[Math.min(Math.max(Math.trunc(position), 1), inModule.length) - 1]
        : inModule.at(-1);
      return { lesson, order: lesson.order };
    }
  }
  return { lesson: null, order: null };
}

/** Everything the student has covered, for a study plan or a progress bar. */
export function lessonsUpTo(curriculum, order) {
  if (order == null) return curriculum.lessons;
  return curriculum.lessons.filter((lesson) => lesson.order <= order);
}

/** Shape for the client: the spine plus where the student is sitting on it. */
export function curriculumView(curriculum, order = null) {
  return {
    course: curriculum.course,
    modules: curriculum.modules,
    lessons: curriculum.lessons.map(({ lessonId, order: lessonOrder, title, label, moduleId, moduleOrder, moduleTitle, lessonInModule, unitKind, unitNumber, bonus, duration, durationSeconds }) => ({
      lessonId, order: lessonOrder, title, label, moduleId, moduleOrder, moduleTitle,
      lessonInModule, unitKind, unitNumber, bonus, duration, durationSeconds,
      reached: order == null ? null : lessonOrder <= order,
    })),
    progress: order == null ? null : {
      upToLesson: order,
      lesson: curriculum.byOrder.get(order) ?? null,
      covered: lessonsUpTo(curriculum, order).length,
      total: curriculum.lessons.length,
    },
  };
}
