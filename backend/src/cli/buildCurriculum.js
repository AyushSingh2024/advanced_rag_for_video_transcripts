/**
 * Builds the curriculum spine from the transcript folder.
 *
 * The corpus is not a pile of documents — it is an ordered course. Almost
 * everything distinctive this pipeline can do (answering with only what the
 * student has been taught, naming the lesson where a concept is *first*
 * introduced, returning a study path instead of a paragraph) needs one thing
 * to exist first: a reliable global ordering of lessons.
 *
 * Lesson order is recoverable from the filenames, which use four different
 * numbering conventions across the 18 folders:
 *
 *   module 1    01_what-is-mobile-development_epm      -> 01_
 *   module 3    3. Navigation Between Screens_epm      -> 3.
 *   module 3    mini-project-2-backend-api_epm         -> after the numbered ones
 *   module 11   chapter-3 Markers, Routes_epm          -> chapter-3
 *   module 4    10-drawer-navigation_epm               -> 10-
 *
 * Output is two files in the transcript root:
 *   curriculum.json          the spine: modules, lessons, order, durations
 *   transcript-manifest.json ingestion metadata, regenerated from the spine
 *
 * Usage: npm run curriculum -- transcripts/class-subtitle
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

/**
 * Module display titles, read off the lesson titles inside each folder — the
 * folders themselves are named only "module 7", which is useless in a citation.
 * `order: 0` puts the two bonus lessons before module 1: they are pre-course
 * context and never a prerequisite for anything, so a student sitting at
 * module 1 should not be told they skipped material.
 */
const MODULES = {
  "module 1 hc": { id: "m00", order: 0, title: "Before You Start", bonus: true },
  "module 1": { id: "m01", order: 1, title: "Mobile Development Foundations" },
  "module 2": { id: "m02", order: 2, title: "Core Components & Styling" },
  "module 3": { id: "m03", order: 3, title: "React Navigation" },
  "module 4": { id: "m04", order: 4, title: "Expo Router" },
  "module 5": { id: "m05", order: 5, title: "API Routes & Consuming APIs" },
  "module 6": { id: "m06", order: 6, title: "Local Storage & Persistence" },
  "module 7": { id: "m07", order: 7, title: "Device Sensors" },
  "module 8": { id: "m08", order: 8, title: "Camera, Media & Audio" },
  "module 9": { id: "m09", order: 9, title: "Network, Linking, Haptics & Battery" },
  "module 10": { id: "m10", order: 10, title: "EAS Build & Development Builds" },
  "module 11": { id: "m11", order: 11, title: "Native Maps with Expo Maps" },
  "module 12": { id: "m12", order: 12, title: "Notifications" },
  "module 13": { id: "m13", order: 13, title: "Authentication" },
  "module 14": { id: "m14", order: 14, title: "EAS Workflows, Updates & Publishing" },
  "module 15": { id: "m15", order: 15, title: "Project: Weather App" },
  "module 16": { id: "m16", order: 16, title: "Project: Pixabay Image Explorer" },
  "module 17": { id: "m17", order: 17, title: "Project: AI Story Generator" },
};

/**
 * Lessons inside the bonus folder carry no numbering, and alphabetical order
 * would put the Expo-versions warning before the instructor's introduction.
 */
const BONUS_ORDER = ["Something personal for Mobile development", "Expo Version change so quickly"];

/** Numbered lessons sort first; mini-projects always follow them in module 3. */
const MINI_PROJECT_OFFSET = 100;

async function findVtt(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findVtt(path);
    return extname(entry.name).toLowerCase() === ".vtt" ? [path] : [];
  }));
  return nested.flat();
}

/**
 * Reads the ordering hint out of a lesson filename.
 * Returns the sort key, the unit noun to print in a citation, and the number
 * the course itself uses for that unit.
 */
export function parseUnit(stem) {
  const chapter = stem.match(/^chapter[\s_-]*(\d+)/i);
  if (chapter) return { sort: Number(chapter[1]), kind: "Chapter", number: Number(chapter[1]) };

  const mini = stem.match(/^mini[\s_-]*project[\s_-]*(\d+)/i);
  if (mini) return { sort: MINI_PROJECT_OFFSET + Number(mini[1]), kind: "Mini-project", number: Number(mini[1]) };

  const numbered = stem.match(/^(\d+)\s*[._\-)]/);
  if (numbered) return { sort: Number(numbered[1]), kind: "Lesson", number: Number(numbered[1]) };

  return null;
}

/** Strips the numbering and the `_epm` vendor suffix, leaving something readable. */
export function cleanTitle(stem) {
  return stem
    .replace(/_epm$/i, "")
    .replace(/^chapter[\s_-]*\d+/i, "")
    .replace(/^mini[\s_-]*project[\s_-]*\d+/i, "")
    .replace(/^\d+\s*[._\-)]?/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s.,:;&-]+|[\s.,:;&-]+$/g, "")
    .trim();
}

const CUE = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/g;

/** Duration is the end of the last cue. No video files exist, so this is the only source. */
async function readDuration(file) {
  const text = await readFile(file, "utf8");
  let end = 0;
  for (const match of text.matchAll(CUE)) {
    end = Math.max(end, Number(match[5]) * 3600 + Number(match[6]) * 60 + Number(match[7]) + Number(match[8]) / 1000);
  }
  return Math.round(end);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const pad = (n) => String(n).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
}

