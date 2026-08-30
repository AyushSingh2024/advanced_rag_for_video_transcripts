import { access, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run manifest -- <transcript-directory>");
  process.exit(1);
}

const root = resolve(input);
const output = join(root, "transcript-manifest.json");
try {
  await access(output);
  console.error(`Refusing to overwrite existing manifest: ${output}`);
  process.exit(1);
} catch {}

async function findVtt(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findVtt(path);
    return extname(entry.name).toLowerCase() === ".vtt" ? [path] : [];
  }));
  return nested.flat();
}

const files = (await findVtt(root)).sort();
const videos = files.map((file) => {
  const relativePath = relative(root, file);
  const parts = relativePath.split(sep);
  const rawTitle = basename(file, extname(file)).replace(/_epm$/i, "").replace(/[_-]+/g, " ").trim();
  return {
    file: relativePath.replaceAll(sep, "/"),
    videoId: "",
    url: "",
    title: rawTitle,
    module: parts.length > 1 ? parts[0] : "",
    language: "en",
  };
});
await writeFile(output, `${JSON.stringify({ videos }, null, 2)}\n`, "utf8");
console.log(`Created ${output} with ${videos.length} video entries.`);
console.log("Fill videoId and url for each video before ingestion.");
