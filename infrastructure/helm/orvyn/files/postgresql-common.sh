#!/usr/bin/env bash
# Shared by the PostgreSQL backup and isolated-restore jobs. Never enable xtrace.
set -euo pipefail
umask 077
export LC_ALL=C

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

prepare_backup_directory() {
  directory=${ORVYN_BACKUP_DIRECTORY:-}
  [[ "$directory" == /* && "$directory" != / ]] || fail 'A dedicated absolute backup directory is required.'
  mkdir -p -- "$directory"
  directory=$(cd -- "$directory" && pwd -P)
  [[ "$directory" != / ]] || fail 'The filesystem root cannot be a backup directory.'
  chmod 700 -- "$directory"
}

configure_connection() {
  connection_args=()
  if [[ -n "${DATABASE_URL:-}" ]]; then
    [[ "$DATABASE_URL" == postgres://* || "$DATABASE_URL" == postgresql://* ]] || fail 'Invalid PostgreSQL connection configuration.'
    connection_args=(--dbname="$DATABASE_URL")
  else
    [[ -n "${PGDATABASE:-}" ]] || fail 'PostgreSQL database configuration is required.'
    connection_args=(--dbname="$PGDATABASE")
  fi
  export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"
  export PGAPPNAME=orvyn-database-backup
}

is_orvyn_database() {
  local result
  result=$(psql "${connection_args[@]}" -X --no-password --tuples-only --no-align --set=ON_ERROR_STOP=1 \
    --command="SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.pages') IS NOT NULL AND to_regclass('public.schema_migrations') IS NOT NULL" 2>/dev/null) || return 1
  [[ "$result" == t ]]
}

valid_backup_name() {
  [[ "$1" =~ ^postgresql-[0-9]{8}T[0-9]{15}Z-[A-Za-z0-9]{8}$ ]]
}

verify_backup() {
  local directory=$1 line name
  local -A seen=()
  for name in database.dump metadata SHA256SUMS; do
    [[ -f "$directory/$name" && ! -L "$directory/$name" ]] || return 1
  done
  grep --fixed-strings --line-regexp --quiet 'format=orvyn-postgresql-backup/v1' "$directory/metadata" || return 1
  # Reject extra paths, duplicates and malformed manifests before invoking sha256sum.
  local pattern='^[0-9a-f]{64}  (database.dump|metadata)$'
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ $pattern ]] || return 1
    name=${BASH_REMATCH[1]}
    [[ -z "${seen[$name]:-}" ]] || return 1
    seen[$name]=1
  done < "$directory/SHA256SUMS"
  [[ "${#seen[@]}" == 2 ]] || return 1
  (cd -- "$directory" && sha256sum --check --strict --status SHA256SUMS) || return 1
  pg_restore --list "$directory/database.dump" >/dev/null 2>&1
}