export async function buildCurriculum(inputPath) {
  const root = resolve(inputPath);
  const files = (await findVtt(root)).sort();
  if (!files.length) throw new Error(`No .vtt transcripts found under ${root}`);

  const grouped = new Map();
  const unknownModules = new Set();
  for (const file of files) {
    const relativePath = relative(root, file).replaceAll(sep, "/");
    const folder = relativePath.split("/")[0];
    const meta = MODULES[folder];
    if (!meta) { unknownModules.add(folder); continue; }
    const stem = basename(file, extname(file));
    const bonusIndex = BONUS_ORDER.indexOf(stem.replace(/_epm$/i, ""));
    const unit = parseUnit(stem)
      ?? (bonusIndex >= 0 ? { sort: bonusIndex + 1, kind: "Bonus", number: bonusIndex + 1 } : null);
    if (!unit) throw new Error(`Cannot determine lesson order for ${relativePath} — add it to BONUS_ORDER or fix the prefix.`);

    if (!grouped.has(folder)) grouped.set(folder, []);
    grouped.get(folder).push({ file: relativePath, absolute: file, stem, unit, title: cleanTitle(stem) });
  }
  if (unknownModules.size) {
    throw new Error(`Unmapped module folders: ${[...unknownModules].join(", ")}. Add them to MODULES.`);
  }

  const folders = [...grouped.keys()].sort((a, b) => MODULES[a].order - MODULES[b].order);
  const modules = [];
  const lessons = [];
  let order = 0;

  for (const folder of folders) {
    const meta = MODULES[folder];
    const inModule = grouped.get(folder).sort((a, b) => a.unit.sort - b.unit.sort || a.stem.localeCompare(b.stem));
    let moduleSeconds = 0;

    for (const [index, lesson] of inModule.entries()) {
      const position = index + 1;
      const lessonId = `${meta.id}-l${String(position).padStart(2, "0")}`;
      const durationSeconds = await readDuration(lesson.absolute);
      moduleSeconds += durationSeconds;
      order += 1;
      lessons.push({
        lessonId,
        order,
        file: lesson.file,
        title: lesson.title || lesson.stem.replace(/_epm$/i, ""),
        unitKind: lesson.unit.kind,
        unitNumber: lesson.unit.number,
        /** What a citation prints: "Module 11 · Chapter 3". */
        label: meta.bonus ? `${meta.title} · Bonus ${lesson.unit.number}` : `Module ${meta.order} · ${lesson.unit.kind} ${lesson.unit.number}`,
        moduleId: meta.id,
        moduleOrder: meta.order,
        moduleFolder: folder,
        moduleTitle: meta.title,
        lessonInModule: position,
        bonus: Boolean(meta.bonus),
        durationSeconds,
        duration: formatDuration(durationSeconds),
      });
    }

    modules.push({
      id: meta.id, order: meta.order, folder, title: meta.title,
      bonus: Boolean(meta.bonus), lessonCount: inModule.length,
      durationSeconds: moduleSeconds, duration: formatDuration(moduleSeconds),
      firstLessonOrder: order - inModule.length + 1, lastLessonOrder: order,
    });
  }

  const totalSeconds = lessons.reduce((sum, lesson) => sum + lesson.durationSeconds, 0);
  return {
    course: {
      title: "React Native & Expo — Mobile Development",
      generatedAt: new Date().toISOString(),
      moduleCount: modules.length,
      lessonCount: lessons.length,
      durationSeconds: totalSeconds,
      duration: formatDuration(totalSeconds),
      /** No video files exist; every citation resolves to a lesson name plus a timestamp. */
      medium: "transcripts-only",
    },
    modules,
    lessons,
  };
}

/** Ingestion metadata, derived from the spine so the two can never disagree. */
export function manifestFromCurriculum(curriculum) {
  return {
    videos: curriculum.lessons.map((lesson) => ({
      file: lesson.file,
      /** Doubles as `sources.video_id`; the column is generic TEXT. */
      videoId: lesson.lessonId,
      url: "",
      title: lesson.title,
      module: lesson.moduleTitle,
      language: "en",
      lessonOrder: lesson.order,
      moduleOrder: lesson.moduleOrder,
      lessonLabel: lesson.label,
      duration: lesson.durationSeconds,
    })),
  };
}

/* Exports above are imported by the tests; the block below only runs as a CLI. */
if (process.argv[1] && basename(process.argv[1]) === "buildCurriculum.js") {
  const input = process.argv[2] ?? "transcripts/class-subtitle";
  const root = resolve(input);
  const curriculum = await buildCurriculum(root);
  await writeFile(join(root, "curriculum.json"), `${JSON.stringify(curriculum, null, 2)}\n`, "utf8");
  await writeFile(join(root, "transcript-manifest.json"), `${JSON.stringify(manifestFromCurriculum(curriculum), null, 2)}\n`, "utf8");
  console.log(`Curriculum: ${curriculum.course.lessonCount} lessons across ${curriculum.course.moduleCount} modules, ${curriculum.course.duration} total.`);
  for (const module of curriculum.modules) {
    console.log(`  ${String(module.order).padStart(2)} ${module.title.padEnd(38)} ${String(module.lessonCount).padStart(2)} lessons  ${module.duration.padStart(8)}`);
  }
  console.log(`Wrote curriculum.json and transcript-manifest.json to ${root}`);
}
