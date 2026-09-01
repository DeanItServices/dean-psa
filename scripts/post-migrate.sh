#!/usr/bin/env bash
# Applies the partial/filtered unique index that Prisma's schema DSL cannot
# express: one active (endedAt IS NULL) TimeEntry per user at a time.
#
# `prisma migrate deploy` (the standard production/CI/fresh-clone deploy
# workflow) replays only the plain SQL statements Prisma itself generated
# into each migration.sql -- it does NOT special-case hand-appended raw SQL
# comments. The CREATE UNIQUE INDEX statement documented at the bottom of
# prisma/migrations/20260901020532_add_time_tracking_billing/migration.sql
# was applied to the Phase 4 dev database directly via `docker compose exec
# db psql` (see 04-01-SUMMARY.md), so any environment provisioned purely via
# `prisma migrate deploy` -- staging, production, CI, a fresh clone -- would
# silently lack this concurrency guard even though migrate status reports
# "up to date".
#
# This script re-applies that index idempotently (IF NOT EXISTS) after
# `prisma migrate deploy` runs, so the guard is present in every environment
# regardless of how the dev database happened to get it historically. It is
# safe to run repeatedly and safe to run against a database that already has
# the index.
#
# Requires DATABASE_URL to be set (same variable Prisma itself reads).
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "post-migrate.sh: DATABASE_URL is not set; skipping partial-index creation." >&2
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  'CREATE UNIQUE INDEX IF NOT EXISTS "TimeEntry_one_active_timer_per_user" ON "TimeEntry" ("userId") WHERE "endedAt" IS NULL;'

echo "post-migrate.sh: TimeEntry_one_active_timer_per_user partial unique index verified/created."
