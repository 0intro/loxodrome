# nwp.loxodrome.fr

Loxodrome's own forecast service. It ingests Météo-France's AROME, AROME-OM
(over five overseas territories) and ARPEGE, and ECMWF's IFS, from their
publishers' open data, keeps them in R2 as archives laid out for point reads,
and answers the application in Open-Meteo's request and response shape, so
the client reads either the same way.

| Model | Grid | Runs | Reach | Licence |
|---|---|---|---|---|
| Météo-France AROME | 0.025°, France and its neighbours | 8 a day | 51 h | Licence Ouverte 2.0 |
| Météo-France AROME-OM | 0.025°, five domains: the French West Indies, French Guiana, the Indian Ocean (Réunion, Mayotte), New Caledonia, French Polynesia | 4 a day | 48 h | Licence Ouverte 2.0 |
| Météo-France ARPEGE | 0.1°, Europe | 4 a day | 102 h | Licence Ouverte 2.0 |
| ECMWF IFS (open data) | 0.25°, the globe | 4 a day | 360 h (00 and 12 UTC), 144 h | CC BY 4.0 |

Per pressure level (sixteen from 1000 to 300 hPa for AROME and ARPEGE, twelve
for AROME-OM, whose files lack 750, 650, 550 and 450, eight for IFS): wind,
temperature, geopotential height and cloud cover, the IFS cover derived from
the relative humidity. At the surface: the 10 m wind, its gust, the 2 m
temperature, the mean-sea-level and surface pressures, and each model's own
ground as the location's elevation (ARPEGE's and AROME-OM's derived from
their isobaric column: AROME-OM publishes none, ARPEGE's stated one is not
the ground of its own surface pressure).

Open-Meteo stays the application's fallback, asked straight from the browser:
for the models this service does not carry, for a window starting more than a
week back, for a point a model does not cover, and whenever this service
fails to answer.

## The read API

```
GET /v1/forecast?latitude=…&longitude=…&hourly=…&models=…&start_hour=…&end_hour=…
GET /v1/data/<dir>/static/meta.json
GET /v1/status
```

`/v1/forecast` takes Open-Meteo's parameters (up to 200 points, sixteen days,
`wind_speed_unit=kn`, `timeformat=unixtime`) and answers its JSON, a bare
object for one point and an array for several, hourly whatever the model's
native step. `models` names a chain, each point and hour served by the first
member that holds it:

| `models` | Members |
|---|---|
| `auto_chain` | AROME, then the five AROME-OM domains, then ARPEGE, then IFS |
| `meteofrance_seamless` | AROME, then ARPEGE |
| `arome_france`, `arpege_europe`, `ecmwf_ifs025` | that model alone |

A member holds a point where its archive does, which is the source's own
bitmap and not its rectangle: about a sixth of AROME's rectangle is masked.
An hour at or after a member's newest run comes from the newest published
run that reaches it. An earlier hour comes from the newest kept first block
whose run started at or before it: each run's first hours are kept a week,
so the past is stitched from them, and no later run ever replaces them.

Two fields of its own ride each location. `x_runs` names, per member, the
newest run that served a live hour, in seconds; the client judges a column's
freshness against those runs only, and a column served from the past alone
carries none and never goes stale. `x_unserved: true` marks a point no member
covers, or one with a past hour the service holds no archive for (the week
after it first runs, or an ingest outage): the client asks Open-Meteo for the
whole column. A future hour past the chain's reach is simply null.

Errors take Open-Meteo's shape, `{"error": true, "reason": …}`: 400 for a bad
request, 404, 429 past 300 requests a minute from one IPv4 address or IPv6
/64 (with `Retry-After`), 503 `no run published` and 503 `disabled`.

`meta.json` is Open-Meteo's run metadata for `arome0025`, the AROME-OM domains
(`aromeomantil`, `aromeomguyane`, `aromeomindien`, `aromeomncaled`,
`aromeompolyn`), `arpege01` and `ifs025`: the published run, its publication
time, the cadence and the grid's extent, which the client polls to know when
a column is outdated.

