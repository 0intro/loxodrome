-- The aggregate ceilings' headroom (the number the weekly report tracks:
-- exceeding a free-tier ceiling is the failure that starts costing money
-- quietly).
-- wrangler d1 execute loxodrome-account --remote --file admin/storage-totals.sql
SELECT COUNT(*) AS accounts,
	SUM(bytes_used) AS bytes_stored,
	SUM(CASE WHEN last_seen > (unixepoch() - 7 * 86400) * 1000 THEN 1 ELSE 0 END) AS active_7d
FROM users;
