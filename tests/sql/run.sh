#!/usr/bin/env bash
# Loads all migrations into a fresh scratch DB and runs every tests/sql/*_test.sql.
set -euo pipefail
shopt -s nullglob
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
DB=eecis_test
dropdb --if-exists $DB; createdb $DB
psql -v ON_ERROR_STOP=1 -q -d $DB -f tests/sql/shim_auth.sql
for m in supabase/migrations/*.sql; do
  case "$m" in *webhooks_cron*) continue;; esac   # needs pg_net/pg_cron, cloud only
  psql -v ON_ERROR_STOP=1 -q -d $DB -f "$m"
done
for t in tests/sql/*_test.sql; do
  echo "== $t"; psql -v ON_ERROR_STOP=1 -q -d $DB -f "$t"
done
echo "SQL TESTS PASSED"
