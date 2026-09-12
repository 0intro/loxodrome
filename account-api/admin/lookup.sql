-- One account, whole: swap the address before running.
-- wrangler d1 execute loxodrome-account --remote --file admin/lookup.sql
SELECT * FROM users WHERE email = 'pilot@example.org';
SELECT id, device_name, mode, created_at, last_seen, expires_at
FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = 'pilot@example.org');
SELECT col, COUNT(*) AS docs, SUM(deleted) AS tombstones
FROM docs WHERE user_id = (SELECT id FROM users WHERE email = 'pilot@example.org')
GROUP BY col;
