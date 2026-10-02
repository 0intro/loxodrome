-- The blob LEDGER: one row per stored object, stamped from the ACTUAL
-- body at PUT (and backfilled by the orphan sweep from the R2 listing
-- for objects that predate it), so the quota and the aggregate ceilings
-- count what R2 holds, never the size a pushed ref CLAIMS: a ref may
-- declare any n, and bytes_used used to sum those declarations. A push
-- may reference only hashes the account holds.
CREATE TABLE blobs (
	user_id     TEXT NOT NULL,
	hash        TEXT NOT NULL,
	n           INTEGER NOT NULL,
	uploaded_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, hash)
);

-- The server's own stamp on every doc row: tombstone retention keys on
-- it, never on updated_at, which is a client clock (a device set to
-- 1970 would otherwise purge its own account's tombstones at the next
-- sweep and move every other device's horizon). Rows from before the
-- column keep 0 and fall back to updated_at.
ALTER TABLE docs ADD COLUMN server_at INTEGER NOT NULL DEFAULT 0;
