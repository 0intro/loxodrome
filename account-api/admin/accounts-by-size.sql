-- The accounts by stored bytes, largest first (the abuse-triage view).
-- wrangler d1 execute loxodrome-account --remote --file admin/accounts-by-size.sql
SELECT id, email, status, bytes_used, created_at, last_seen
FROM users
ORDER BY bytes_used DESC
LIMIT 50;
