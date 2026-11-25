#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/postgresql-common.sh"

configure_connection
directory=${ORVYN_BACKUP_DIRECTORY:-}
name=${ORVYN_RESTORE_BACKUP:-}
target=${ORVYN_RESTORE_DATABASE:-}
[[ "$directory" == /* && "$directory" != / && -d "$directory" ]] || fail 'An existing dedicated backup directory is required.'
valid_backup_name "$name" || fail 'Select an exact completed database snapshot name.'
[[ "$target" =~ ^orvyn_restore_[a-z0-9_]+$ && ${#target} -le 63 ]] || fail 'Restore requires a new database named orvyn_restore_<name> (at most 63 characters).'
directory=$(cd -- "$directory" && pwd -P)
[[ "$directory" != / && -d "$directory/$name" && ! -L "$directory/$name" ]] || fail 'The selected snapshot directory is unavailable.'
# Share the backup lock to prevent retention removing the selected archive.
# Keep the PVC writable for the lock (including NFS exclusive-lock semantics).
[[ -f "$directory/.lock" && ! -L "$directory/.lock" ]] || fail 'The backup directory lock is unavailable.'
exec 9<>"$directory/.lock"
flock --nonblock --exclusive 9 || fail 'Another database backup or restore is using this directory.'
verify_backup "$directory/$name" || fail 'Snapshot integrity verification failed; no database was created.'

maintenance_args=("${connection_args[@]}")
created=false
successful=false
temporary=$(mktemp -d)
cleanup() {
  local status=$?
  if [[ "$created" == true && "$successful" != true ]]; then
    if ! psql "${maintenance_args[@]}" -X --no-password --quiet --set=ON_ERROR_STOP=1 \
      --command="DROP DATABASE $target WITH (FORCE)" >/dev/null 2>&1; then
      printf 'Could not remove incomplete restore database: %s\n' "$target" >&2
    fi
  fi
  rm -rf -- "$temporary"
  if (( status != 0 )); then
    printf '%s\n' 'Database restore failed. No pre-existing database was replaced.' >&2
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

psql "${maintenance_args[@]}" -X --no-password --quiet --set=ON_ERROR_STOP=1 --command="CREATE DATABASE $target" \
  >/dev/null 2>"$temporary/diagnostic.log" || fail 'Cannot create a fresh restore database. Existing targets are refused; CREATEDB permission is required.'
created=true
if [[ -n "${DATABASE_URL:-}" ]]; then
  if [[ "$DATABASE_URL" == *'?'* ]]; then separator='&'; else separator='?'; fi
  connection_args=(--dbname="${DATABASE_URL}${separator}dbname=$target")
else
  connection_args=(--dbname="$target")
fi
actual=$(psql "${connection_args[@]}" -X --no-password --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --command='SELECT current_database()' 2>"$temporary/diagnostic.log")
[[ "$actual" == "$target" ]] || fail 'The restore connection did not select the new database.'
pg_restore "${connection_args[@]}" --no-password --no-owner --no-privileges \
  --single-transaction --exit-on-error "$directory/$name/database.dump" \
  >/dev/null 2>"$temporary/diagnostic.log" || fail 'PostgreSQL could not restore the selected archive.'
is_orvyn_database || fail 'The restored database does not contain the required Orvyn tables.'
successful=true
printf 'Restored snapshot into new database: %s\n' "$target"
