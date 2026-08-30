import { extname, basename, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parseSubtitle } from "./subtitles.js";

function transcriptToText(value) {
  const segments = Array.isArray(value) ? value : value.segments ?? value.chunks ?? [];
  if (!Array.isArray(segments) || segments.length === 0) return JSON.stringify(value, null, 2);
  return segments
    .map((segment) => {
      const text = segment.text ?? segment.content ?? "";
      const start = segment.start_time ?? segment.start;
      return start == null ? text : `[${start}s] ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

async function readPdf(buffer) {
  const module = await import("pdf-parse");
  if (typeof module.default === "function") return (await module.default(buffer)).text;
  if (module.PDFParse) {
    const parser = new module.PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  throw new Error("Unsupported pdf-parse API version");
}

export async function loadFile(filePath) {
  const absolutePath = resolve(filePath);
  const extension = extname(absolutePath).toLowerCase();
  const buffer = await readFile(absolutePath);
  let text;
  let segments;

  if ([".txt", ".md", ".markdown"].includes(extension)) text = buffer.toString("utf8");
  else if (extension === ".json") text = transcriptToText(JSON.parse(buffer.toString("utf8")));
  else if (extension === ".pdf") text = await readPdf(buffer);
  else if ([".srt", ".vtt"].includes(extension)) {
    segments = parseSubtitle(buffer.toString("utf8"));
    text = segments.map(({ text: cueText }) => cueText).join("\n");
  }
  else throw new Error(`Unsupported file type: ${extension || "unknown"}`);

  return {
    text: text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
    metadata: {
      sourcePath: absolutePath,
      sourceTitle: basename(absolutePath, extension),
      sourceType: extension.slice(1),
    },
    segments,
  };
}

export const supportedExtensions = new Set([".txt", ".md", ".markdown", ".json", ".pdf", ".srt", ".vtt"]);
