-- Accounts created in the last 7 days.
-- wrangler d1 execute loxodrome-account --remote --file admin/signups-week.sql
SELECT id, email, created_at
FROM users
WHERE created_at > (unixepoch() - 7 * 86400) * 1000
ORDER BY created_at DESC;
