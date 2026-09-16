#!/bin/sh
# Upload the elevation mosaic to R2, sending only the tiles whose CONTENT
# changed since the last upload.
#
#   scripts/upload-terrain.sh --out /archive/djc/terrain
#
# Why this is not the per-file loop data-aipdocs.yml uses: that job uploads
# about twenty packs, this one addresses upwards of a million tiles, and one
# `aws s3 cp` per object is a process and a TLS handshake each, which is days.
# So the changed set is staged as HARDLINKS (near free, no copy, no second
# copy of 40 GB on disk) and handed to one recursive upload, which parallelises
# it.
#
# Why not `aws s3 sync` over the whole tree: sync decides by size and
# modification time. The pool pass rewrites coarse tiles every build, so their
# mtime moves while their content does not, and sync would re-upload them all,
# roll every ETag and tell every device an update was waiting for tiles it
# already holds. The receipts are hashes of each tile's PAYLOAD
# (internal/terrain.Payload), which is what makes the comparison a real change
# test: Go's DEFLATE output has changed between toolchain releases, so the
# stored bytes are not the tile's identity.
#
# Needs AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for an R2 token scoped to
# this bucket alone, plus CF_ACCOUNT_ID. Node must be on PATH (see .nvmrc).
set -eu

OUT=local/terrain
BUCKET=${TERRAIN_R2_BUCKET:-loxodrome-terrain}
RECEIPTS=""
UPLOADED=""
DRY=""

while [ $# -gt 0 ]; do
	case "$1" in
	--out) OUT=$2; shift 2 ;;
	--bucket) BUCKET=$2; shift 2 ;;
	--receipts) RECEIPTS=$2; shift 2 ;;
	--uploaded) UPLOADED=$2; shift 2 ;;
	--dry-run) DRY=1; shift ;;
	*) echo "unknown option $1" >&2; exit 2 ;;
	esac
done
[ -n "$RECEIPTS" ] || RECEIPTS="$OUT/receipts.json"
[ -n "$UPLOADED" ] || UPLOADED="$OUT/uploaded.json"

[ -d "$OUT" ] || { echo "no such tile directory: $OUT" >&2; exit 1; }
[ -f "$RECEIPTS" ] || { echo "no receipts at $RECEIPTS (run: cmd/terrain -receipts $RECEIPTS)" >&2; exit 1; }
: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"

# Beside the tile tree, NOT in TMPDIR. The staging is hardlinks, and a hard
# link cannot cross a filesystem: on this machine /tmp is a 63 GB tmpfs and
# the tiles are on a 7 TB array, so the default would fail EXDEV per file,
# fall back to copying, and pull the whole changed set through RAM. The
# fallback is kept for an operator who points --stage somewhere else, but it
# says so rather than doing it silently.
#
# A SIBLING of the output, never inside it: cmd/terrain -receipts walks the
# tile tree for *.terrain, so a stage under $OUT would be hashed as if the
# hardlinks were tiles of their own.
STAGE_PARENT=${TERRAIN_STAGE_DIR:-$(dirname "$OUT")}
STAGE=$(mktemp -d "$STAGE_PARENT/.terrain-upload.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT INT TERM

# The diff, and the staging, in one pass. A key present in the receipts and
# absent from (or different in) the uploaded set is staged; a key that only
# the uploaded set has is reported, because a tile that stopped being built is
# a real event (a bbox shrank, a source was withdrawn) and deleting it from
# the bucket is a decision, never a side effect of an upload.
node -e '
const fs = require("node:fs"), path = require("node:path");
const [receipts, uploaded, out, stage] = process.argv.slice(1);
const now = JSON.parse(fs.readFileSync(receipts, "utf8"));
const then = fs.existsSync(uploaded) ? JSON.parse(fs.readFileSync(uploaded, "utf8")) : {};
let changed = 0, same = 0, copied = 0;
for (const [key, sum] of Object.entries(now)) {
	if (then[key] === sum) { same++; continue; }
	const src = path.join(out, key + ".terrain");
	const dst = path.join(stage, key + ".terrain");
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	try {
		fs.linkSync(src, dst);
	} catch (e) {
		if (e && e.code === "EXDEV") copied++;
		fs.copyFileSync(src, dst);
	}
	changed++;
}
const gone = Object.keys(then).filter((k) => !(k in now));
console.log(`${changed} to upload, ${same} unchanged, ${gone.length} no longer built`);
if (copied) {
	console.log(`WARNING: ${copied} staged by COPY, not hardlink: the stage is on another`);
	console.log("filesystem from the tiles, so this run needs that much free space and time.");
}
if (gone.length) {
	console.log("no longer built (not deleted; remove them deliberately):");
	for (const k of gone.slice(0, 20)) console.log("  " + k);
	if (gone.length > 20) console.log(`  ... and ${gone.length - 20} more`);
}
if (!changed) process.exit(3);
' "$RECEIPTS" "$UPLOADED" "$OUT" "$STAGE" || {
	status=$?
	[ "$status" = 3 ] && { echo "nothing to upload"; exit 0; }
	exit "$status"
}

if [ -n "$DRY" ]; then
	echo "dry run: staged $(find "$STAGE" -name '*.terrain' | wc -l) tiles under $STAGE"
	exit 0
fi

# --checksum-algorithm CRC32: R2 rejects the CRC64NVME the AWS CLI defaults to.
# --content-type: the extension is ours, so nothing would guess it.
aws s3 cp "$STAGE" "s3://$BUCKET" \
	--recursive \
	--endpoint-url "https://$CF_ACCOUNT_ID.r2.cloudflarestorage.com" \
	--content-type application/octet-stream \
	--checksum-algorithm CRC32 \
	--only-show-errors

# Only now, with every changed tile actually in the bucket. A run that dies
# half way leaves the previous receipts in place and re-sends its own work,
# which is wasteful and correct, rather than recording an upload that did not
# happen.
cp "$RECEIPTS" "$UPLOADED"
echo "uploaded; receipts recorded at $UPLOADED"
