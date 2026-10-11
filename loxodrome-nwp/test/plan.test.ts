import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	applyDiscovery,
	blocksPerJob,
	budgetSpent,
	budgetStatus,
	closeJob,
	DEADLINE_LINE,
	EMPTY_JOB_PAUSE_MS,
	emptyState,
	EXIT_DEADLINE,
	EXIT_STOPPED,
	finishJob,
	freshState,
	JOB_BUDGET_MINUTES,
	JOB_CAP_MS,
	jobBudgetMs,
	jobEnd,
	MAX_ATTEMPTS,
	MAX_STOPS,
	nextJob,
	nextPointer,
	noticeDue,
	overran,
	paceAfterJob,
	publication,
	released,
	retryFailed,
	runsToList,
	staleness,
	startJob,
	stateStands,
	STOPPED_LINE,
	trackRuns,
	usageToday,
	writtenByJob,
	type ModelState,
	type Receipt,
	type RunState,
	receiptFits,
	seedFromPointer,
} from '../src/plan.ts';
import { MODEL_IDS, MODELS } from '../src/models.ts';
import { FIXTURES } from './helpers.ts';

const H = 3600_000;
const T0 = Date.parse('2026-10-06T00:00:00Z');

function receipt(model: string, run: string, first: number, last: number, key: string): Receipt {
	return {
		key,
		model,
		run,
		first,
		last,
		size: 1,
		content: 'c',
		tiles: 1,
		canaries: [],
		steps: { sfc: [first], ps: [first], uvt: [first], z: [first], cloud: [first] },
		gustPeriod: [0],
	};
}

void test('runs are tracked on the model cycle, newer than the one published', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + 7 * H);
	assert.equal(s.runs[s.runs.length - 1].run, '2026-10-06T06:00:00Z');
	assert.deepEqual(
		s.runs.map((r) => r.run.slice(11, 13)),
		['18', '21', '00', '03', '06'],
		'twelve hours back on a 3-hour cycle',
	);
	assert.deepEqual(Object.keys(s.runs[0].blocks), MODELS.arome0025.blocks(0).map((b) => b.name));
	// Once one is published, older ones are no longer tracked.
	s.runs.find((r) => r.run === '2026-10-06T03:00:00Z')!.status = 'published';
	trackRuns(s, T0 + 16 * H);
	assert.ok(s.runs.find((r) => r.run === '2026-10-06T00:00:00Z')?.status === 'abandoned', 'an older collecting run goes');
	assert.ok(!s.runs.some((r) => r.run === '2026-10-06T09:00:00Z' && r.status !== 'collecting'));
});

void test('a job takes the oldest run ready blocks, three at a time, retrying failures', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + 4 * H);
	const r00 = s.runs.find((r) => r.run === '2026-10-06T00:00:00Z')!;
	const r03 = s.runs.find((r) => r.run === '2026-10-06T03:00:00Z')!;
	applyDiscovery(r03, new Set(['b000-006']));
	applyDiscovery(r00, new Set(['b000-006', 'b007-012', 'b013-018', 'b019-024']));
	const job = nextJob(s, T0 + 4 * H);
	assert.deepEqual(job, { run: r00.run, blocks: ['b000-006', 'b007-012', 'b013-018'], started: T0 + 4 * H });
	startJob(s, job);
	assert.equal(nextJob(s, T0 + 4 * H), null, 'one job at a time');
	const built = finishJob(
		s,
		new Map([
			['b000-006', receipt('arome0025', r00.run, 0, 6, 'first/arome0025/2026100600.0123456789ab.pmtiles')],
			['b007-012', null],
			['b013-018', receipt('arome0025', '2026-10-05T21:00:00Z', 13, 18, 'blocks/arome0025/2026100521/b013-018.pmtiles')],
		]),
		'exit 1',
	);
	assert.equal(built, 1, 'the blocks it built, another run\'s receipt not one');
	assert.equal(r00.blocks['b000-006'].status, 'built');
	assert.equal(r00.blocks['b007-012'].status, 'failed');
	assert.equal(r00.blocks['b007-012'].attempts, 1);
	// The job stopped at its failed block: the one after it was never
	// tried, and another run's receipt does not make it built.
	assert.deepEqual(r00.blocks['b013-018'], { status: 'ready', attempts: 0 });
	assert.equal(s.job, null);
	// Failed blocks come back until their attempts run out.
	r00.blocks['b007-012'].attempts = MAX_ATTEMPTS;
	const again = nextJob(s, T0 + 5 * H);
	assert.deepEqual(again?.blocks, ['b013-018', 'b019-024']);
});

function buildAll(run: RunState, model: string): void {
	for (const b of MODELS[model as 'arome0025'].blocks(0)) {
		run.blocks[b.name] = { status: 'built', attempts: 0, receipt: receipt(model, run.run, b.first, b.last, `${run.run}/${b.name}`) };
	}
}

