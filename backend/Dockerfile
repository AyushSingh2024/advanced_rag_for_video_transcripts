FROM node:22-alpine

ENV NODE_ENV=production

# The build context is the repository root, not this directory, because the page
# the server has to serve lives in the sibling `frontend/`. A context of
# ./backend cannot reach ../frontend at all — Docker refuses to COPY above the
# context — so compose sets `context: .` and points here with `dockerfile:`.
# Every path below is therefore relative to the repo root.
#
# The image reproduces the repo's two-directory shape rather than flattening it,
# so `../../frontend/public` in src/app.js resolves the same way in the container
# as it does on a laptop. One layout, one code path, one thing to reason about.
WORKDIR /app/backend

# Dependencies first, so a source change does not reinstall them. `npm ci`
# installs exactly what package-lock.json pins — important here, because
# package.json declares every dependency as "latest".
COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY backend/ ./

# The study app: a single self-contained HTML file, no build step.
COPY frontend/public /app/frontend/public

# Drop root. The node image ships an unprivileged `node` user, and nothing here
# writes to disk at runtime.
USER node

EXPOSE 3000

# /health returns 503 while Postgres or Qdrant is unreachable, so this reports
# unhealthy until the stores the server actually depends on are answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start:render"]
