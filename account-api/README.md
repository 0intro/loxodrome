# account-api

The Loxodrome account + sync Worker: e-mail one-time-code auth, opaque
bearer sessions, and a content-opaque document replicator over D1 + R2,
with staged account deletion and one daily cron running the four sweeps
(staged purges, blob GC with its 30-day grace, code/session expiry,
bytes_used drift) plus the Monday report e-mail.

A separate Worker from `notam-proxy/` on purpose: the proxy is an
anonymous relay holding one upstream credential; this one is
authenticated and stateful. Separate secrets, separate origin
allow-list, separate blast radius.

## Layout

```
worker.ts             the whole worker (TypeScript, zero dependencies)
wrangler.toml         config; bindings + [vars]; the deploy notes
migrations/*.sql      the D1 schema (wrangler d1 migrations apply)
admin/*.sql           the operator queries (wrangler d1 execute --file)
test/                 zero-dependency node:test suite; the D1 binding
                      is a small adapter over node:sqlite, R2 a Map
```

## Tests

```sh
node --test "account-api/test/*.test.ts"   # from the repo root
npm run test:api                            # the same
npm run check:api                           # tsc over worker + tests
```

No packages, no network: Node 24 runs the TypeScript directly and
`node:sqlite` stands in for D1 (the adapter enforces D1's stricter
bind-count contract, which node:sqlite alone does not).

## Local dev

```sh
cd account-api
{
	printf 'DEV_CODE=000000\n'
	printf 'ALLOW_ORIGINS=https://loxodrome.fr,https://localhost,http://localhost:5173,http://127.0.0.1:5173\n'
} > .dev.vars
npx wrangler@4 d1 migrations apply loxodrome-account --local
npx wrangler@4 dev      # port 8788 ([dev] in wrangler.toml)
```

