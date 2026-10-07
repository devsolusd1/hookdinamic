# The agent and the keeper in one container, with their records served over HTTP.
#
# Nothing secret goes into the image. Keys and addresses come from the environment when the
# container starts (see the top of scripts/serve.ts), and everything the service keeps lives
# on a volume the host mounts at /data. There is no VOLUME line on purpose: Railway refuses a
# Dockerfile that has one and wants the volume made on its side.
FROM node:24-bookworm-slim

WORKDIR /app

# The versions in package-lock.json, nothing newer. tsx, which runs the TypeScript as it is,
# is a development dependency, so those are installed too.
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

# Only what the service runs: no site, no programs, no launch or guardian scripts, no .env, no .local.
COPY tsconfig.json ./
COPY src ./src
COPY scripts/serve.ts ./scripts/serve.ts
COPY agent ./agent
# The catalogue and the rule language, which the agent shares with the site.
COPY site/hooks.js site/rules.js ./site/

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
RUN mkdir -p /data
EXPOSE 8080

# For a plain `docker run` on a server of one's own, where it only marks the container as
# unhealthy for whoever looks. Railway does not read this line. It asks "/" once, when a deploy
# starts (railway.json), to learn that the new copy is up: /health answers 503 the moment a
# loop cannot do its work, and a deploy that failed on that would take down a copy that still
# serves the records and says what is wrong.
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# The process stays root: hosts mount their volume as root, and another user could not write
# to it. node is started directly, not through npm, so that the host's signal to stop reaches
# it and each loop can finish the step it is on.
CMD ["node", "--import", "tsx", "scripts/serve.ts"]
