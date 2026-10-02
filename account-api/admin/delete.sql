-- Delete one account by address, the OPERATOR side (abuse, or an
-- erasure request arriving by mail): revoke every session at once, then
-- stage the account for the SAME purge the in-app deletion uses, due
-- immediately, so the next daily cron (04:00 UTC) erases docs, blobs
-- (the whole R2 prefix) and the user row through the tested sweep.
-- Nothing here destroys data by hand; the sweep is the one shredder.
-- A deletion whose deadline has passed is SEALED: the worker refuses
-- sign-in and restore for it (deletionSealed), so the hours before the
-- cron are not the abuser's to cancel it in.
-- To also stop the address from ever receiving another code, insert its
-- hash into `suppressions` (the recipe in admin/unsuppress.sql shows the
-- hash command; INSERT instead of DELETE).
--
-- Swap the address before running:
-- wrangler d1 execute loxodrome-account --remote --file admin/delete.sql
--
-- Courteous variant (the user-flow's 7-day grace, sign-in cancels):
--   delete_after = (unixepoch() + 7 * 86400) * 1000
-- and leave the sessions row deletion out.
--
-- Verify the day after with admin/lookup.sql: every SELECT empty.
DELETE FROM sessions
WHERE user_id = (SELECT id FROM users WHERE email = 'pilot@example.org');
UPDATE users
SET status = 'pending_delete', delete_after = unixepoch() * 1000
WHERE email = 'pilot@example.org';