`DEV_CODE` fixes every login code to 000000 and bypasses the Turnstile
siteverify; the send seam short-circuits before touching the EMAIL
binding, so nothing e-mail-side is needed locally. The `.dev.vars`
ALLOW_ORIGINS overlay admits the vite dev origins, which the shipped
`[vars]` list deliberately does not. A plain `npm run dev` SPA reaches
this worker automatically: dev builds default the API base to
`/__account`, which vite proxies to localhost:8788 (vite.config.ts; the
proxy strips Origin, landing in the worker's non-browser allowance).
`VITE_ACCOUNT_API_URL` and the `loxodrome:account-api` localStorage
override remain for pointing anywhere else. Sign out before switching
between `dev` and `dev:live`: both run at the same origin, so a
production bearer left in localStorage is sent to the local worker,
which answers 401 and the app marks the (still valid) session expired.

`npm run dev:live` retargets that same proxy at the PRODUCTION service:
real accounts, the real Turnstile widget (the public sitekey ships as
the live-mode dev default), real e-mailed codes, no local worker
needed; the Origin strip is what admits the proxy without any CORS
entry. Use it to reproduce real-account issues from a dev tab, and
remember what it means: work-in-progress replicator code running
against real data, so prefer read-side debugging or a scratch address
when the change under test touches the push half. Cron sweeps run under
`npx wrangler@4 dev --test-scheduled` via
`curl 'http://localhost:8788/__scheduled?cron=0+4+*+*+*'`.

## Deploy (once, by the operator)

```sh
wrangler d1 create loxodrome-account --location weur   # id -> wrangler.toml
wrangler r2 bucket create loxodrome-account-blobs --jurisdiction eu
wrangler d1 migrations apply loxodrome-account --remote
wrangler secret put TURNSTILE_SECRET
wrangler deploy
```

Every later schema change is a new numbered file under `migrations/`
applied the same way BEFORE the worker that needs it deploys
(`0002_blobs_ledger.sql` added the blob ledger and `docs.server_at`;
the worker backfills the ledger from R2 at push time and in the nightly
sweep, so no data migration step exists). The test harness applies
every file in order, so a migration that breaks the schema fails the
suite.

Plus, in the dashboard: a Turnstile sitekey whose hostname allow-list
carries `loxodrome.fr` AND `localhost` (the Android shell's WebView),
and Email Sending enabled with `login@loxodrome.fr` verified (DKIM/SPF
on the zone). The custom domain `api.loxodrome.fr` is created by the
deploy from `[[routes]]`.

DEV_CODE must never be set in production; the aggregate ceilings
(`MAX_ACCOUNTS`, `MAX_TOTAL_BYTES`) are `[vars]`, so raising them is a
config change, and hitting one refuses NEW signups only ("service
full"), existing accounts untouched.

## Backups

Three layers, ordered by how much work they already do:

1. **D1 Time Travel** (always on, nothing to run): 30 days of
   point-in-time restore on the paid plan. `wrangler d1 time-travel
   info loxodrome-account` shows the current bookmark; `restore
   --timestamp=...` rewinds the WHOLE database in place. The blob GC's
   30-day grace was chosen to cover this window, so a rewound database
   still finds every blob it references in R2.
2. **The daily offsite dump** (`admin/backup.sh`, timered): writes a
   dated `wrangler d1 export` dump (gzip, pruned past 60 days), then
   mirrors the blob bucket, into `~/backups/loxodrome-account`
   (`LOXODROME_BACKUP_DIR` overrides; created mode 700, the dumps carry
   every address and payload). The dump comes FIRST: a client PUTs its
   blobs before the doc that references them, so every blob a dump
   references existed before the dump, and a mirror taken after it
   holds them all (the GC only removes 30-day orphans and the purge runs
   at 04:00, outside the timer's window). The other order would leave a
   blob uploaded between the two halves in the dump and out of the
   mirror. Enable the timer (a user timer runs only while the user
   manager does: `loginctl enable-linger $USER` on a machine nobody
   stays logged into):

   ```sh
   systemctl --user link $PWD/admin/loxodrome-backup.service
   systemctl --user link $PWD/admin/loxodrome-backup.timer
   systemctl --user enable --now loxodrome-backup.timer
   ```

   The blob half needs one-time setup (it skips quietly until then):
   `dnf install rclone`, mint a READ-ONLY R2 API token in the dashboard
   (R2 -> Manage API tokens; the S3 keypair is the token id + the
   sha256 of its value), and configure it as the rclone remote
   `loxodrome-r2` (endpoint
   `https://<account_id>.eu.r2.cloudflarestorage.com`, the EU
   jurisdiction in the hostname).
3. **R2 itself**: the blobs are content-addressed and immutable in
   eleven-nines storage; the mirror exists for the account-level
   catastrophe, not for durability.

Restores: recent oops -> Time Travel. Older or off-Cloudflare -> create
a fresh D1, `wrangler d1 execute --remote --file <dump.sql>` (gunzip
first), rclone the mirror back into the bucket, redeploy. Clients whose
registries are AHEAD of a rewound database re-pull from zero on their
own: the changes clamp answers a too-new `since` with the reset marker.

## Provisioned (2026-08-27)

Everything below exists on the account; re-running the runbook is only
needed for a rebuild from scratch.

- D1 `loxodrome-account` (weur), id `269604c6-c779-45b9-a799-f0eeaf630829`,
  migrations applied remotely.
- R2 `loxodrome-account-blobs`, jurisdiction `eu` (the binding carries
  `jurisdiction = "eu"`; a jurisdictional bucket is invisible without it).
- Email Sending enabled for loxodrome.fr via `wrangler email sending
  enable` (it auto-created the cf-bounce MX/SPF/DKIM records and the
  apex `_dmarc` `p=reject` on the same-account zone); a test send to the
  operator's address delivered.
- Turnstile widget "Loxodrome accounts", sitekey
  `0x4AAAAAAEd1VOtpMNL14pac` (public; domains loxodrome.fr +
  localhost, managed mode); its secret lives ONLY as the worker secret
  TURNSTILE_SECRET.
- Worker deployed at api.loxodrome.fr (custom domain + cert
  auto-provisioned), cron `0 4 * * *`.
- Every LIVE build (the deployed web site, the Android RELEASE bundle
  every Play track consumes) carries the real sitekey by code default
  (src/lib/net/endpoints.ts); `VITE_TURNSTILE_SITEKEY` overrides, the
  value `none` forcing the widget off. Android DEBUG builds
  (`android:apk`) bake the fake-account posture instead: this local
  worker as the base, no widget, DEV_CODE codes.