`/v1/status` is the operator's page: per model, the run served and its age,
the job running (or the pause a job that built nothing set), the runs being
collected block by block and when their first blocks were found, the last
error and whether the stale alert is out. It needs no Origin and holds
nothing private.

Every other route answers only an allowed `Origin` (the site and the Android
application's WebView); a request without one gets 403.

## The ingest

The Worker's cron ticks every minute. Each model has one Durable Object,
which is also that model's Container (the class allows ten instances: one per
model, and room for an old one finishing a job through a rollout): it lists
the publisher's store (Météo-France's by prefix, a file per hour group or, for
AROME-OM, per hour; ECMWF's directory index), and when blocks of a run have
landed and no job is running it starts one, taking about 2 GB of source. The job is `nwp ingest`
(`cmd/nwp` in this repository): it streams the GRIB2 files, decodes them in
pure Go, checks every field against plausibility bounds, quantises, and writes
one PMTiles archive per time block plus a receipt, decoding the next block
while it stores the one before, then exits. A Container kept up through a
run's landing window would cost ten times as much as the jobs do.

The Container reaches R2 through the Worker's outbound handler, which holds
the bucket binding: no credential is in the image. A run is published only
once every block is built and its canary tiles decode, through the read
path's own decoder, to the hashes its receipts state; past its model's hour
(init + 8 h, + 10 h for AROME-OM, which lands up to 8 h after its run) a run
whose first day is built publishes truncated instead. Publishing writes
`latest/<model>.json` and applies the retention: the whole runs are kept while
they are among the model's last three, the first block of every run a week.
The operator is mailed when a model's served run is overdue (AROME 10 h past
its init, ARPEGE 14 h, AROME-OM and IFS 18 h, or after two failed runs), once
per twelve hours, and again when it recovers; and, the first of each a day per
model, when a job is killed past its 12-minute cap, when one ends at its own
deadline (the orchestrator having failed to end it), and when the model's
daily budget of container time is spent.

| Prefix | What |
|---|---|
| `first/<model>/<run>.pmtiles` | each run's first time block, kept a week |
| `blocks/<model>/<run>/b<first>-<last>.pmtiles` | the later blocks, for the last three runs |
| `receipts/<model>/<run>/<block>.json` | what a job built, with its canary hashes |
| `manifests/<model>/<run>.json` | a published run |
| `latest/<model>.json` | the runs served |
| `static/<model>/orography.i16.gz` | AROME's and IFS's published ground |
| `logs/<model>/<run>/<block>.log` | a job's last lines, its error or its stop at the end, which `/v1/status` shows beside a failed block; read only when the job being collected wrote it |

## Operations

Provisioning, once:

```sh
npx wrangler r2 bucket create loxodrome-nwp --location weur
npx wrangler r2 bucket lifecycle add loxodrome-nwp blocks-3d blocks/ --expire-days 3
npx wrangler r2 bucket lifecycle add loxodrome-nwp first-8d first/ --expire-days 8
npx wrangler r2 bucket lifecycle add loxodrome-nwp receipts-8d receipts/ --expire-days 8
npx wrangler r2 bucket lifecycle add loxodrome-nwp manifests-8d manifests/ --expire-days 8
npx wrangler r2 bucket lifecycle add loxodrome-nwp logs-8d logs/ --expire-days 8
npx wrangler r2 bucket lifecycle add loxodrome-nwp multipart-1d --abort-multipart-days 1
```

The bucket sits in Western Europe, beside the Container and the users, with no
jurisdiction: the archives are public model output. R2 honours a location hint
only at a name's first creation in its namespace, so a bucket recreated under
its old name keeps its old place; an EU-jurisdiction bucket is a namespace of
its own. The lifecycle rules are a backstop: the orchestrator deletes what it
releases.
Email Sending must accept `nwp@loxodrome.fr` as a sender.

Deploying, from this directory, builds the ingest image with Docker (its
context is the repository root, of which BuildKit sends only what the
Dockerfile copies, the Go module) and deploys the Worker, the Container class
and the cron:

```sh
npx wrangler deploy
```