void test('a run publishes whole, or truncated with its first day at init + 8 h', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + 4 * H);
	const r00 = s.runs.find((r) => r.run === '2026-10-06T00:00:00Z')!;
	for (const name of ['b000-006', 'b007-012', 'b013-018', 'b019-024']) {
		r00.blocks[name] = { status: 'built', attempts: 0, receipt: receipt('arome0025', r00.run, 0, 0, name) };
	}
	assert.equal(publication(s, r00, T0 + 7 * H), null, 'not before init + 8 h');
	assert.deepEqual(publication(s, r00, T0 + 8 * H + 1), { blocks: ['b000-006', 'b007-012', 'b013-018', 'b019-024'], truncated: true });
	buildAll(r00, 'arome0025');
	assert.equal(publication(s, r00, T0 + 3 * H)?.truncated, false);
});

void test('AROME-OM, landing up to eight hours after its run, publishes truncated only past ten', () => {
	const s = emptyState('aromeomindien');
	trackRuns(s, T0 + 4 * H);
	const r00 = s.runs.find((r) => r.run === '2026-10-06T00:00:00Z')!;
	assert.deepEqual(Object.keys(r00.blocks), ['b000-006', 'b007-012', 'b013-018', 'b019-024', 'b025-030', 'b031-036', 'b037-042', 'b043-048']);
	for (const name of ['b000-006', 'b007-012', 'b013-018', 'b019-024']) {
		r00.blocks[name] = { status: 'built', attempts: 0, receipt: receipt('aromeomindien', r00.run, 0, 0, name) };
	}
	// A run on time lands whole by about 8 h: no truncated publication then.
	assert.equal(publication(s, r00, T0 + 8 * H + 30 * 60_000), null);
	assert.deepEqual(publication(s, r00, T0 + 10 * H + 1), { blocks: ['b000-006', 'b007-012', 'b013-018', 'b019-024'], truncated: true });
	// Served, it is stale only past 18 h: its successor six hours on is
	// published by about 14.3 h.
	r00.status = 'published';
	assert.equal(staleness(s, T0 + 17 * H), '');
	assert.match(staleness(s, T0 + 19 * H), /h old/);
});

void test('a job takes about 2 GB of source, a whole IFS run in two', () => {
	const jobs = Object.fromEntries(MODEL_IDS.map((m) => [m, blocksPerJob(MODELS[m])]));
	assert.deepEqual(jobs, {
		arome0025: 3,
		aromeomantil: 4,
		aromeomguyane: 8,
		aromeomindien: 2,
		aromeomncaled: 8,
		aromeompolyn: 8,
		arpege01: 3,
		ifs025: 12,
	});
});

void test('the pointer keeps three runs newest first and a week of first blocks; retention frees the rest', () => {
	const runs: RunState[] = [];
	let p = null as ReturnType<typeof nextPointer> | null;
	const prevs: (ReturnType<typeof nextPointer> | null)[] = [];
	for (let k = 0; k < 5; k++) {
		const run: RunState = { run: new Date(T0 + k * 3 * H).toISOString().replace('.000Z', 'Z'), status: 'collecting', blocks: {}, seenAt: 0 };
		buildAll(run, 'arome0025');
		runs.push(run);
		prevs.push(p);
		p = nextPointer(p, 'arome0025', run, Object.keys(run.blocks), false, T0 + k * 3 * H + 4 * H);
	}
	assert.deepEqual(p!.runs.map((r) => r.run), ['2026-10-06T12:00:00Z', '2026-10-06T09:00:00Z', '2026-10-06T06:00:00Z']);
	assert.equal(p!.past.length, 5);
	assert.equal(p!.runs[0].blocks.length, 9);
	assert.equal(p!.runs[0].horizon, 51);
	// The last publication let go of the 03Z run's blocks but its first.
	const freed = released(prevs[4], p!);
	assert.equal(freed.length, 8);
	assert.ok(freed.every((k) => k.startsWith('2026-10-06T03:00:00Z/') && !k.endsWith('b000-006')));
	// A run older than the newest served joins only the past.
	const late: RunState = { run: '2026-10-05T21:00:00Z', status: 'collecting', blocks: {}, seenAt: 0 };
	buildAll(late, 'arome0025');
	const after = nextPointer(p, 'arome0025', late, Object.keys(late.blocks), false, T0 + 17 * H);
	assert.deepEqual(after.runs.map((r) => r.run), p!.runs.map((r) => r.run));
	assert.equal(after.past[after.past.length - 1].run, '2026-10-05T21:00:00Z');
	// A week on, the past forgets.
	const week = nextPointer(after, 'arome0025', runs[4], Object.keys(runs[4].blocks), false, T0 + 7 * 24 * H + 10 * H);
	assert.deepEqual(week.past.map((x) => x.run), [runs[4].run]);
});

