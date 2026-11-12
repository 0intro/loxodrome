/* loxodrome-nwp: Loxodrome's own forecast service at nwp.loxodrome.fr
 * (docs/nwp-service.md). Météo-France AROME and ARPEGE and ECMWF IFS, ingested
 * from their open data by a Cloudflare Container into R2 archives, served in
 * Open-Meteo's shape so the app's client reads them unchanged.
 *
 *   GET /v1/forecast                        the columns (src/forecast.ts)
 *   GET /v1/data/<dir>/static/meta.json     a model's served run, Open-Meteo's
 *                                           run-metadata shape (forecastCache)
 *   GET /v1/status                          per model: run, age, job, errors
 *   cron every minute                       each model's orchestrator ticks
 *
 * Origin-gated like loxodrome-proxy (no Origin, no answer), rate-limited per
 * IPv4 address and IPv6 /64 in the isolate, the status page included.
 * DISABLED=1 answers every forecast and run poll 503 "disabled": the lever
 * every client fails over to Open-Meteo on, with no release. Invocation logs
 * are off (the API sees coordinates); only failures are logged, never an
 * address and never a point. */

import { ContainerProxy } from '@cloudflare/containers';
import { answer, parseRequest, RequestError, SplitError } from './src/forecast.ts';
import { R2Source } from './src/store.ts';
import { MODEL_IDS, MODELS, type ModelId } from './src/models.ts';
import { budgetStatus, jobBudgetMs } from './src/plan.ts';
import { runStamp } from './src/pointer.ts';
import { NwpIngest } from './src/ingest.ts';
import type { Env } from './src/env.ts';
import { clientKey, corsHeaders, DEFAULT_ALLOW_ORIGINS, failure, json, rateLimited } from './src/http.ts';

export { ContainerProxy, NwpIngest };

async function route(request: Request, env: Env, ctx: ExecutionContext, allowOrigin: string): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
	}
	const retry = rateLimited(clientKey(request.headers.get('CF-Connecting-IP') ?? ''), Date.now());
	if (url.pathname === '/v1/status' && request.method === 'GET') {
		// The operator's page: no coordinates, nothing private, no Origin
		// needed, the address limit applying all the same.
		if (retry > 0) {
			return failure(429, 'rate limited: slow down and retry', allowOrigin, { 'Retry-After': String(retry) });
		}
		return status(env, allowOrigin, ctx);
	}
	if (!allowOrigin) {
		return new Response('origin not allowed', { status: 403 });
	}
	if (request.method !== 'GET') {
		return failure(405, 'method not allowed', allowOrigin);
	}
	if (retry > 0) {
		return failure(429, 'rate limited: slow down and retry', allowOrigin, { 'Retry-After': String(retry) });
	}
	const metaMatch = /^\/v1\/data\/([a-z0-9]+)\/static\/meta\.json$/.exec(url.pathname);
	if (metaMatch) {
		const model = metaMatch[1];
		if (!Object.hasOwn(MODELS, model)) {
			return failure(404, 'unknown directory', allowOrigin);
		}
		// The lever covers the run polls too: an answer of ours closes the
		// client's failover circuit, which would send it back to a disabled
		// forecast every poll.
		if (env.DISABLED === '1') {
			return failure(503, 'disabled', allowOrigin);
		}
		return meta(env, model as ModelId, allowOrigin, ctx);
	}
	if (url.pathname !== '/v1/forecast') {
		return failure(404, 'not found', allowOrigin);
	}
	if (env.DISABLED === '1') {
		return failure(503, 'disabled', allowOrigin);
	}
	try {
		const req = parseRequest(url);
		const source = new R2Source(env.NWP, caches.default, url.origin, ctx);
		const res = await answer(req, source);
		if (res.missing.length > 0) {
			// Archive keys only: model, run and hours, no point.
			console.error(JSON.stringify({ event: 'archive-missing', keys: res.missing.slice(0, 8) }));
		}
		if (res.locations.every((l) => l.x_unserved) && res.tileReads === 0) {
			const anyRun = await Promise.all(req.chain.map((m) => source.pointer(m)));
			if (anyRun.every((p) => !p || p.runs.length === 0)) {
				return failure(503, 'no run published', allowOrigin);
			}
		}
		return json(res.locations.length === 1 ? res.locations[0] : res.locations, 200, allowOrigin);
	} catch (err) {
		if (err instanceof SplitError) {
			// The client asks the parts side by side.
			return json({ error: true, reason: err.message, x_split: err.parts }, 400, allowOrigin);
		}
		if (err instanceof RequestError) {
			// A refused request fails over to Open-Meteo in the client, so
			// the refusal is logged, its figures masked: a reason may
			// quote the coordinates it refused.
			console.error(
				JSON.stringify({ event: 'forecast-refused', status: err.status, reason: err.message.replace(/\d+(?:\.\d+)?/g, 'N').slice(0, 160) }),
			);
			return failure(err.status, err.message, allowOrigin);
		}
		console.error(JSON.stringify({ event: 'forecast-error', error: String(err) }));
		return failure(500, 'internal error', allowOrigin);
	}
}

/** Open-Meteo's run metadata for one of our directories (the client's
 *  parseRunMeta reads the run and the GEOGCRS BBOX). */
