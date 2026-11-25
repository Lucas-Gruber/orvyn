#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/postgresql-common.sh"

prepare_backup_directory
probe=$(mktemp -d "$directory/.probe.XXXXXXXX")
trap 'rm -rf -- "$probe"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
exec 9>"$probe/lock"
flock --nonblock 9 || fail 'The backup volume does not support advisory locking.'
mkdir -- "$probe/pending"
printf '%s\n' 'Orvyn backup volume probe' >"$probe/pending/check"
mv -T -- "$probe/pending" "$probe/complete"
sync "$probe/complete/check" "$probe/complete" "$probe"
printf '%s\n' 'Backup volume initialized. No database snapshot was created.'