void test('staleness: overdue runs and repeated failures', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + H);
	assert.equal(staleness(s, T0 + 2 * H), '');
	assert.match(staleness(s, T0 + 12 * H), /no run published/);
	s.runs[s.runs.length - 1].status = 'published';
	assert.equal(staleness(s, T0 + 9 * H), '');
	assert.match(staleness(s, T0 + 11 * H), /h old/);
	s.failedRuns = 2;
	assert.match(staleness(s, T0 + 2 * H), /given up/);
});

void test('a retry after a fix hands the failed blocks of collecting runs their attempts back', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + H);
	const older = s.runs[0];
	older.blocks[Object.keys(older.blocks)[0]] = { status: 'failed', attempts: MAX_ATTEMPTS, error: 'old' };
	const run = s.runs[s.runs.length - 1];
	const names = Object.keys(run.blocks);
	run.blocks[names[0]] = { status: 'failed', attempts: MAX_ATTEMPTS, error: 'store refused' };
	run.blocks[names[1]] = { status: 'built', attempts: 1, receipt: receipt('arome0025', run.run, 7, 12, 'k') };
	const done: RunState = { run: '2026-10-05T21:00:00Z', status: 'abandoned', blocks: { b000: { status: 'failed', attempts: 3 } }, seenAt: 0 };
	// A run published truncated is still being built: its later blocks are
	// retried too (IFS 18Z on 2026-10-07, every block past +90 h failed).
	const truncated: RunState = { run: '2026-10-05T18:00:00Z', status: 'truncated', blocks: { b087: { status: 'failed', attempts: 3, error: 'gust' } }, seenAt: 0 };
	s.runs.push(done, truncated);
	assert.equal(retryFailed(s), 2);
	assert.deepEqual(run.blocks[names[0]], { status: 'waiting', attempts: 0 });
	assert.equal(run.blocks[names[1]].status, 'built');
	assert.equal(done.blocks.b000.status, 'failed');
	assert.deepEqual(truncated.blocks.b087, { status: 'waiting', attempts: 0 });
	// A run older than the one served is never built again: left alone.
	assert.equal(older.blocks[Object.keys(older.blocks)[0]].status, 'failed');
});

void test('receipts: only this job\'s account of the block counts', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + 4 * H);
	const r00 = s.runs.find((r) => r.run === '2026-10-06T00:00:00Z')!;
	const job = { run: r00.run, blocks: ['b007-012'], started: T0 + 4 * H };
	const ok = receipt('arome0025', r00.run, 7, 12, 'blocks/arome0025/2026100600/b007-012.0123456789ab.pmtiles');
	assert.ok(receiptFits(s, job, 'b007-012', ok));
	assert.ok(receiptFits(s, job, 'b007-012', { ...ok, key: 'blocks/arome0025/2026100600/b007-012.pmtiles' }), 'a key from before VersionedKey');
	for (const [why, bad] of [
		['another model', { ...ok, model: 'arpege01' }],
		['other hours', { ...ok, first: 13, last: 18 }],
		['a key elsewhere', { ...ok, key: 'latest/arome0025.json' }],
		['another block\'s key', { ...ok, key: 'blocks/arome0025/2026100600/b013-018.pmtiles' }],
		['a build older than the job', { ...ok, built: new Date(T0).toISOString() }],
	] as const) {
		assert.equal(receiptFits(s, job, 'b007-012', bad), false, why);
	}
});

void test('a job the Container never started charges nothing', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + 4 * H);
	const r00 = s.runs.find((r) => r.run === '2026-10-06T00:00:00Z')!;
	applyDiscovery(r00, new Set(['b000-006', 'b007-012']));
	const job = nextJob(s, T0 + 4 * H)!;
	startJob(s, job);
	const fitting = receipt('arome0025', r00.run, 0, 6, 'first/arome0025/2026100600.0123456789ab.pmtiles');
	finishJob(s, new Map([['b000-006', fitting]]), null, 'unstarted');
	assert.deepEqual(r00.blocks['b000-006'], { status: 'ready', attempts: 0 }, 'nothing it may have left counts');
	assert.deepEqual(r00.blocks['b007-012'], { status: 'ready', attempts: 0 });
	assert.equal(s.job, null);
});

const STOP = '2026/10/08 01:02:03 stopped: before b007-012';