A change to the Worker alone deploys without building or rolling the image,
so a job running meanwhile finishes:

```sh
npx wrangler deploy --containers-rollout=none
```

A rollout waits for a running job: `rollout_active_grace_period` leaves an
instance alone for 20 minutes, past a job's 12-minute cap and the tick that
enforces it, so a deploy never cuts a job short. Only a full deploy applies it
(`--containers-rollout=none` skips every container step). A job the platform
stops anyway, for a host's maintenance, finishes the blocks in progress (the
one being stored and the one being decoded) and starts no other, stores its
log and exits 75, which the orchestrator charges nothing for; a second
signal, or five minutes, abandons them.

Cloudflare puts no limit on how long a container runs, and the orchestrator's
12-minute cap is enforced from the Worker, so a job also ends itself 15 minutes
in, whatever becomes of the Worker: it stores its log with `error: ran past
its 15m0s deadline` last and exits 124, charged like a failure, and a backstop
two minutes on exits regardless. It is gone before a rollout's grace or the
Container's inactivity timeout could end it.

The levers, each a `[vars]` entry redeployed or set in the dashboard:

- `DISABLED = "1"` answers every forecast 503 `disabled`. Every client fails
  over to Open-Meteo within the request and keeps asking it for ten minutes,
  with no release of the application.
- `INGEST_PAUSED = "1"` starts no job, while the read path keeps serving what
  is published.
- `JOB_BUDGET_MINUTES` (90) is each model's daily budget of container time:
  every job's time counts, and past it no job starts until 00:00 UTC, so a bug
  hanging every job costs at most that and a job a model a day. Raise it and
  deploy the Worker alone to build again the same day; `0` holds every job.
  `/v1/status` shows each model's `usageMin`, `usageJobs`, `budgetMin` and
  `budgetHeld`.
- A new `RETRY_EPOCH` value gives every failed block of the runs still being
  collected its three attempts back, once: set it after fixing what failed
  them (it is named after the incident it retried).
- A new `MAIL_TEST` value sends one test alert to the operator from AROME's
  orchestrator, the proof that the sender and the binding work.
- A new `STATE_EPOCH` value starts every orchestrator afresh from the bucket's
  own pointers, once, at its first tick with no job running: set it when the
  bucket is moved or restored, the runs the orchestrators remember being in
  the old one (it is named after the move).

A job that builds nothing, however it ends, holds the next one back five
minutes, so a fault every block shares costs a job every five minutes per
model rather than one a minute; a new `RETRY_EPOCH` lifts the pause.

The invocation log is off, the API seeing coordinates: what persists is the
Worker's own lines, its failures and the runs it publishes, never an address
or a request's points.

## Development

```sh
go test ./internal/aec/... ./internal/grib2/... ./internal/nwp/... ./cmd/nwp/...
npm run check:nwp   # the Worker's types
npm run test:nwp    # its suite, over the golden archives Go writes
```

The suite reads `test/fixtures/`, which the Go tests write (`go test
./internal/nwp -run Fixture -update`): a small archive with its expected
values, a chain of runs for the stitching, and the model table, so the
TypeScript reader is held to the Go writer value for value.

To serve real runs locally, ingest a few blocks into a directory, seed
wrangler's local R2 from it, and run the Worker without its Container:

```sh
go build -o /tmp/nwp ./cmd/nwp
/tmp/nwp ingest -model arome0025 -run 2026-10-06T12 -blocks 0 -out /tmp/nwp-store
node loxodrome-nwp/dev/seed.ts /tmp/nwp-store [--persist-to <state dir>]
cd loxodrome-nwp && npx wrangler dev --enable-containers=false [--persist-to <state dir>]
```

with the development origins in `loxodrome-nwp/.dev.vars`:

```
ALLOW_ORIGINS=https://loxodrome.fr,https://localhost,http://localhost:5173,http://127.0.0.1:5173
```

and the application built against it with `VITE_NWP_URL=http://localhost:8787`.

`nwp compare` asks Open-Meteo for the same points when its metadata names the
same run, and reports the differences per variable.
