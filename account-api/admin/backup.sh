#!/bin/bash
# Offsite backup of the account service (README, "Backups"): a dated D1
# dump FIRST, then the R2 blob mirror. In that order because a client
# PUTs every blob before the doc that references it, so a dump taken at
# T references only blobs that existed before T, and a mirror taken
# after T holds them all (the GC removes 30-day orphans only, the purge
# runs at 04:00 UTC outside the timer's window). Mirror-first would leave
# a blob uploaded between the halves in the dump and out of the mirror.
# D1 Time Travel (30 days, always on) is the first restore line; this is
# the layer that survives it: dumps kept beyond 30 days, and everything
# off Cloudflare.
#
# One-time setup, documented in the README: `rclone` installed and a
# read-only R2 S3 token configured as the remote `loxodrome-r2` (the
# blob half quietly skips until then; the D1 half always runs).
set -euo pipefail

# The dumps carry every address, every payload and the session digests:
# nothing here may be readable by another user of the machine.
umask 077

export PATH=/opt/node-v24.17.0-linux-x64/bin:$PATH
cd "$(dirname "$0")/.."

BACKUP_DIR="${LOXODROME_BACKUP_DIR:-$HOME/backups/loxodrome-account}"
STAMP=$(date -u +%Y%m%dT%H%MZ)
mkdir -p "$BACKUP_DIR/d1" "$BACKUP_DIR/blobs"
chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/d1" "$BACKUP_DIR/blobs"

# --- database: a full dated dump, gzipped, pruned past 60 days (Time
# Travel covers the recent window; these carry the long tail). A failed
# export must not leave a truncated .sql beside the good dumps: it is
# removed, and the prune runs only after a successful one.
OUT="$BACKUP_DIR/d1/$STAMP.sql"
trap 'rm -f "$OUT"' ERR
npx wrangler@4 d1 export loxodrome-account --remote --output "$OUT" > /dev/null
trap - ERR
gzip -f "$OUT"
find "$BACKUP_DIR/d1" -name '*.sql.gz' -mtime +60 -delete
echo "d1: $OUT.gz ($(wc -c < "$OUT.gz") bytes, $(ls "$BACKUP_DIR/d1" | wc -l) kept)"

# --- blobs: mirror the bucket (content-addressed and immutable, so the
# sync is incremental by nature; GC-deleted orphans age out of the
# mirror on the next run).
if command -v rclone > /dev/null && rclone listremotes 2> /dev/null | grep -q '^loxodrome-r2:'; then
	rclone sync loxodrome-r2:loxodrome-account-blobs "$BACKUP_DIR/blobs" --transfers 8 --quiet
	echo "blobs: mirrored ($(du -sh "$BACKUP_DIR/blobs" | cut -f1))"
else
	echo "blobs: SKIPPED (no rclone remote 'loxodrome-r2'; see README, Backups)" >&2
fi