void test('a job stopped on request keeps what it built and charges nothing', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + 4 * H);
	const r00 = s.runs.find((r) => r.run === '2026-10-06T00:00:00Z')!;
	applyDiscovery(r00, new Set(['b000-006', 'b007-012', 'b013-018']));
	const job = nextJob(s, T0 + 4 * H)!;
	assert.deepEqual(job.blocks, ['b000-006', 'b007-012', 'b013-018']);
	startJob(s, job);
	const built = receipt('arome0025', r00.run, 0, 6, 'first/arome0025/2026100600.0123456789ab.pmtiles');
	finishJob(s, new Map([['b000-006', built], ['b007-012', null], ['b013-018', null]]), STOP, 'stopped');
	assert.equal(r00.blocks['b000-006'].status, 'built', 'the block it finished counts');
	assert.deepEqual(r00.blocks['b007-012'], { status: 'ready', attempts: 0, stops: 1 }, 'the first block left counts the stop, uncharged');
	assert.deepEqual(r00.blocks['b013-018'], { status: 'ready', attempts: 0 });
	assert.equal(s.job, null);
});

void test('a block stopped again and again is charged like a failure from MAX_STOPS', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + 4 * H);
	const r00 = s.runs.find((r) => r.run === '2026-10-06T00:00:00Z')!;
	applyDiscovery(r00, new Set(['b000-006']));
	const b = r00.blocks['b000-006'];
	for (let n = 1; n < MAX_STOPS; n++) {
		startJob(s, nextJob(s, T0 + 4 * H)!);
		finishJob(s, new Map(), STOP, 'stopped');
		assert.deepEqual(b, { status: 'ready', attempts: 0, stops: n });
	}
	startJob(s, nextJob(s, T0 + 4 * H)!);
	finishJob(s, new Map(), STOP, 'stopped');
	assert.deepEqual(b, { status: 'failed', attempts: 1, error: STOP }, 'charged once, the count starting over');
	// Built, or retried after a fix, it starts over too.
	b.stops = 1;
	retryFailed(s);
	assert.equal(b.stops, undefined);
	applyDiscovery(r00, new Set(['b000-006']));
	b.stops = 2;
	const job = nextJob(s, T0 + 4 * H)!;
	startJob(s, job);
	finishJob(s, new Map([['b000-006', receipt('arome0025', r00.run, 0, 6, 'first/arome0025/2026100600.0123456789ab.pmtiles')]]), null, 'stopped');
	assert.equal(b.status, 'built');
	assert.equal(b.stops, undefined);
});

void test('how a job ended: its exit status, or its own log\'s last line', () => {
	assert.equal(jobEnd(EXIT_STOPPED), 'stopped');
	// What the runtime may report for a stop it signalled, or invent for a
	// lost monitor: the job's own log settles it.
	for (const code of [0, 15, 143, null, undefined]) {
		assert.equal(jobEnd(code, STOP), 'stopped', `exit ${code} with the stop's line`);
		assert.equal(jobEnd(code), 'exited', `exit ${code} alone`);
	}
	assert.equal(jobEnd(1, '2026/10/08 01:02:03 error: arome0025 2026100600 b007-012: HTTP 404'), 'exited');
	assert.equal(jobEnd(0, '2026/10/08 01:02:03 ok'), 'exited');
	assert.equal(jobEnd(0, 'stopped: before b007-012'), 'exited', 'only the line nwp writes, its stamp first');
	assert.ok(STOPPED_LINE.test(STOP));
});

void test('a log or a receipt is the job\'s own only when stored after the job started', () => {
	const job = { run: '2026-10-06T00:00:00Z', blocks: ['b000-006'], started: T0 + 4 * H };
	assert.equal(writtenByJob(job, T0 + 4 * H - 1), false, 'an earlier job\'s, left under the same key');
	assert.equal(writtenByJob(job, T0 + 4 * H), true);
	assert.equal(writtenByJob(job, T0 + 4 * H + 90_000), true);
});

void test('a job that built nothing holds the next one back, however it ended', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + 4 * H);
	const r00 = s.runs.find((r) => r.run === '2026-10-06T00:00:00Z')!;
	applyDiscovery(r00, new Set(['b000-006', 'b007-012']));
	const fitting = receipt('arome0025', r00.run, 0, 6, 'first/arome0025/2026100600.0123456789ab.pmtiles');
	let now = T0 + 4 * H;
	for (const end of ['exited', 'stopped', 'unstarted'] as const) {
		startJob(s, nextJob(s, now)!);
		paceAfterJob(s, finishJob(s, new Map(), 'exit 1', end), now);
		assert.equal(s.notBefore, now + EMPTY_JOB_PAUSE_MS, end);
		assert.equal(nextJob(s, now + EMPTY_JOB_PAUSE_MS - 1), null, `${end}: no job before the pause ends`);
		now += EMPTY_JOB_PAUSE_MS;
		assert.ok(nextJob(s, now), `${end}: the next once it has`);
	}
	// A job that built a block lets the next start at once.
	startJob(s, nextJob(s, now)!);
	paceAfterJob(s, finishJob(s, new Map([['b000-006', fitting]]), 'exit 1'), now);
	assert.equal(s.notBefore, undefined);
	assert.ok(nextJob(s, now));
	// The operator's retry is no job's failure: nothing holds it back.
	s.notBefore = now + EMPTY_JOB_PAUSE_MS;
	retryFailed(s);
	assert.equal(s.notBefore, undefined);
	// Nor does a fresh start.
	s.notBefore = now + EMPTY_JOB_PAUSE_MS;
	assert.equal(freshState(s, 'arome0025', 'e').notBefore, undefined);
});

