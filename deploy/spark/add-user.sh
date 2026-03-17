#!/bin/bash
# 添加/删除 OpenClaw 沙箱用户
# 用法:
#   ./add-user.sh alice                              # 创建沙箱 (自动分配端口)
#   ./add-user.sh alice --api-key sk-ant-xxx         # 带 Claude API Key
#   ./add-user.sh alice --password mypass             # 自定义 SSH 密码
#   ./add-user.sh alice --port 2205                   # 指定 SSH 端口
#   ./add-user.sh alice --remove                      # 移除沙箱

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
USERNAME="${1:?Usage: $0 <username> [--api-key KEY] [--password PASS] [--port PORT] [--remove]}"
SSH_PORT=0
PASSWORD=""
API_KEY=""
REMOVE=false

shift
while [ $# -gt 0 ]; do
    case "$1" in
        --api-key)   API_KEY="$2"; shift 2 ;;
        --password)  PASSWORD="$2"; shift 2 ;;
        --port)      SSH_PORT="$2"; shift 2 ;;
        --remove)    REMOVE=true; shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

COMPOSE_FILE="$SCRIPT_DIR/docker-compose.openclaw-${USERNAME}.yml"
ENV_FILE="$SCRIPT_DIR/.env.openclaw-${USERNAME}"
BUCKET_NAME="openclaw-${USERNAME}"

# ─── 删除 ───
if [ "$REMOVE" = true ]; then
    echo "Removing OpenClaw sandbox: $USERNAME"
    if [ -f "$COMPOSE_FILE" ]; then
        docker compose -f "$SCRIPT_DIR/docker-compose.yml" -f "$COMPOSE_FILE" \
            down "openclaw-${USERNAME}" 2>/dev/null || true
        rm -f "$COMPOSE_FILE" "$ENV_FILE"
        echo "Sandbox removed (workspace volume and MinIO data preserved)"
    else
        echo "Not found: $COMPOSE_FILE"
    fi
    exit 0
fi

# ─── 自动分配端口 ───
if [ "$SSH_PORT" -eq 0 ]; then
    MAX_PORT=$(grep -rh ':22"' "$SCRIPT_DIR"/docker-compose.openclaw-*.yml 2>/dev/null \
        | grep -oP '\d+(?=:22")' | sort -n | tail -1)
    if [ -z "$MAX_PORT" ]; then
        SSH_PORT=2201
    else
        SSH_PORT=$((MAX_PORT + 1))
    fi
fi

[ -z "$PASSWORD" ] && PASSWORD="openclaw-${USERNAME}"

# Generate exec token for workflow HTTP API
EXEC_TOKEN=$(openssl rand -hex 16)

echo "=== Creating OpenClaw sandbox: $USERNAME ==="
echo "  SSH Port:   $SSH_PORT"
echo "  Password:   $PASSWORD"
echo "  Bucket:     $BUCKET_NAME"
echo "  Exec Token: ${EXEC_TOKEN:0:8}..."
[ -n "$API_KEY" ] && echo "  API Key:    ${API_KEY:0:15}..."

# ─── S3 bucket (SeaweedFS) ───
S3_ACCESS_KEY="${S3_ACCESS_KEY:-gbasec0ca799a}"
S3_SECRET_KEY="${S3_SECRET_KEY:-5064d4a9e1d5a5e3}"
S3_ENDPOINT="http://seaweedfs:8333"

echo "Creating S3 bucket: $BUCKET_NAME..."
docker run --rm --network spark_default \
    -e AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
    -e AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
    amazon/aws-cli --endpoint-url "$S3_ENDPOINT" \
    s3 mb "s3://$BUCKET_NAME" 2>/dev/null || true

# Also ensure 'shared' bucket exists for public resources
docker run --rm --network spark_default \
    -e AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
    -e AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
    amazon/aws-cli --endpoint-url "$S3_ENDPOINT" \
    s3 mb "s3://shared" 2>/dev/null || true

# ─── Env file ───
GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-782a7e872448f75aaa23c6246272bbab6f0a824802cf91f0}"

cat > "$ENV_FILE" << EOF
OPENCLAW_USER=$USERNAME
OPENCLAW_PASSWORD=$PASSWORD
OPENCLAW_API_KEY=$EXEC_TOKEN
ANTHROPIC_API_KEY=$API_KEY
AWS_S3_ENDPOINT_URL=$S3_ENDPOINT
AWS_ACCESS_KEY_ID=$S3_ACCESS_KEY
AWS_SECRET_ACCESS_KEY=$S3_SECRET_KEY
AWS_S3_BUCKET_NAME=$BUCKET_NAME
OPENCLAW_WORKSPACE=/workspace
OPENCLAW_GATEWAY_URL=ws://openclaw-gateway:18789
OPENCLAW_GATEWAY_TOKEN=$GATEWAY_TOKEN
EOF

# ─── Docker compose ───
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

# ─── 启动 ───
echo "Starting sandbox..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" -f "$COMPOSE_FILE" \
    up -d "openclaw-${USERNAME}" 2>&1

# ─── Auto-pair with Gateway ───
echo "Waiting for sandbox to start and auto-onboard..."
CONTAINER_NAME="spark-openclaw-${USERNAME}-1"
for i in $(seq 1 15); do
    if docker exec "$CONTAINER_NAME" test -f /root/.openclaw/openclaw.json 2>/dev/null; then
        echo "  Onboard config detected, approving pairing..."
        sleep 2
        docker exec spark-openclaw-gateway-1 \
            node /app/openclaw.mjs devices approve --latest 2>&1 && \
            echo "  ✓ Gateway pairing approved for $USERNAME" || \
            echo "  ⚠ No pending pairing request (may already be paired)"

        # Fix scopes: approve defaults to operator.read only, agent needs full scopes
        echo "  Upgrading device scopes to full operator permissions..."
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
console.log('  ✓ Device scopes upgraded ('+n+' fixed)');
" 2>&1
        break
    fi
    echo "  Waiting... ($i/15)"
    sleep 2
done

echo ""
echo "=== OpenClaw sandbox ready: $USERNAME ==="
echo ""
echo "  SSH:        ssh ${USERNAME}@<SPARK_IP> -p ${SSH_PORT}"
echo "  Password:   ${PASSWORD}"
echo "  Exec API:   http://openclaw-${USERNAME}:8080/exec (Docker internal)"
echo "  Exec Token: ${EXEC_TOKEN}"
echo ""
echo "  Inside the sandbox:"
echo "    openclaw status                # Check Gateway connection"
echo "    openclaw agent --agent main -m \"hello\"  # Talk to AI"
echo "    openclaw tui                   # Interactive chat UI"
echo "    claude                         # Start Claude Code"
echo ""
if [ -z "$API_KEY" ]; then
    echo "  ⚠ No API key set. Configure later:"
    echo "    Edit $ENV_FILE"
    echo "    Add: ANTHROPIC_API_KEY=sk-ant-xxx"
    echo "    Then: docker compose -f docker-compose.yml -f $COMPOSE_FILE restart openclaw-${USERNAME}"
fi
