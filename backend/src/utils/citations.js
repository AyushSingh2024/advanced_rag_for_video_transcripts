import { formatLessonCitation } from "./video.js";

export function validCitationNumbers(citations, contextLength) {
  return [...new Set(citations)].filter(Number.isInteger).filter((number) => number >= 1 && number <= contextLength);
}

export function citationRecords(citations, chunks) {
  return validCitationNumbers(citations, chunks.length).map((number) => {
    const chunk = chunks[number - 1];
    const lessonLabel = chunk.lesson_label ?? null;
    return {
      number,
      chunkId: chunk.id,
      sourceId: chunk.source_id,
      sourceTitle: chunk.source_title,
      sourcePath: chunk.source_path,
      sourceUrl: chunk.source_url ?? null,
      pageNumber: chunk.page_number ?? null,
      videoId: chunk.video_id ?? null,
      startTime: chunk.start_time ?? null,
      endTime: chunk.end_time ?? null,
      lessonOrder: chunk.lesson_order ?? null,
      lessonLabel,
      /**
       * The human-readable locator. There is no video to link to, so this
       * string is the entire affordance: the student reads it, opens that
       * lesson in their own copy of the course, and scrubs to that time.
       */
      label: formatLessonCitation({ lessonLabel, sourceTitle: chunk.source_title, startTime: chunk.start_time }),
      /** A short verbatim anchor so the student can confirm they are in the right place. */
      quote: excerpt(chunk.content),
    };
  });
}

const MAX_QUOTE = 180;

function excerpt(content) {
  const text = String(content ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= MAX_QUOTE) return text;
  const cut = text.slice(0, MAX_QUOTE);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > MAX_QUOTE * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}
