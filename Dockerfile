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

# Copy workspace configuration
COPY package.json package-lock.json ./
COPY packages/ai/package.json ./packages/ai/
COPY packages/agent/package.json ./packages/agent/
COPY packages/coding-agent/package.json ./packages/coding-agent/
COPY packages/worker/package.json ./packages/worker/
COPY packages/mom/package.json ./packages/mom/
COPY packages/pods/package.json ./packages/pods/
COPY packages/tui/package.json ./packages/tui/
COPY packages/web-ui/package.json ./packages/web-ui/

# Install dependencies (using clean-install for reliable builds)
RUN npm ci

# Copy all source
COPY . .

# Build all packages
RUN npm run build

# Runtime stage
FROM node:20-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    curl \
    jq \
    ca-certificates \
    gnupg \
    lsb-release \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y docker-ce-cli \
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

# Default environment variables
ENV REDIS_HOST=host.docker.internal
ENV REDIS_PORT=6379
ENV REDIS_INPUT_QUEUE=agent_tasks
ENV REDIS_OUTPUT_QUEUE=agent_results
ENV REDIS_CONTROL_CHANNEL=agent_control
ENV GEMINI_API_KEY=""
ENV PI-STATE-DIR=/home/pi-mono/.pi
ENV PI-WORKSPACE-DIR=/home/pi-mono/.pi/agent/workspace

# Create the expected workspace directory for the worker using pi-mono user
RUN mkdir -p /home/pi-mono/.pi/agent/workspace && \
    chown -R pi-mono:pi-mono /home/pi-mono/.pi

VOLUME ["/home/pi-mono/.pi"]

USER pi-mono

# Use the worker's start script
CMD ["npm", "run", "start", "-w", "@mariozechner/pi-worker"]
