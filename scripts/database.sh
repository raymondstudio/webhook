#!/usr/bin/env bash
set -euo pipefail
name=webhook-failure-lab-postgres
image='postgres:17@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe'
case "${1:-up}" in
  up)
    if docker container inspect "$name" >/dev/null 2>&1; then
      owner=$(docker inspect --format '{{index .Config.Labels "dev.webhook-lab.owner"}}' "$name")
      [ "$owner" = 'webhook-failure-lab' ] || { echo 'Refusing unrelated container name collision.' >&2; exit 1; }
      docker start "$name" >/dev/null
    else
      docker run -d --name "$name" --label dev.webhook-lab.owner=webhook-failure-lab \
        -e POSTGRES_USER=lab -e POSTGRES_PASSWORD=lab -e POSTGRES_DB=lab \
        -p 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql/data "$image" >/dev/null
    fi
    for ((i=0;i<60;i++)); do
      if docker exec "$name" pg_isready -U lab -d lab >/dev/null 2>&1; then
        echo 'Disposable PostgreSQL ready on 127.0.0.1:55432 (database/user/password: lab).'
        exit 0
      fi
      sleep 0.5
    done
    echo 'PostgreSQL failed readiness within 30 seconds.' >&2; exit 1
    ;;
  down)
    if docker container inspect "$name" >/dev/null 2>&1; then
      owner=$(docker inspect --format '{{index .Config.Labels "dev.webhook-lab.owner"}}' "$name")
      [ "$owner" = 'webhook-failure-lab' ] || { echo 'Refusing unrelated container.' >&2; exit 1; }
      docker rm -f "$name" >/dev/null
    fi
    ;;
  *) echo 'Usage: bash scripts/database.sh up|down' >&2; exit 2 ;;
esac
