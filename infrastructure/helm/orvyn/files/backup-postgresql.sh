#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/postgresql-common.sh"

configure_connection
directory=${ORVYN_BACKUP_DIRECTORY:-}
retention=${ORVYN_BACKUP_RETENTION_COUNT:-7}
[[ "$directory" == /* && "$directory" != / ]] || fail 'A dedicated absolute backup directory is required.'
[[ "$retention" =~ ^[1-9][0-9]{0,2}$ && "$retention" -le 365 ]] || fail 'Backup retention must be between 1 and 365 snapshots.'
mkdir -p -- "$directory"
directory=$(cd -- "$directory" && pwd -P)
[[ "$directory" != / ]] || fail 'The filesystem root cannot be a backup directory.'
chmod 700 -- "$directory"
exec 9>"$directory/.lock"
flock --nonblock 9 || fail 'Another database backup or restore is using this directory.'

pending=
cleanup() {
  local status=$?
  [[ -z "$pending" ]] || rm -rf -- "$pending"
  if (( status != 0 )); then
    printf '%s\n' 'Database backup did not finish successfully. Check connection settings, permissions and available storage.' >&2
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

is_orvyn_database || fail 'Cannot connect to an Orvyn database; check the database credentials, network and TLS configuration.'
stamp=$(date -u +%Y%m%dT%H%M%S%NZ)
pending=$(mktemp -d "$directory/.pending-$stamp.XXXXXXXX")
pg_dump "${connection_args[@]}" --no-password --format=custom --no-owner --no-privileges \
  --file="$pending/database.dump" 2>"$pending/diagnostic.log" || fail 'PostgreSQL dump failed; check connectivity, permissions, client/server versions and free space.'
printf 'format=orvyn-postgresql-backup/v1\ncreated_utc=%s\nclient=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(pg_dump --version)" >"$pending/metadata"
(cd -- "$pending" && sha256sum database.dump metadata >SHA256SUMS)
verify_backup "$pending" || fail 'The new database archive failed verification.'
rm -- "$pending/diagnostic.log"
chmod 600 -- "$pending/database.dump" "$pending/metadata" "$pending/SHA256SUMS"
sync "$pending/database.dump" "$pending/metadata" "$pending/SHA256SUMS" "$pending"
name="postgresql-$stamp-${pending##*.}"
complete="$directory/$name"
[[ ! -e "$complete" ]] || fail 'Refusing to replace an existing database snapshot.'
mv -T -- "$pending" "$complete"
pending=
sync "$directory"

# Only manage complete snapshots created by this tool. Preserve unrelated files,
# symlinks and interrupted directories, and always keep the just-verified snapshot.
snapshots=()
for snapshot in "$directory"/postgresql-*; do
  [[ -d "$snapshot" && ! -L "$snapshot" ]] || continue
  valid_backup_name "${snapshot##*/}" || continue
  [[ -f "$snapshot/metadata" && ! -L "$snapshot/metadata" && -f "$snapshot/database.dump" && -f "$snapshot/SHA256SUMS" ]] || continue
  grep --fixed-strings --line-regexp --quiet 'format=orvyn-postgresql-backup/v1' "$snapshot/metadata" || continue
  snapshots+=("$snapshot")
done
excess=$(( ${#snapshots[@]} - retention ))
for snapshot in "${snapshots[@]}"; do
  (( excess > 0 )) || break
  [[ "$snapshot" != "$complete" ]] || continue
  rm -rf -- "$snapshot"
  excess=$(( excess - 1 ))
done
printf 'Database snapshot completed: %s\n' "$name"
