#!/bin/bash
set -e

# Requirement STACK-RS-234: agent container needs LLM_API_KEY from metadata service at startup.
if [ -z "$LLM_API_KEY" ]; then
  echo "[Entrypoint] LLM_API_KEY for agent not found in environment. Attempting to fetch from metadata service..."

  if [ -z "$METADATA_URL" ]; then
    echo "❌ Error: METADATA_URL is not defined. Cannot fetch LLM_API_KEY."
    exit 1
  fi

  if [ -z "$OWNER" ]; then
    echo "❌ Error: OWNER is not defined. Cannot determine which user's LLM_API_KEY to fetch."
    exit 1
  fi

  # Fetch from metadata module
  # URL: GET /user?uid=<OWNER>
  # Expected JSON: [ { "resources": { "llm_api_key": "..." } } ]

  # Use the new Node-based metadata client
  METADATA_CLIENT="node /app/packages/metadata/dist/cli.js"

  METADATA_PATH="/user"
  QUERY="uid=${OWNER}"
  echo "[Entrypoint] Fetching from ${METADATA_URL}${METADATA_PATH}?${QUERY}..."

  # Use curl with retry
  MAX_RETRIES=10
  RETRY_DELAY=2
  COUNT=0

  while [ $COUNT -lt $MAX_RETRIES ]; do
    RESPONSE=$($METADATA_CLIENT GET "$METADATA_PATH" "" "$QUERY" || true)
    if [ -n "$RESPONSE" ] && [ "$RESPONSE" != "[]" ]; then
      break
    fi
    COUNT=$((COUNT + 1))
    echo "Attempt $COUNT failed to fetch metadata. Retrying in ${RETRY_DELAY}s..."
    sleep $RETRY_DELAY
  done

  if [ -z "$RESPONSE" ] || [ "$RESPONSE" == "[]" ]; then
    echo "❌ Error: Failed to fetch metadata for user ${OWNER} from ${METADATA_URL} after $MAX_RETRIES attempts."
    exit 1
  fi

  # Extract apiKey using jq
  API_KEY=$(echo "$RESPONSE" | jq -r '.[0].resources.llm_api_key // empty')

  if [ -z "$API_KEY" ] || [ "$API_KEY" == "null" ]; then
    echo "❌ Error: Metadata service returned no llm_api_key for user ${OWNER}."
    echo "Response: ${RESPONSE}"
    exit 1
  fi

  export LLM_API_KEY="$API_KEY"
  # Also set GEMINI_API_KEY for backward compatibility if needed by some older parts
  export GEMINI_API_KEY="$API_KEY"

  echo "✅ Successfully obtained LLM_API_KEY."
else
  echo "[Entrypoint] LLM_API_KEY is already provided in environment."
fi

# Requirement STACK-RS-244: agent container needs restish and mcporter config from metadata service.
if [ -n "$METADATA_URL" ] && [ -n "$OWNER" ]; then
  echo "[Entrypoint] Fetching tool configurations for user ${OWNER}..."
  METADATA_CLIENT="node /app/packages/metadata/dist/cli.js"

  # 1. Fetch mcporter config
  MCPORTER_CONF_DIR="$HOME/.mcporter"
  mkdir -p "$MCPORTER_CONF_DIR"
  echo "[Entrypoint] Fetching mcporter config..."
  MC_RESPONSE=$($METADATA_CLIENT GET "/mcporter/config" "" "uid=${OWNER}" || echo "{}")
  if [ "$MC_RESPONSE" != "{}" ]; then
    echo "$MC_RESPONSE" | jq '.' >"$MCPORTER_CONF_DIR/mcporter.json"
    chmod 600 "$MCPORTER_CONF_DIR/mcporter.json"
    echo "✅ Created mcporter.json"
  else
    echo "⚠️ Warning: Failed to fetch mcporter config or it's empty."
  fi

  # 2. Fetch restish config
  RESTISH_CONF_DIR="$HOME/.config/restish"
  mkdir -p "$RESTISH_CONF_DIR"
  echo "[Entrypoint] Fetching restish config..."
  # Note: /restish/config returns a full apis.json (v0.20+ format)
  $METADATA_CLIENT GET "/restish/config" "" "uid=${OWNER}" >"$RESTISH_CONF_DIR/apis.json" || echo "⚠️ Warning: Failed to fetch restish config."
  if [ -f "$RESTISH_CONF_DIR/apis.json" ]; then
    chmod 600 "$RESTISH_CONF_DIR/apis.json"
    echo "✅ Created restish apis.json"
  fi
else
  echo "⚠️ Warning: METADATA_URL or OWNER not set, skipping tool configuration."
fi

# Execute the CMD
exec "$@"