void test('an IFS job takes twelve blocks: a 06Z run whole, a 00Z one in two', () => {
	assert.equal(blocksPerJob(MODELS.ifs025), 12);
	assert.equal(blocksPerJob(MODELS.arome0025), 3);
	assert.equal(blocksPerJob(MODELS.arpege01), 3);
	for (const [hour, jobs] of [
		[0, [12, 9]],
		[6, [12]],
	] as const) {
		const s = emptyState('ifs025');
		trackRuns(s, T0 + (hour + 8) * H);
		const run = s.runs.find((r) => Date.parse(r.run) === T0 + hour * H)!;
		applyDiscovery(run, new Set(Object.keys(run.blocks)));
		const sizes: number[] = [];
		for (let job = nextJob(s, T0); job; job = nextJob(s, T0)) {
			sizes.push(job.blocks.length);
			startJob(s, job);
			for (const name of job.blocks) {
				run.blocks[name].status = 'built';
			}
			s.job = null;
		}
		assert.deepEqual(sizes, jobs, `${hour}Z`);
	}
});

void test('a run records when its first blocks were found, once', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + 4 * H);
	const r00 = s.runs.find((r) => r.run === '2026-10-06T00:00:00Z')!;
	applyDiscovery(r00, new Set(), T0 + 3 * H);
	assert.equal(r00.readyAt, undefined, 'nothing found yet');
	applyDiscovery(r00, new Set(['b000-006']), T0 + 3 * H + 60_000);
	applyDiscovery(r00, new Set(['b000-006', 'b007-012']), T0 + 4 * H);
	assert.equal(r00.readyAt, T0 + 3 * H + 60_000);
});

void test('a tick lists the three newest runs still being built, the oldest first', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + 7 * H);
	assert.deepEqual(
		runsToList(s).map((r) => r.run.slice(11, 13)),
		['00', '03', '06'],
	);
	// A run whose blocks were all found is not listed again.
	const r03 = s.runs.find((r) => r.run === '2026-10-06T03:00:00Z')!;
	applyDiscovery(r03, new Set(Object.keys(r03.blocks)));
	assert.deepEqual(
		runsToList(s).map((r) => r.run.slice(11, 13)),
		['00', '06'],
	);
});

void test('a new STATE_EPOCH starts an orchestrator afresh, once, after its job', () => {
	const s: ModelState = emptyState('arpege01');
	assert.ok(stateStands(s, ''), 'no epoch reads as the empty one');
	assert.ok(!stateStands(s, '2026-10-08-weur'));
	s.stateEpoch = '2026-10-08-weur';
	assert.ok(stateStands(s, '2026-10-08-weur'));
	s.job = { run: '2026-10-06T00:00:00Z', blocks: ['b000-012'], started: T0 };
	assert.ok(stateStands(s, '2026-10-09-restore'), 'a recorded job is collected first');
	s.job = null;
	assert.ok(!stateStands(s, '2026-10-09-restore'));

	trackRuns(s, T0 + 8 * H);
	s.failedRuns = 1;
	s.lastError = 'listing: HTTP 503';
	s.retryEpoch = 'r';
	s.mailTest = 'm';
	s.alert = { stale: true, lastMail: T0, reason: 'old' };
	const f = freshState(s, 'arpege01', '2026-10-09-restore');
	assert.deepEqual(f.runs, []);
	assert.equal(f.job, null);
	assert.equal(f.failedRuns, 0);
	assert.equal(f.lastError, null);
	assert.equal(f.stateEpoch, '2026-10-09-restore');
	assert.equal(f.retryEpoch, 'r', 'a retry already given is not given again');
	assert.equal(f.mailTest, 'm', 'a test mail already sent is not sent again');
	assert.deepEqual(f.alert, s.alert);
	assert.notEqual(f.alert, s.alert);
	assert.deepEqual(freshState(undefined, 'ifs025', 'e'), { ...emptyState('ifs025'), stateEpoch: 'e' });
});

// The two sides of the stop agree: the Go command's exit status and the
// status line it writes, read as text (Go cannot be imported here).
void test('the stop\'s exit status and line are the ones nwp ingest writes', () => {
	const src = readFileSync(join(FIXTURES, '..', '..', '..', 'cmd', 'nwp', 'ingest.go'), 'utf8');
	assert.equal(Number(/^const exitStopped = (\d+)$/m.exec(src)?.[1]), EXIT_STOPPED);
	assert.match(src, /return "stopped: " \+ se\.detail/);
	assert.match(src, /time\.Now\(\)\.UTC\(\)\.Format\("2006\/01\/02 15:04:05"\) \+ " " \+ status/);
});

