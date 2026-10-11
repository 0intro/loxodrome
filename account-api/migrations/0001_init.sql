-- The account + sync schema (docs/accounts-sync.md, "The backend", plus
-- the validated additions: orphans is the blob-GC grace clock, since the
-- docs table only ever holds CURRENT references; suppressions protects
-- the sender reputation; the login_codes window counters carry the
-- per-address caps; horizon_seq is what turns a tombstone purge into a
-- client-visible reset marker).

CREATE TABLE users (
	id           TEXT PRIMARY KEY,
	email        TEXT NOT NULL UNIQUE,
	created_at   INTEGER NOT NULL,
	change_seq   INTEGER NOT NULL DEFAULT 0,
	status       TEXT NOT NULL DEFAULT 'active',
	delete_after INTEGER,
	bytes_used   INTEGER NOT NULL DEFAULT 0,
	horizon_seq  INTEGER NOT NULL DEFAULT 0,
	last_seen    INTEGER
);

CREATE TABLE sessions (
	id          TEXT PRIMARY KEY,
	user_id     TEXT NOT NULL,
	token_hash  TEXT NOT NULL UNIQUE,
	device_name TEXT NOT NULL,
	mode        TEXT NOT NULL,
	created_at  INTEGER NOT NULL,
	last_seen   INTEGER NOT NULL,
	expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_by_user ON sessions (user_id);

CREATE TABLE login_codes (
	email_hash   TEXT PRIMARY KEY,
	code_hash    TEXT NOT NULL,
	expires_at   INTEGER NOT NULL,
	attempts     INTEGER NOT NULL DEFAULT 0,
	requested_at INTEGER NOT NULL,
	hour_start   INTEGER NOT NULL,
	hour_count   INTEGER NOT NULL DEFAULT 1,
	day_start    INTEGER NOT NULL,
	day_count    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE suppressions (
	email_hash TEXT PRIMARY KEY,
	at         INTEGER NOT NULL,
	reason     TEXT NOT NULL
);

CREATE TABLE docs (
	user_id      TEXT NOT NULL,
	col          TEXT NOT NULL,
	doc_id       TEXT NOT NULL,
	rev          INTEGER NOT NULL,
	seq          INTEGER NOT NULL,
	deleted      INTEGER NOT NULL DEFAULT 0,
	updated_at   INTEGER NOT NULL,
	device_id    TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	meta_json    TEXT NOT NULL,
	payload      BLOB,
	blob_refs    TEXT,
	PRIMARY KEY (user_id, col, doc_id)
);
CREATE INDEX docs_by_seq ON docs (user_id, seq);

CREATE TABLE orphans (
	user_id     TEXT NOT NULL,
	hash        TEXT NOT NULL,
	orphaned_at INTEGER NOT NULL,
	-- The stored size, stamped at blob PUT: uploads count against the
	-- quota and the ceilings from the moment they land, or an
	-- authenticated client could park unreferenced bytes in R2 free for
	-- the whole grace window.
	n           INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (user_id, hash)
);