async function meta(env: Env, model: ModelId, origin: string, ctx: ExecutionContext): Promise<Response> {
	const p = await new R2Source(env.NWP, null, '', ctx).pointer(model);
	const run = p?.runs[0];
	if (!p || !run) {
		return failure(404, 'no run published', origin);
	}
	const spec = MODELS[model];
	const g = spec.grid;
	const south = (g.northE6 - (g.nj - 1) * g.djE6) / 1e6;
	const east = (g.westE6 + (g.ni - 1) * g.diE6) / 1e6;
	const bbox = g.wraps ? 'BBOX[-90,-180,90,180]' : `BBOX[${south},${g.westE6 / 1e6},${g.northE6 / 1e6},${east}]`;
	return json(
		{
			// The run as the forecasts name it (runStamp): a second after its
			// start once published whole.
			last_run_initialisation_time: runStamp(run),
			last_run_modification_time: Math.round(Date.parse(run.published) / 1000),
			last_run_availability_time: Math.round(Date.parse(run.published) / 1000),
			update_interval_seconds: spec.cycleHours * 3600,
			temporal_resolution_seconds: 3600,
			crs_wkt: `GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563]],CS[ellipsoidal,2],AXIS["latitude",north],AXIS["longitude",east],ANGLEUNIT["degree",0.0174532925199433],USAGE[SCOPE["grid"],${bbox}]]`,
		},
		200,
		origin,
	);
}

/** The status page, computed at most every STATUS_TTL_MS in an isolate:
 *  each computation reads three pointers and calls three Durable Objects,
 *  and the page is open to anyone. */
const STATUS_TTL_MS = 30_000;
let statusHeld: { at: number; body: Promise<Record<string, unknown>> } | null = null;

async function status(env: Env, origin: string, ctx: ExecutionContext): Promise<Response> {
	const now = Date.now();
	if (!statusHeld || now - statusHeld.at >= STATUS_TTL_MS) {
		const body = statusBody(env, ctx, now);
		statusHeld = { at: now, body };
		ctx.waitUntil(body.catch(() => (statusHeld = null)));
	}
	return json(await statusHeld.body, 200, origin);
}

/** A model's orchestrator, placed in Western Europe beside the bucket and
 *  the Container: whoever touches a Durable Object first places it for
 *  good, so the status page, which anyone may open, asks with the hint the
 *  cron gives. */
function orchestrator(env: Env, model: ModelId): DurableObjectStub<NwpIngest> {
	return env.INGEST.get(env.INGEST.idFromName(model), { locationHint: 'weur' });
}

async function statusBody(env: Env, ctx: ExecutionContext, now: number): Promise<Record<string, unknown>> {
	const src = new R2Source(env.NWP, null, '', ctx);
	const budgetMs = jobBudgetMs(env.JOB_BUDGET_MINUTES);
	const out: Record<string, unknown> = { disabled: env.DISABLED === '1', now: new Date(now).toISOString() };
	const answers = await Promise.all(
		MODEL_IDS.map((model) =>
			Promise.all([
				src.pointer(model),
				orchestrator(env, model)
					.status()
					.catch(() => null),
			]),
		),
	);
	for (const [k, model] of MODEL_IDS.entries()) {
		const [p, st] = answers[k];
		const run = p?.runs[0];
		out[model] = {
			run: run?.run ?? null,
			published: run?.published ?? null,
			ageHours: run ? Math.round((now - Date.parse(run.run)) / 360_000) / 10 : null,
			truncated: run?.truncated ?? false,
			pastDays: p ? Math.round((now - Math.min(...p.past.map((x) => Date.parse(x.run)), now)) / 8_640_000) / 10 : 0,
			job: st?.job ?? null,
			// A job that built nothing holds the next one back until then.
			notBefore: st?.notBefore && st.notBefore > now ? new Date(st.notBefore).toISOString() : null,
			lastTick: st?.lastTick ? new Date(st.lastTick).toISOString() : null,
			lastError: st?.lastError ?? null,
			stale: st?.alert.stale ?? null,
			// Today's container time against the daily budget (UTC): held,
			// no job starts until 00:00 UTC.
			...budgetStatus(st, budgetMs, now),
			// The runs still being built: collecting, and served truncated
			// with blocks to come (whose failures were invisible here).
			collecting: st?.runs
				.filter((r) => r.status === 'collecting' || r.status === 'truncated')
				.map((r) => ({
					run: r.run,
					status: r.status,
					// When its first blocks were found at the publisher.
					readyAt: r.readyAt ? new Date(r.readyAt).toISOString() : null,
					blocks: Object.fromEntries(
						Object.entries(r.blocks).map(([k, b]) => [k, b.status + (b.attempts ? `/${b.attempts}` : '') + (b.error && b.status !== 'built' ? ` ${b.error}` : '')]),
					),
				})),
		};
	}
	return out;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const origin = request.headers.get('Origin') ?? '';
		const allowed = (env.ALLOW_ORIGINS ?? DEFAULT_ALLOW_ORIGINS)
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const allowOrigin = allowed.includes(origin) ? origin : '';
		try {
			return await route(request, env, ctx, allowOrigin);
		} catch (err) {
			// Every route answers in Open-Meteo's shape with its CORS headers,
			// never the runtime's error page, which a browser cannot read.
			console.error(JSON.stringify({ event: 'request-error', error: String(err) }));
			return failure(500, 'internal error', allowOrigin);
		}
	},

	scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
		for (const model of MODEL_IDS) {
			ctx.waitUntil(
				orchestrator(env, model)
					.tick(model)
					.catch((err: unknown) => console.error(JSON.stringify({ event: 'tick-failed', model, error: String(err) }))),
			);
		}
	},
} satisfies ExportedHandler<Env>;
