import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { pool } from "./db.js";
import { createApp } from "./app.js";

export function startServer() {
  const server = createApp().listen(config.port, () => console.log(`Advanced RAG API listening on http://localhost:${config.port}`));
  async function shutdown() {
    server.close(async () => { await pool.end(); process.exit(0); });
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
