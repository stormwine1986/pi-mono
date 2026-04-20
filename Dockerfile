# Build stage
FROM node:20-slim AS builder

WORKDIR /app

# Setup build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set npm mirror
RUN npm config set registry https://registry.npmmirror.com/

# Copy workspace configuration
COPY package.json package-lock.json ./
COPY packages/ai/package.json ./packages/ai/
COPY packages/agent/package.json ./packages/agent/
COPY packages/coding-agent/package.json ./packages/coding-agent/
COPY packages/worker/package.json ./packages/worker/
COPY packages/tui/package.json ./packages/tui/

# Install dependencies
RUN npm ci

# Copy all source (filtered by .dockerignore)
COPY . .

# Build necessary packages in order
RUN npm run build -w @mariozechner/pi-tui && \
    npm run build -w @mariozechner/pi-ai && \
    npm run build -w @mariozechner/pi-agent-core && \
    npm run build -w @mariozechner/pi-coding-agent && \
    npm run build -w @mariozechner/pi-worker && \
    ln -s /app/packages/coding-agent/dist/cli.js /app/node_modules/.bin/pi

# Runtime stage
FROM node:20-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    ca-certificates \
    && curl -sLf "https://github.com/rest-sh/restish/releases/download/v0.21.2/restish-0.21.2-linux-amd64.tar.gz" | tar -xz -C /usr/local/bin restish \
    && npm install -g mcporter \
    && rm -rf /var/lib/apt/lists/*

# Create pi-mono user and group (handle case where 1000 already exists)
RUN if ! getent group pi-mono >/dev/null; then \
        if getent group 1000 >/dev/null; then \
            groupmod -n pi-mono $(getent group 1000 | cut -d: -f1); \
        else \
            groupadd -g 1000 pi-mono; \
        fi; \
    fi && \
    if ! getent passwd pi-mono >/dev/null; then \
        if getent passwd 1000 >/dev/null; then \
            usermod -l pi-mono -m -d /home/pi-mono $(getent passwd 1000 | cut -d: -f1); \
        else \
            useradd -u 1000 -g pi-mono -m -s /bin/bash pi-mono; \
        fi; \
    fi

WORKDIR /app

# Copy built monorepo and set ownership
COPY --from=builder --chown=pi-mono:pi-mono /app /app

# Install cli tools from /app/cli to /usr/local/bin
RUN chmod +x /app/cli/* && \
    cp /app/cli/* /usr/local/bin/

# Default environment variables
ENV REDIS_URL=redis://localhost:6379
ENV GEMINI_API_KEY=""
ENV PI-STATE-DIR=/home/pi-mono/.pi
ENV PI-WORKSPACE-DIR=/home/pi-mono/.pi/agent/workspace
ENV PATH="/home/pi-mono/.pi/agent/bin:/app/node_modules/.bin:${PATH}"

# Copy default settings and models to the agent directory
RUN mkdir -p /home/pi-mono/.pi/agent/workspace && \
    cp /app/packages/settings/* /home/pi-mono/.pi/agent/ && \
    chown -R pi-mono:pi-mono /home/pi-mono/.pi


USER pi-mono

# Use the worker's start script
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["npm", "run", "start", "-w", "@mariozechner/pi-worker"]
