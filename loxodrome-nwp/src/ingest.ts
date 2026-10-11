/* The ingest orchestrator: one Durable Object per model, which is also the
 * model's Container (docs/nwp-service.md "Orchestration").
 *
 * The Worker's cron calls tick(model) every minute: list the runs' files at
 * the publisher, start a Container job on the oldest run's ready blocks when
 * none runs (`nwp ingest`, which drains them and EXITS: an instance kept up
 * through a run's landing window costs ten times as much),
 * publish a run once every block is built and its canary tiles decode to
 * their receipts' hashes through the read path's own decoder, apply the
 * retention, and mail the operator when the served run is overdue (and
 * again when it recovers). The Container writes to R2 through the outbound
 * handler below, which holds the bucket: no credential enters the image. */

import { Container, type StopParams } from '@cloudflare/containers';
import { MODELS, type ModelId } from './models.ts';
import { Coalescer } from './coalesce.ts';
import { listRuns } from './discover.ts';
import {
	applyDiscovery,
	budgetSpent,
	closeJob,
	DISCOVERY_BUDGET_MS,
	freshState,
	JOB_CAP_MS,
	jobBudgetMs,
	jobEnd,
	MAIL_EVERY_MS,
	nextJob,
	nextPointer,
	noticeDue,
	publication,
	released,
	retryFailed,
	runsToList,
	seedFromPointer,
	staleness,
	startJob,
	stateStands,
	trackRuns,
	usageToday,
	writtenByJob,
	type Job,
	type JobEnd,
	type ModelState,
	type Notice,
	type Receipt,
	type RunState,
} from './plan.ts';
import { isPointer, type Pointer } from './pointer.ts';
import type { Env } from './env.ts';
import { checkCanaries, runKey, STORE_HOST, storeHandler } from './storeHandler.ts';

/** How long a tick may run before the next one joining it says so. */
const TICK_STUCK_MS = 3 * 60_000;

export class NwpIngest extends Container<Env> {
	override sleepAfter = '30m';
	override enableInternet = true;

	private chain: Promise<unknown> = Promise.resolve();
	private ticks = new Coalescer<ModelState>();