// A rollout leaves a job alone until it has run this long: past the cap and
// the tick that kills a job over it, so no rollout signals a job the
// orchestrator has not already judged.
void test('every model\'s orchestrator can start its container: the instance cap holds them all', () => {
	const toml = readFileSync(join(FIXTURES, '..', '..', 'wrangler.toml'), 'utf8');
	const cap = Number(/^max_instances = (\d+)$/m.exec(toml)?.[1]);
	assert.ok(cap >= MODEL_IDS.length, `max_instances ${cap} for ${MODEL_IDS.length} models`);
});

void test('the rollout grace outlasts a job\'s cap and the tick that enforces it', () => {
	const toml = readFileSync(join(FIXTURES, '..', '..', 'wrangler.toml'), 'utf8');
	const grace = Number(/^rollout_active_grace_period = (\d+)$/m.exec(toml)?.[1]);
	assert.ok(grace * 1000 >= JOB_CAP_MS + 7 * 60_000, `rollout_active_grace_period ${grace} s`);
});

// A Container job's own deadline (cmd/nwp, read as text) stands behind the
// orchestrator's cap and ahead of everything else that could end it: it
// never fires while a tick a minute enforces the cap, and with its backstop
// the process is gone before a rollout signals it and before the
// library's inactivity timeout would.
void test('a job\'s own deadline lies past the cap, and with its backstop short of the rollout grace and the inactivity timeout', () => {
	const go = readFileSync(join(FIXTURES, '..', '..', '..', 'cmd', 'nwp', 'ingest.go'), 'utf8');
	const minutes = (name: string): number => Number(new RegExp(`^const ${name} = (\\d+) \\* time\\.Minute$`, 'm').exec(go)?.[1]) * 60_000;
	const deadline = minutes('defaultDeadline');
	const backstop = minutes('deadlineBackstop');
	assert.equal(Number(/^const exitDeadline = (\d+)$/m.exec(go)?.[1]), EXIT_DEADLINE);
	assert.ok(deadline > JOB_CAP_MS + 60_000, `deadline ${deadline / 60_000} min against the cap and its tick`);
	const toml = readFileSync(join(FIXTURES, '..', '..', 'wrangler.toml'), 'utf8');
	const grace = Number(/^rollout_active_grace_period = (\d+)$/m.exec(toml)?.[1]) * 1000;
	assert.ok(deadline + backstop < grace, `deadline + backstop ${(deadline + backstop) / 60_000} min against the rollout grace`);
	const ts = readFileSync(join(FIXTURES, '..', '..', 'src', 'ingest.ts'), 'utf8');
	const sleepAfter = Number(/override sleepAfter = '(\d+)m';/.exec(ts)?.[1]) * 60_000;
	assert.ok(deadline + backstop < sleepAfter, `deadline + backstop against sleepAfter ${sleepAfter / 60_000} min`);
	assert.ok(backstop > 90_000, 'the backstop outlasts the log\'s store at its slowest');
	// The status line it writes, as jobLog.finish stamps it.
	assert.match(go, /return fmt\.Sprintf\("ran past its %v deadline", e\.after\)/);
	assert.match(go, /return "error: " \+ err\.Error\(\)/);
	assert.match('2026/10/09 07:15:00 error: ran past its 15m0s deadline', DEADLINE_LINE);
	assert.doesNotMatch('2026/10/09 07:15:00 error: ran past its 15m0s deadline', STOPPED_LINE);
	assert.equal(jobEnd(EXIT_DEADLINE, '2026/10/09 07:15:00 error: ran past its 15m0s deadline'), 'exited', 'charged like a failure');
});

void test('a truncated run whose later blocks failed for good is stale, and a truncated publication is no recovery', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + 4 * H);
	const r00 = s.runs.find((r) => r.run === '2026-10-06T00:00:00Z')!;
	r00.status = 'truncated';
	assert.equal(staleness(s, T0 + 9 * H), '');
	r00.blocks['b049-051'] = { status: 'failed', attempts: MAX_ATTEMPTS, error: 'IFS index: 45 of the 46 wanted fields indexed' };
	assert.match(staleness(s, T0 + 9 * H), /truncated, 1 block\(s\) failed for good \(b049-051: IFS index/);
});

void test('a whole run served is never replaced by a truncated publication of it', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + 4 * H);
	const r00 = s.runs.find((r) => r.run === '2026-10-06T00:00:00Z')!;
	buildAll(r00, 'arome0025');
	const whole = nextPointer(null, 'arome0025', r00, Object.keys(r00.blocks), false, T0 + 5 * H);
	const again = nextPointer(whole, 'arome0025', r00, ['b000-006', 'b007-012', 'b013-018', 'b019-024'], true, T0 + 9 * H);
	assert.equal(again, whole);
	assert.deepEqual(released(whole, again), []);
});

