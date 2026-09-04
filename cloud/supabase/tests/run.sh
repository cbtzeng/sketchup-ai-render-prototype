#!/usr/bin/env bash
# 在一個拋棄式 postgres 容器內套用 001_init.sql 並跑行為驗證。
# 需要 docker。CI 上請改用 `supabase db reset`。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER=architech-pgverify
IMAGE="${PG_IMAGE:-postgres:17-alpine}"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=verify "$IMAGE" >/dev/null
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 0.5
done

docker cp "$HERE/_auth_stub.sql"            "$CONTAINER:/tmp/00.sql" >/dev/null
docker cp "$HERE/../migrations/001_init.sql" "$CONTAINER:/tmp/01.sql" >/dev/null
docker cp "$HERE/001_init.verify.sql"        "$CONTAINER:/tmp/02.sql" >/dev/null

docker exec "$CONTAINER" psql -U postgres -d verify -v ON_ERROR_STOP=1 -q -f /tmp/00.sql
docker exec "$CONTAINER" psql -U postgres -d verify -v ON_ERROR_STOP=1 -q -f /tmp/01.sql
echo "migration 套用成功"
docker exec "$CONTAINER" psql -U postgres -d verify -f /tmp/02.sql