	/** Runs fn after every earlier call: a tick and a stop never interleave
	 *  their reads and writes of the state. */
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.chain.then(fn, fn);
		this.chain = next.catch(() => undefined);
		return next;
	}

	private async load(model?: ModelId): Promise<ModelState> {
		const epoch = this.env.STATE_EPOCH ?? '';
		const s = await this.ctx.storage.get<ModelState>('state');
		if (s && stateStands(s, epoch)) {
			return s;
		}
		model ??= s?.model;
		if (!model) {
			throw new Error('nwp: the orchestrator has no model yet');
		}
		const state = freshState(s, model, epoch);
		if (s) {
			// The operator's STATE_EPOCH changed (the bucket moved, or
			// restored): this orchestrator starts afresh from the bucket.
			console.log(JSON.stringify({ event: 'state-reset', model, epoch }));
		}
		// A state lost (or reset) with runs already served: what the pointer
		// serves is taken as published, never built again nor republished
		// truncated.
		const obj = await this.env.NWP.get(`latest/${model}.json`);
		const raw: unknown = obj ? await obj.json() : null;
		if (isPointer(raw)) {
			seedFromPointer(state, raw, Date.now());
		}
		return state;
	}

	private async save(s: ModelState): Promise<void> {
		await this.ctx.storage.put('state', s);
	}

	/** The cron's entry point. A tick still running is joined, never
	 *  queued behind. */
	async tick(model: ModelId): Promise<ModelState> {
		return this.ticks.run(
			Date.now(),
			() => this.serial(() => this.doTick(model)),
			(age) => {
				if (age > TICK_STUCK_MS) {
					console.error(JSON.stringify({ event: 'tick-stuck', model, seconds: Math.round(age / 1000) }));
				}
			},
		);
	}

	async status(): Promise<ModelState | null> {
		return (await this.ctx.storage.get<ModelState>('state')) ?? null;
	}

	private async doTick(model: ModelId): Promise<ModelState> {
		const spec = MODELS[model];
		const state = await this.load(model);
		const now = Date.now();
		state.lastTick = now;
		const errors: string[] = [];
		// Each stage stands alone: a publisher's listing failing used to throw
		// out of the whole tick, so nothing was published, no job started and
		// no stale alert sent for as long as it failed.
		const stage = async (what: string, fn: () => Promise<void>): Promise<void> => {
			try {
				await fn();
			} catch (err) {
				errors.push(`${what}: ${String(err)}`);
				console.error(JSON.stringify({ event: 'tick-error', model, stage: what, error: String(err) }));
			}
		};
		let killed = false;
		await stage('job', async () => {
			if (!state.job) {
				return;
			}
			const cs = await this.getState();
			const running = cs.status === 'running' || cs.status === 'healthy' || cs.status === 'stopping';
			if (!running) {
				const exited = cs.status === 'stopped_with_code';
				await this.collect(state, exited ? `exit ${cs.exitCode ?? '?'}` : `container ${cs.status}`, exited ? cs.exitCode : undefined);
			} else if (now - state.job.started > JOB_CAP_MS) {
				console.error(JSON.stringify({ event: 'job-over-cap', model, job: state.job }));
				await this.destroy();
				await this.collect(state, 'killed past the job cap', undefined, true);
				// The next job waits for the next tick: the killed
				// container's stop must not land on a job started now.
				killed = true;
			}
		});
		await stage('tracking', () => {
			trackRuns(state, now);
			const epoch = this.env.RETRY_EPOCH ?? '';
			if (epoch && state.retryEpoch !== epoch) {
				const n = retryFailed(state);
				state.retryEpoch = epoch;
				console.log(JSON.stringify({ event: 'retry-failed', model, epoch, blocks: n }));
			}
			return Promise.resolve();
		});
		// One budget for every listing, its timer cleared once they are
		// done: a timer per request, left pending, kept the object awake.
		const budget = new AbortController();
		const timer = setTimeout(() => budget.abort(new Error(`listing past ${DISCOVERY_BUDGET_MS / 1000} s`)), DISCOVERY_BUDGET_MS);
		try {
			const runs = runsToList(state);
			const listed = await listRuns(spec, runs.map((r) => r.run), (u, init) => fetch(u, init), budget.signal);
			for (const l of listed) {
				const run = runs.find((r) => r.run === l.run);
				await stage(`listing ${l.run}`, () => {
					if (l.error !== undefined) {
						throw l.error;
					}
					if (run && l.ready) {
						applyDiscovery(run, l.ready, Date.now());
					}
					return Promise.resolve();
				});
			}
		} finally {
			clearTimeout(timer);
		}
		for (const run of state.runs) {
			const pub = publication(state, run, now);
			if (pub) {
				await stage(`publishing ${run.run}`, () => this.publish(state, run, pub.blocks, pub.truncated, now));
			}
		}
		// Never over a container still running with no job recorded (one
		// killed at its cap still stopping): its stop would end the new job.
		if (!state.job && !killed && this.env.INGEST_PAUSED !== '1' && !this.ctx.container?.running) {
			// Started now, not at the tick's start: a job this tick collected
			// stored its log and receipts before then, which must not read as
			// the new job's own (writtenByJob).
			const job = nextJob(state, Date.now());
			const budgetMs = jobBudgetMs(this.env.JOB_BUDGET_MINUTES);
			if (job && budgetSpent(state, budgetMs, Date.now())) {
				// Today's container time is spent: nothing starts until
				// 00:00 UTC, and the operator hears of it once.
				await stage('budget', () => this.budgetHeld(state, budgetMs));
			} else if (job) {
				startJob(state, job);
				await this.save(state);
				const blocks = spec.blocks(new Date(Date.parse(job.run)).getUTCHours());
				const indexes = job.blocks.map((n) => blocks.findIndex((b) => b.name === n));
				await stage('starting the job', async () => {
					try {
						await this.start({
							entrypoint: ['/nwp', 'ingest', '-model', model, '-run', job.run.slice(0, 13), '-blocks', indexes.join(','), '-out', 'r2', '-store', `http://${STORE_HOST}`, '-tmp', '/tmp'],
							enableInternet: true,
							labels: { model, run: runKey(job.run) },
						});
					} catch (err) {
						// The Container never ran: its blocks wait, charged
						// nothing, for the pause a job that built nothing
						// takes. Its time is charged all the same: a start
						// the library gives up waits for the container to
						// exit first, a whole job uncapped.
						const end = Date.now();
						const { overrun } = closeJob(state, { receipts: new Map(), error: null, end: 'unstarted' }, end);
						if (overrun && noticeDue(state, overrun, end)) {
							await this.mailOverrun(state, job, overrun, end, null);
						}
						throw err;
					}
				});
			}
		}
		// Whatever failed above: an overdue run is mailed all the same.
		await stage('alerts', () => this.alerts(state, now));
		const mailTest = this.env.MAIL_TEST ?? '';
		if (mailTest && model === 'arome0025' && state.mailTest !== mailTest) {
			state.mailTest = mailTest;
			await stage('mail test', () => this.mail('[nwp] test alert', `The forecast service's alerts reach this address (${mailTest}).\nhttps://nwp.loxodrome.fr/v1/status\n`));
		}
		state.lastError = errors.length > 0 ? errors.join('; ').slice(0, 1000) : null;
		await this.save(state);
		return state;
	}

	/** Reads the receipts of the finished job's blocks and, when one is
	 *  missing, the job's own log, which says how it ended; how many blocks
	 *  it built. A receipt or a log is read only when the job wrote it
	 *  (writtenByJob), never an earlier job's under the same key. */
	private async collect(state: ModelState, error: string | null, exitCode?: number, killed = false): Promise<number> {
		const job = state.job;
		if (!job) {
			return 0;
		}
		const receipts = new Map<string, Receipt | null>();
		for (const name of job.blocks) {
			const obj = await this.env.NWP.get(`receipts/${state.model}/${runKey(job.run)}/${name}.json`);
			receipts.set(name, obj && writtenByJob(job, obj.uploaded.getTime()) ? await obj.json<Receipt>() : null);
		}
		let end: JobEnd = 'exited';
		let last: string | undefined;
		if ([...receipts.values()].some((r) => !r)) {
			// The job's own account of it, which `nwp ingest` stores beside
			// what it built: its last line is the error, or the stop. Never an
			// earlier job's, left under the same key by a job that wrote one.
			const log = await this.env.NWP.get(`logs/${state.model}/${runKey(job.run)}/${job.blocks[0]}.log`).catch(() => null);
			last = log && writtenByJob(job, log.uploaded.getTime()) ? (await log.text()).trim().split('\n').pop() : undefined;
			if (last) {
				error = last.slice(0, 500);
			}
			end = jobEnd(exitCode, last);
			console.error(JSON.stringify({ event: end === 'stopped' ? 'job-stopped' : 'job-failed', model: state.model, job, exitCode: exitCode ?? null, error }));
		}
		const now = Date.now();
		const { built, overrun } = closeJob(state, { receipts, error, end, killed, exitCode: exitCode ?? null, lastLine: last }, now);
		if (overrun && noticeDue(state, overrun, now)) {
			await this.mailOverrun(state, job, overrun, now, error);
		}
		return built;
	}

	/** Mails a job that overran, the first of the UTC day of each kind. */
	private async mailOverrun(state: ModelState, job: Job, kind: Notice, now: number, error: string | null): Promise<void> {
		const spec = MODELS[state.model];
		const what = `${job.run}, ${job.blocks.join(', ')}, started ${new Date(job.started).toISOString()}, ${Math.round((now - job.started) / 60_000)} min`;
		const after = `\n\nLast error: ${error ?? 'none'}\nhttps://nwp.loxodrome.fr/v1/status\n`;
		if (kind === 'deadline') {
			console.error(JSON.stringify({ event: 'job-deadline', model: state.model, job }));
			await this.mail(
				`[nwp] ${spec.name}: a job reached its own deadline`,
				`${spec.name} (${state.model}): a job ran until its own 15-minute deadline ended it (${what}). The orchestrator should have killed it at its 12-minute cap: its ticks, or its inactivity timeout, did not run in time (lastTick on the status page; tick-stuck, tick-failed and container-error in the log). Its first unbuilt block is charged an attempt.${after}`,
			);
			return;
		}
		await this.mail(
			`[nwp] ${spec.name}: a job ran past its 12-minute cap`,
			`${spec.name} (${state.model}): a job ran past its 12-minute cap and was killed (${what}). Its first unbuilt block is charged an attempt, and given up after three; jobs hanging again and again spend the model's daily container budget (JOB_BUDGET_MINUTES), past which none starts until 00:00 UTC. Only the first of the day is mailed.${after}`,
		);
	}

	/** A job the budget holds: logged and mailed once a UTC day. */
	private async budgetHeld(state: ModelState, budgetMs: number): Promise<void> {
		const now = Date.now();
		if (!noticeDue(state, 'budget', now)) {
			return;
		}
		const spec = MODELS[state.model];
		const used = usageToday(state, now);
		const usedMin = Math.round(used.ms / 60_000);
		console.log(JSON.stringify({ event: 'budget-held', model: state.model, usedMin, jobs: used.jobs, budgetMin: budgetMs / 60_000 }));
		await this.mail(
			`[nwp] ${spec.name}: daily container budget spent`,
			`${spec.name} (${state.model}) has run ${usedMin} minutes of jobs today (UTC, ${used.jobs} jobs), its budget being ${budgetMs / 60_000}: no job starts until 00:00 UTC. Publication and the alerts go on; the runs it cannot build wait, and the served one ages.\n\nAROME France, the heaviest model, runs about 23 minutes on a normal day: a budget spent means jobs ran far longer than they should (hung, or a publisher very slow).\n\nTo build again today: raise JOB_BUDGET_MINUTES and deploy the Worker alone (npx wrangler deploy --containers-rollout=none). A new RETRY_EPOCH does not lift it.\nhttps://nwp.loxodrome.fr/v1/status\n`,
		);
	}

	override async onStop(params: StopParams): Promise<void> {
		let built = 0;
		await this.serial(async () => {
			const state = await this.ctx.storage.get<ModelState>('state');
			if (!state?.job) {
				return;
			}
			// A stop reported while a container runs is an earlier
			// container's, the job a tick already collected: the one
			// running now is the next job's, which this must not end.
			if (this.ctx.container?.running) {
				return;
			}
			built = await this.collect(state, params.exitCode === 0 ? null : `exit ${params.exitCode}`, params.exitCode);
			await this.save(state);
		});
		// Publish what the job built and start the next one without waiting
		// for the cron. A job that built nothing holds the next one back
		// (paceAfterJob): a fault every block shares (a store refusing
		// writes) then costs a job every five minutes rather than every
		// minute, and leaves the blocks' attempts for after the fix.
		if (built > 0) {
			await this.schedule(5, 'tickScheduled');
		}
	}

	/** The library's alarm loop reads its schedules, runs onStop (which
	 *  schedules the tick that publishes a job's blocks and starts the next),
	 *  then deletes the alarm when it found none: that tick waited for the
	 *  cron, a minute or more after each job. Re-armed here for a schedule
	 *  still pending with no alarm set. */
	override async alarm(alarmProps?: AlarmInvocationInfo): Promise<void> {
		await super.alarm(alarmProps);
		if ((await this.ctx.storage.getAlarm()) === null) {
			const pending = await this.listSchedules('tickScheduled');
			if (pending.length > 0) {
				await this.ctx.storage.setAlarm(Math.max(Date.now(), pending[0].time * 1000));
			}
		}
	}

	async tickScheduled(): Promise<void> {
		const state = await this.ctx.storage.get<ModelState>('state');
		if (state) {
			await this.tick(state.model);
		}
	}

	override onError(error: unknown): unknown {
		console.error(JSON.stringify({ event: 'container-error', error: String(error) }));
		return error;
	}

	override async onActivityExpired(): Promise<void> {
		// Never inside serial: the tick may be stuck in start() (a start the
		// library gives up waits for the container to exit), which leaves
		// this as the one kill, and stop() reaches onStop, which waits on
		// serial. collect knows this kill by the time the job ran.
		// A job holds no connection, so it looks idle: keep it to its cap.
		const state = await this.ctx.storage.get<ModelState>('state');
		if (state?.job && Date.now() - state.job.started < JOB_CAP_MS) {
			this.renewActivityTimeout();
			return;
		}
		if (state?.job) {
			// Past its cap: killed and charged, as the tick's cap would. A
			// SIGTERM would let it exit as stopped on request, charged
			// nothing.
			if (this.ctx.container?.running) {
				console.error(JSON.stringify({ event: 'job-over-cap', model: state.model, job: state.job }));
				await this.destroy();
			}
			return;
		}
		await this.stop();
	}

	private async publish(state: ModelState, run: RunState, names: string[], truncated: boolean, now: number): Promise<void> {
		for (const name of names) {
			const b = run.blocks[name];
			if (b.verified) {
				// Checked at the run's truncated publication, served since.
				continue;
			}
			const rec = b.receipt;
			// A read that fails is no verdict: thrown, and the publication
			// waits for the next tick with the block left as built.
			const bad = rec ? await checkCanaries(this.env.NWP, rec) : 'no receipt';
			if (bad) {
				console.error(JSON.stringify({ event: 'canary-failed', model: state.model, run: run.run, block: name, error: bad }));
				b.status = 'failed';
				b.attempts++;
				b.error = bad;
				delete b.receipt;
				return;
			}
			b.verified = true;
		}
		const prevObj = await this.env.NWP.get(`latest/${state.model}.json`);
		const prevRaw: unknown = prevObj ? await prevObj.json() : null;
		const prev: Pointer | null = isPointer(prevRaw) ? prevRaw : null;
		const next = nextPointer(prev, state.model, run, names, truncated, now);
		await this.env.NWP.put(
			`manifests/${state.model}/${runKey(run.run)}.json`,
			JSON.stringify({ run: run.run, published: new Date(now).toISOString(), truncated, blocks: names.map((n) => run.blocks[n].receipt) }),
			{ httpMetadata: { contentType: 'application/json' } },
		);
		await this.env.NWP.put(`latest/${state.model}.json`, JSON.stringify(next), {
			httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
		});
		run.status = truncated ? 'truncated' : 'published';
		run.publishedAt = now;
		if (!truncated) {
			// The manifest and the pointer hold them now; the state keeps two
			// days of runs and would carry every block's receipt.
			for (const b of Object.values(run.blocks)) {
				delete b.receipt;
			}
			// A truncated publication is no recovery: the run it serves may
			// never complete.
			state.failedRuns = 0;
		}
		const gone = released(prev, next);
		if (gone.length > 0) {
			await this.env.NWP.delete(gone);
		}
		console.log(JSON.stringify({ event: 'published', model: state.model, run: run.run, truncated, released: gone.length }));
	}

	private async alerts(state: ModelState, now: number): Promise<void> {
		const reason = staleness(state, now);
		const spec = MODELS[state.model];
		if (reason && (!state.alert.stale || now - state.alert.lastMail > MAIL_EVERY_MS)) {
			const budgetMs = jobBudgetMs(this.env.JOB_BUDGET_MINUTES);
			const held = budgetSpent(state, budgetMs, now)
				? `\nThe daily container budget is spent (${Math.round(usageToday(state, now).ms / 60_000)} of ${budgetMs / 60_000} min): no job starts until 00:00 UTC.\n`
				: '';
			await this.mail(`[nwp] ${spec.name} stale`, `${spec.name} (${state.model}): ${reason}.\n${held}\nLast error: ${state.lastError ?? 'none'}\nhttps://nwp.loxodrome.fr/v1/status\n`);
			state.alert = { stale: true, lastMail: now, reason };
		} else if (!reason && state.alert.stale) {
			await this.mail(`[nwp] ${spec.name} recovered`, `${spec.name} (${state.model}) is serving a fresh run again.\nhttps://nwp.loxodrome.fr/v1/status\n`);
			state.alert = { stale: false, lastMail: now, reason: '' };
		}
	}

	private async mail(subject: string, body: string): Promise<void> {
		const to = this.env.REPORT_EMAIL;
		if (!this.env.EMAIL || !to) {
			console.error(JSON.stringify({ event: 'mail-skipped', subject }));
			return;
		}
		const from = this.env.SENDER_EMAIL ?? 'nwp@loxodrome.fr';
		const spec = 'cloudflare:email';
		const mod = (await import(/* @vite-ignore */ spec)) as { EmailMessage: new (from: string, to: string, raw: string) => unknown };
		const raw = [
			`From: Loxodrome NWP <${from}>`,
			`To: <${to}>`,
			`Subject: ${subject}`,
			`Date: ${new Date().toUTCString()}`,
			`Message-ID: <${crypto.randomUUID()}@loxodrome.fr>`,
			'MIME-Version: 1.0',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Transfer-Encoding: 8bit',
			'',
			body,
		].join('\r\n');
		try {
			await this.env.EMAIL.send(new mod.EmailMessage(from, to, raw));
			console.log(JSON.stringify({ event: 'mail-sent', subject }));
		} catch (err) {
			console.error(JSON.stringify({ event: 'mail-failed', subject, error: String(err) }));
		}
	}
}

// Registered through Container's static SETTER, which fills the registry the
// outbound proxy reads. A `static outboundByHost = …` field would not do:
// ES2022 class fields DEFINE an own property and never call an inherited
// setter, so the Container intercepted r2.nwp from the field while the
// proxy, finding no handler, sent every store request to the internet
// (Cloudflare's 1016: no DNS for r2.nwp), the first production night.
NwpIngest.outboundByHost = { [STORE_HOST]: storeHandler };
