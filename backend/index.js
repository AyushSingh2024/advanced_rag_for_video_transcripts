import { compileGraph } from "./src/graph.js";
import { pool } from "./src/db.js";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error("Usage: npm run ask -- \"<question>\"");
  process.exitCode = 1;
} else {
  try {
    const finalState = await compileGraph().invoke({ originalQuery: query });
    console.log(`\n${finalState.bestAnswer ?? finalState.answer}\n`);
    const citations = finalState.bestCitations?.length ? finalState.bestCitations : finalState.citations;
    if (citations?.length) {
      console.log("Sources:");
      for (const citation of citations) {
        const location = citation.pageNumber ? `page ${citation.pageNumber}` : citation.startTime != null ? `${citation.startTime}s-${citation.endTime ?? "?"}s` : citation.sourcePath ?? "";
        console.log(`[${citation.number}] ${citation.sourceTitle ?? citation.sourceId}${location ? ` — ${location}` : ""}`);
      }
    }
    console.log(`\nQuality: ${finalState.bestScore}/10 · Attempts: ${finalState.attempts}`);
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
