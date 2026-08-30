import { extname } from "node:path";

function parseTimestamp(value) {
  const parts = value.trim().replace(",", ".").split(":").map(Number);
  if (parts.some(Number.isNaN) || parts.length < 2 || parts.length > 3) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function cleanCueText(lines) {
  return lines
    .join(" ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSubtitle(input) {
  const blocks = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const segments = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const match = lines[timingIndex].match(/((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})/);
    if (!match) continue;
    const startTime = parseTimestamp(match[1]);
    const endTime = parseTimestamp(match[2]);
    const text = cleanCueText(lines.slice(timingIndex + 1));
    if (startTime == null || endTime == null || !text) continue;

    const previous = segments.at(-1);
    if (previous?.text === text) {
      previous.endTime = Math.max(previous.endTime, endTime);
    } else {
      segments.push({ startTime, endTime, text });
    }
  }
  return segments;
}

export function createTranscriptChunks(segments, { chunkSize, chunkOverlap }) {
  if (!segments.length) return [];
  const chunks = [];
  let current = [];
  let currentLength = 0;

  const emit = () => {
    if (!current.length) return;
    chunks.push({
      content: current.map(({ text }) => text).join(" "),
      startTime: current[0].startTime,
      endTime: current.at(-1).endTime,
    });
  };

  for (const segment of segments) {
    const addedLength = segment.text.length + (current.length ? 1 : 0);
    if (current.length && currentLength + addedLength > chunkSize) {
      emit();
      const overlap = [];
      let overlapLength = 0;
      for (let index = current.length - 1; index >= 0 && overlapLength < chunkOverlap; index -= 1) {
        overlap.unshift(current[index]);
        overlapLength += current[index].text.length + (overlap.length > 1 ? 1 : 0);
      }
      current = overlap;
      currentLength = overlapLength;
    }
    current.push(segment);
    currentLength += segment.text.length + (current.length > 1 ? 1 : 0);
  }
  emit();
  return chunks;
}

export function preferVttTranscripts(files) {
  const normalized = new Set(files.map((file) => file.toLowerCase()));
  return files.filter((file) => {
    if (extname(file).toLowerCase() !== ".srt") return true;
    const vttPath = `${file.slice(0, -4)}.vtt`.toLowerCase();
    return !normalized.has(vttPath);
  }).sort((left, right) => left.localeCompare(right));
}
