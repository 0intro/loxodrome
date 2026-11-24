-- Suspend (or reinstate) one account by address: every authenticated
-- call then answers 403 with the suspended code. Swap the address and
-- the status before running.
-- wrangler d1 execute loxodrome-account --remote --file admin/suspend.sql
UPDATE users SET status = 'suspended' WHERE email = 'pilot@example.org';
-- Reinstate: UPDATE users SET status = 'active' WHERE email = '...';
