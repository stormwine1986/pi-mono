# @mariozechner/pi-metadata-client

Node.js client library and CLI for the Pi Mono Stack Metadata Service.

## Features

- **Unified Client**: A single class to interact with Metadata REST APIs.
- **Auto-Auth**: Automatically handles HS256 JWT signing using `SESSION_SECRET` as required by STACK-RS-247.
- **Node.js CLI**: A command-line tool to fetch metadata from shell scripts (used in container entrypoints).
- **TypeScript Support**: Full type definitions for metadata responses and audit models.

## Installation

```bash
npm install @mariozechner/pi-metadata-client
```

## CLI Usage

The CLI has replaced the legacy `metadata-client.sh` in the pi-mono environment.

```bash
# Fetch user info
node dist/cli.js GET /user '' 'uid=7722403902'

# Fetch MCP config
node dist/cli.js GET /mcporter/config '' 'uid=7722403902'
```

## API Usage

```typescript
import { metadataClient } from "@mariozechner/pi-metadata-client";

// Get user resources
const users = await metadataClient.getUserConfig("architect");
const llmKey = users[0].resources.llm_api_key;

// Post an audit log
await metadataClient.postAudit("tasks", {
  id: "task-123",
  user_id: "7722403902",
  status: "success",
  // ...
});
```

## Environment Variables

The client requires the following environment variables:

- `METADATA_URL`: Base URL of the Metadata service (default: `http://metadata:21001`).
- `OWNER`: The user ID for authentication.
- `SESSION_SECRET`: The HMAC secret for JWT signing.
- `X_REQUEST_ALIAS`: The network alias of the calling container.
