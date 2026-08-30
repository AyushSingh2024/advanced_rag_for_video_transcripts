export function normalizeVideoId(value) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
}

/**
 * How far the student has got, as a lesson order from curriculum.json.
 * Null means "no bound" — search the whole course.
 */
export function normalizeLessonOrder(value) {
  const order = Number(value);
  return Number.isFinite(order) && order >= 1 ? Math.trunc(order) : null;
}

/**
 * Qdrant filter for a lesson scope and/or a curriculum bound.
 *
 * The `should` branch on lesson_order is load-bearing: a range filter drops
 * points where the field is missing, so without it any non-lesson document
 * (a PDF, a README) would silently vanish the moment a bound was applied.
 */
export function buildQdrantVideoFilter(videoId, upToLesson = null) {
  const must = [];
  if (videoId) must.push({ key: "video_id", match: { value: videoId } });
  if (upToLesson != null) {
    must.push({ should: [
      { key: "lesson_order", range: { lte: upToLesson } },
      { is_null: { key: "lesson_order" } },
    ] });
  }
  return must.length ? { must } : undefined;
}

/** The mirror image: only material the student has NOT reached yet. */
export function buildQdrantAheadFilter(videoId, fromLesson) {
  const must = [{ key: "lesson_order", range: { gt: fromLesson } }];
  if (videoId) must.push({ key: "video_id", match: { value: videoId } });
  return { must };
}

export function normalizeHistory(history, limit = 8) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((item) => ["user", "assistant"].includes(item?.role) && typeof item?.content === "string")
    .map((item) => ({ role: item.role, content: item.content.trim().slice(0, 2_000) }))
    .filter((item) => item.content)
    .slice(-limit);
}

export function formatTimestamp(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/**
 * How a source is named when there is no video to link to.
 * "Module 13 · Chapter 2 · 04:12 — credentials login"
 *
 * This is the whole citation contract for a transcript-only corpus: the student
 * opens their own copy of the course, goes to that lesson, and scrubs to that
 * time. Label and title are both included because the label alone is not
 * findable in a course listing and the title alone is not ordered.
 */
export function formatLessonCitation({ lessonLabel, sourceTitle, startTime } = {}) {
  const parts = [];
  if (lessonLabel) parts.push(lessonLabel);
  if (startTime != null && Number.isFinite(Number(startTime))) parts.push(formatTimestamp(startTime));
  const located = parts.join(" · ");
  if (located && sourceTitle) return `${located} — ${sourceTitle}`;
  return located || sourceTitle || "Unknown source";
}
