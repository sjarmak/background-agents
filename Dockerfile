FROM node:22-slim

# Install Claude Code CLI (needed for Agent SDK)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY tsconfig.json ./
COPY src/ ./src/
COPY invariants.json ./

RUN npx tsc

# Default: run as long-lived server (Slack bot + scheduled scans)
# Override with --mode=cli for one-shot verification
ENV MODE=server
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--mode=server"]