void test('a state lost is seeded from the pointer: served runs are not built again', () => {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + 4 * H);
	const r00 = s.runs.find((r) => r.run === '2026-10-06T00:00:00Z')!;
	buildAll(r00, 'arome0025');
	const p = nextPointer(null, 'arome0025', r00, ['b000-006', 'b007-012', 'b013-018', 'b019-024'], true, T0 + 9 * H);
	const lost = emptyState('arome0025');
	seedFromPointer(lost, p, T0 + 10 * H);
	trackRuns(lost, T0 + 10 * H);
	const seeded = lost.runs.find((r) => r.run === r00.run)!;
	assert.equal(seeded.status, 'truncated');
	assert.equal(seeded.blocks['b000-006'].status, 'built');
	assert.equal(seeded.blocks['b000-006'].verified, true);
	assert.equal(seeded.blocks['b025-030'].status, 'waiting');
	// Its later blocks are built and it publishes whole, the served ones kept.
	for (const name of ['b025-030', 'b031-036', 'b037-042', 'b043-048', 'b049-051']) {
		seeded.blocks[name] = r00.blocks[name];
	}
	const pub = publication(lost, seeded, T0 + 11 * H);
	assert.deepEqual(pub?.truncated, false);
	const next = nextPointer(p, 'arome0025', seeded, pub?.blocks ?? [], false, T0 + 11 * H);
	assert.deepEqual(released(p, next), []);
});

// A job started on the 00Z run at T0 + 4 h, its blocks given.
function withJob(blocks: string[]): { s: ModelState; r00: RunState } {
	const s = emptyState('arome0025');
	trackRuns(s, T0 + 4 * H);
	const r00 = s.runs.find((r) => r.run === '2026-10-06T00:00:00Z')!;
	applyDiscovery(r00, new Set(blocks));
	startJob(s, nextJob(s, T0 + 4 * H)!);
	return { s, r00 };
}

void test('a job\'s container time is charged to its UTC day, whatever ended it', () => {
	const { s, r00 } = withJob(['b000-006', 'b007-012', 'b013-018']);
	assert.deepEqual(closeJob(s, { receipts: new Map(), error: 'exit 1', end: 'exited' }, T0 + 4 * H + 3 * 60_000), { built: 0, overrun: null });
	assert.deepEqual(s.usage, { day: '2026-10-06', ms: 3 * 60_000, jobs: 1 });
	assert.equal(r00.blocks['b000-006'].attempts, 1);
	// A start the library refused: its seconds, or the whole job it waited
	// on, charged all the same, and never an attempt.
	startJob(s, nextJob(s, T0 + 5 * H)!);
	closeJob(s, { receipts: new Map(), error: null, end: 'unstarted' }, T0 + 5 * H + 20_000);
	assert.deepEqual(s.usage, { day: '2026-10-06', ms: 3 * 60_000 + 20_000, jobs: 2 });
	assert.equal(r00.blocks['b000-006'].attempts, 1, 'a start refused charges no attempt');
	// The next UTC day starts afresh, and the day before reads as none.
	startJob(s, nextJob(s, T0 + 23 * H + 59 * 60_000)!);
	closeJob(s, { receipts: new Map(), error: null, end: 'exited' }, T0 + 24 * H + 60_000);
	assert.deepEqual(s.usage, { day: '2026-10-07', ms: 2 * 60_000, jobs: 1 });
	assert.deepEqual(usageToday(s, T0 + 48 * H), { day: '2026-10-08', ms: 0, jobs: 0 });
	// A job stamped after its close (clocks) charges nothing, never less.
	const t = T0 + 30 * H;
	s.job = { run: r00.run, blocks: ['b007-012'], started: t + 5_000 };
	closeJob(s, { receipts: new Map(), error: null, end: 'unstarted' }, t);
	assert.deepEqual(s.usage, { day: '2026-10-07', ms: 2 * 60_000, jobs: 2 });
});

void test('a job killed past its cap is recorded, paced and reported as an overrun', () => {
	const { s, r00 } = withJob(['b000-006']);
	const end = T0 + 4 * H + 13 * 60_000;
	const c = closeJob(s, { receipts: new Map([['b000-006', null]]), error: 'killed past the job cap', end: 'exited', killed: true }, end);
	assert.deepEqual(c, { built: 0, overrun: 'overCap' });
	assert.equal(r00.blocks['b000-006'].status, 'failed');
	assert.equal(r00.blocks['b000-006'].attempts, 1);
	assert.equal(s.job, null);
	assert.equal(s.notBefore, end + EMPTY_JOB_PAUSE_MS);
	assert.deepEqual(s.usage, { day: '2026-10-06', ms: 13 * 60_000, jobs: 1 });
	assert.deepEqual(closeJob(s, { receipts: new Map(), error: null, end: 'exited' }, end + H), { built: 0, overrun: null }, 'no job, nothing to close');
	assert.equal(s.usage?.jobs, 1);
});

