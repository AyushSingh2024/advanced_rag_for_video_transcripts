import { ingestPath } from "../ingestion/ingest.js";
import { pool } from "../db.js";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npm run ingest -- <file-or-directory> [--force]");
  process.exitCode = 1;
} else {
  try {
    const results = await ingestPath(inputPath, { force: process.argv.includes("--force") });
    console.table(results.map(({ filePath, status, chunks }) => ({ file: filePath, status, chunks })));
    console.log(`Processed ${results.length} supported file(s).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
