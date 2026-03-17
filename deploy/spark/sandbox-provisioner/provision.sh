#!/bin/bash
# Auto-provision OpenClaw sandbox for a user
# Called by the provisioner HTTP service when nginx gets a 502
#
# Usage: provision.sh <username>
# Requires: docker socket access, deploy scripts at /deploy

set -e

USERNAME="${1:?Usage: provision.sh <username>}"
DEPLOY_DIR="/deploy"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.openclaw-${USERNAME}.yml"
ENV_FILE="$DEPLOY_DIR/.env.openclaw-${USERNAME}"
CONTAINER_NAME="deploy-openclaw-${USERNAME}-1"

# Wait for the sandbox gateway to be reachable via HTTP
wait_for_gateway() {
    for i in $(seq 1 30); do
        if docker exec "$CONTAINER_NAME" curl -sf http://localhost:18789/healthz >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done
    return 1
}

# Skip if already exists
if [ -f "$COMPOSE_FILE" ]; then
    # Container might be stopped; ensure it's running
    docker compose -f "$DEPLOY_DIR/docker-compose.yml" -f "$COMPOSE_FILE" \
        up -d "openclaw-${USERNAME}" 2>&1
    # Wait for gateway to be ready before returning
    wait_for_gateway
    echo "already_exists"
    exit 0
fi

# Auto-assign SSH port
MAX_PORT=$(grep -rh ':22"' "$DEPLOY_DIR"/docker-compose.openclaw-*.yml 2>/dev/null \
    | grep -oP '\d+(?=:22")' | sort -n | tail -1)
if [ -z "$MAX_PORT" ]; then
    SSH_PORT=2201
else
    SSH_PORT=$((MAX_PORT + 1))
fi

PASSWORD="openclaw-${USERNAME}"
EXEC_TOKEN=$(openssl rand -hex 16)

# S3 bucket
S3_ACCESS_KEY="${S3_ACCESS_KEY:-gbasec0ca799a}"
S3_SECRET_KEY="${S3_SECRET_KEY:-5064d4a9e1d5a5e3}"
S3_ENDPOINT="http://seaweedfs:8333"
BUCKET_NAME="openclaw-${USERNAME}"

docker run --rm --network spark_default \
    -e AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
    -e AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
    amazon/aws-cli --endpoint-url "$S3_ENDPOINT" \
    s3 mb "s3://$BUCKET_NAME" 2>/dev/null || true

# Env file
GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-782a7e872448f75aaa23c6246272bbab6f0a824802cf91f0}"

cat > "$ENV_FILE" << EOF
OPENCLAW_USER=$USERNAME
OPENCLAW_PASSWORD=$PASSWORD
OPENCLAW_API_KEY=$EXEC_TOKEN
ANTHROPIC_API_KEY=
AWS_S3_ENDPOINT_URL=$S3_ENDPOINT
AWS_ACCESS_KEY_ID=$S3_ACCESS_KEY
AWS_SECRET_ACCESS_KEY=$S3_SECRET_KEY
AWS_S3_BUCKET_NAME=$BUCKET_NAME
OPENCLAW_WORKSPACE=/workspace
OPENCLAW_GATEWAY_URL=ws://openclaw-gateway:18789
OPENCLAW_GATEWAY_TOKEN=$GATEWAY_TOKEN
EOF

# Compose file
cat > "$COMPOSE_FILE" << EOF
services:
  openclaw-${USERNAME}:
    image: gbase-openclaw
    restart: always
    env_file: .env.openclaw-${USERNAME}
    ports:
      - "${SSH_PORT}:22"
    expose:
      - "8080"
      - "18789"
    devices:
      - /dev/fuse
    cap_add:
      - SYS_ADMIN
    security_opt:
      - apparmor:unconfined
    volumes:
      - openclaw_${USERNAME}_home:/home/${USERNAME}
      - openclaw_${USERNAME}_workspace:/workspace
      - openclaw_${USERNAME}_state:/root/.openclaw
      - shared_whisper:/whisper-shared:ro
      - ./openclaw/gbase-plugin:/sandbox-env/openclaw/gbase-plugin:ro
    networks:
      - spark_default
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:8080/health || exit 1"]
      interval: 15s
      timeout: 3s
      retries: 5
      start_period: 10s
    deploy:
      resources:
        limits:
          memory: 3G
          cpus: "2"

volumes:
  openclaw_${USERNAME}_home:
  openclaw_${USERNAME}_workspace:
  openclaw_${USERNAME}_state:
  shared_whisper:
    external: true

networks:
  spark_default:
    external: true
EOF

# Start
docker compose -f "$DEPLOY_DIR/docker-compose.yml" -f "$COMPOSE_FILE" \
    up -d "openclaw-${USERNAME}" 2>&1

# Wait for gateway HTTP to be ready
wait_for_gateway

# Auto-approve pairing with central gateway
docker exec spark-openclaw-gateway-1 \
    node /app/openclaw.mjs devices approve --latest 2>&1 || true

# Upgrade scopes to full operator permissions
docker exec spark-openclaw-gateway-1 node -e "
const fs=require('fs');
const f='/root/.openclaw/devices/paired.json';
const d=JSON.parse(fs.readFileSync(f,'utf8'));
const s=['operator.admin','operator.read','operator.write','operator.approvals','operator.pairing'];
let n=0;
for(const v of Object.values(d)){
  if(JSON.stringify(v.scopes)==='[\"operator.read\"]'){
    v.scopes=s;v.approvedScopes=s;
    for(const t of Object.values(v.tokens||{}))t.scopes=s;
    n++;
  }
}
fs.writeFileSync(f,JSON.stringify(d,null,2));
" 2>&1 || true

echo "created:${SSH_PORT}"