void test('a job overran its cap when killed or past the cap and a tick, its own deadline when it says so, never when stopped', () => {
	const job = { run: '2026-10-06T00:00:00Z', blocks: ['b000-006'], started: T0 };
	const line = '2026/10/06 00:15:00 error: ran past its 15m0s deadline';
	assert.equal(overran(job, T0 + 5 * 60_000, false), null);
	assert.equal(overran(job, T0 + JOB_CAP_MS + 60_000, false), null, 'up to the cap and its tick');
	assert.equal(overran(job, T0 + JOB_CAP_MS + 60_001, false), 'overCap', 'the inactivity timeout\'s kill, known by the time');
	assert.equal(overran(job, T0 + 12.5 * 60_000, true), 'overCap', 'the tick\'s kill');
	assert.equal(overran(job, T0 + 15 * 60_000, false, EXIT_DEADLINE), 'deadline');
	assert.equal(overran(job, T0 + 15 * 60_000, false, null, line), 'deadline', 'a lost monitor: the log says it');
	assert.equal(overran(job, T0 + 16 * 60_000, true, EXIT_DEADLINE), 'deadline', 'the deadline\'s evidence wins');
	assert.equal(overran(job, T0 + 14 * 60_000, false, EXIT_STOPPED), null, 'a stop never counts');
	assert.equal(overran(job, T0 + 14 * 60_000, false, 0, STOP), null);
});

void test('a spent budget holds the model\'s jobs until 00:00 UTC, and the status page says so', () => {
	const budget = jobBudgetMs(undefined);
	assert.equal(budget, 90 * 60_000);
	const s = emptyState('arome0025');
	s.usage = { day: '2026-10-06', ms: budget, jobs: 30 };
	assert.equal(budgetSpent(s, budget, T0 + 23 * H), true);
	assert.deepEqual(budgetStatus(s, budget, T0 + 23 * H), { usageMin: 90, usageJobs: 30, budgetMin: 90, budgetHeld: true });
	assert.equal(budgetSpent(s, budget, T0 + 24 * H), false, 'the next UTC day lifts it');
	assert.deepEqual(budgetStatus(s, budget, T0 + 24 * H), { usageMin: 0, usageJobs: 0, budgetMin: 90, budgetHeld: false });
	s.usage.ms = budget - 1;
	assert.equal(budgetSpent(s, budget, T0 + 23 * H), false);
	assert.equal(budgetSpent(emptyState('ifs025'), 0, T0), true, '0 holds every job');
	assert.deepEqual(budgetStatus(null, budget, T0), { usageMin: 0, usageJobs: 0, budgetMin: 90, budgetHeld: false });
});

void test('the budget lever reads whole minutes, anything else the default the toml states', () => {
	for (const [raw, min] of [['0', 0], ['90', 90], [' 30 ', 30], ['', 90], ['-5', 90], ['1.5', 90], ['x', 90], [undefined, 90]] as const) {
		assert.equal(jobBudgetMs(raw), min * 60_000, String(raw));
	}
	const toml = readFileSync(join(FIXTURES, '..', '..', 'wrangler.toml'), 'utf8');
	assert.equal(/^JOB_BUDGET_MINUTES = "(\d+)"$/m.exec(toml)?.[1], String(JOB_BUDGET_MINUTES));
});

void test('a notice is mailed once a UTC day per kind', () => {
	const s = emptyState('arome0025');
	assert.equal(noticeDue(s, 'overCap', T0 + H), true);
	assert.equal(noticeDue(s, 'overCap', T0 + 2 * H), false);
	assert.equal(noticeDue(s, 'deadline', T0 + 2 * H), true, 'each kind its own');
	assert.equal(noticeDue(s, 'budget', T0 + 3 * H), true);
	assert.equal(noticeDue(s, 'overCap', T0 + 25 * H), true, 'the next day again');
	assert.deepEqual(s.notices, { overCap: '2026-10-07', deadline: '2026-10-06', budget: '2026-10-06' });
});

void test('a fresh state keeps the day\'s usage and notices', () => {
	const s = emptyState('ifs025');
	s.usage = { day: '2026-10-06', ms: 1000, jobs: 1 };
	s.notices = { budget: '2026-10-06' };
	const f = freshState(s, 'ifs025', 'e2');
	assert.deepEqual(f.usage, s.usage);
	assert.notEqual(f.usage, s.usage);
	assert.deepEqual(f.notices, s.notices);
	assert.notEqual(f.notices, s.notices);
});
