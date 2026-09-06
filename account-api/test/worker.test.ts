/* The account-api worker, driven directly through its fetch handler
 * (the notam-proxy test posture: zero dependencies, no network, D1 on
 * node:sqlite, R2 on a Map). The load-bearing protocol shapes pinned
 * here are the ones docs/accounts-sync.md names: in-SQL seq assignment,
 * the content-hash idempotency short-circuit, tombstones clearing blob
 * refs, the reset horizon, the staged deletion state machine, and the
 * orphans grace clock. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	freshWorker,
	jsonOf,
	makeCtx,
	makeEnv,
	req,
	signIn,
	type TestEnv,
	type WorkerModule,
} from './helpers.ts';

const DAY = 86_400_000;

interface PushResultRow {
	ok: boolean;
	rev?: number;
	seq?: number;
	conflict?: boolean;
	server?: Record<string, unknown> | null;
}

/** PUT one blob of `n` bytes under `hash` (the client's own order:
 *  every blob lands before the doc that references it). */
async function putBlob(
	worker: WorkerModule,
	env: TestEnv,
	token: string,
	hash: string,
	n: number,
): Promise<Response> {
	return worker.default.fetch(
		req(`/v1/blobs/${hash}`, { method: 'PUT', token, bytes: new Uint8Array(n).fill(7) }),
		env,
		makeCtx(),
	);
}

async function push(
	worker: WorkerModule,
	env: TestEnv,
	token: string,
	docs: unknown[],
): Promise<PushResultRow[]> {
	const res = await worker.default.fetch(
		req('/v1/sync/push', { method: 'POST', token, body: { docs } }),
		env,
		makeCtx(),
	);
	assert.equal(res.status, 200, `push answered ${res.status}`);
	return (await jsonOf<{ results: PushResultRow[] }>(res)).results;
}

function planDoc(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		col: 'plans',
		id: 'p1',
		baseRev: 0,
		deleted: false,
		updatedAt: 1000,
		device: 'dev-a',
		hash: 'h1',
		meta: { savedAtMs: 1000 },
		payload: { alg: 'none', data: 'version: 1\n' },
		...over,
	};
}

// --- CORS ------------------------------------------------------------------

void test('preflight answers 204 with the CORS headers', async () => {
	const worker = await freshWorker();
	const res = await worker.default.fetch(
		req('/v1/account', { method: 'OPTIONS' }),
		makeEnv(),
		makeCtx(),
	);
	assert.equal(res.status, 204);
	assert.match(res.headers.get('Access-Control-Allow-Methods') ?? '', /PUT, PATCH, DELETE/);
	assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://loxodrome.fr');
});

void test('a foreign Origin is refused, a missing one passes to the bearer gate', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const foreign = await worker.default.fetch(
		req('/v1/account', { origin: 'https://evil.example' }),
		env,
		makeCtx(),
	);
	assert.equal(foreign.status, 403);
	assert.equal((await jsonOf(foreign)).error, 'origin-not-allowed');
	const bare = await worker.default.fetch(req('/v1/account', { origin: null }), env, makeCtx());
	assert.equal(bare.status, 401);
});

// --- auth ------------------------------------------------------------------

void test('auth/code answers 204 whatever happened', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	for (const email of ['not-an-address', 'pilot@example.org']) {
		const res = await worker.default.fetch(
			req('/v1/auth/code', { body: { email, turnstile: 'x' } }),
			env,
			makeCtx(),
		);
		assert.equal(res.status, 204);
	}
});

void test('the resend cooldown keeps the stored code and its stamp', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const ask = () =>
		worker.default.fetch(
			req('/v1/auth/code', { body: { email: 'pilot@example.org', turnstile: 'x' } }),
			env,
			makeCtx(),
		);
	await ask();
	const first = env.DB._db.prepare('SELECT requested_at FROM login_codes').get() as {
		requested_at: number;
	};
	await ask();
	const second = env.DB._db.prepare('SELECT requested_at FROM login_codes').get() as {
		requested_at: number;
	};
	assert.equal(second.requested_at, first.requested_at);
});

void test('verify creates on first, signs in on second, burns the code', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const first = await signIn(worker, env, 'pilot@example.org');
	assert.equal(first.created, true);
	assert.equal(first.status, 'active');
	const again = await signIn(worker, env, 'pilot@example.org');
	assert.equal(again.created, false);
	assert.equal(again.userId, first.userId);
	// The consumed code is single-use: replaying it refuses.
	const replay = await worker.default.fetch(
		req('/v1/auth/verify', {
			body: { email: 'pilot@example.org', code: '000000', deviceName: 'X', mode: 'personal' },
		}),
		env,
		makeCtx(),
	);
	assert.equal(replay.status, 401);
	assert.equal((await jsonOf(replay)).error, 'code-invalid');
});

void test('five wrong attempts burn the code even for the right guess', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	await worker.default.fetch(
		req('/v1/auth/code', { body: { email: 'pilot@example.org', turnstile: 'x' } }),
		env,
		makeCtx(),
	);
	for (let i = 0; i < 5; i++) {
		const res = await worker.default.fetch(
			req('/v1/auth/verify', {
				body: { email: 'pilot@example.org', code: '999999', deviceName: 'X', mode: 'personal' },
			}),
			env,
			makeCtx(),
		);
		assert.equal(res.status, 401);
	}
	const right = await worker.default.fetch(
		req('/v1/auth/verify', {
			body: { email: 'pilot@example.org', code: '000000', deviceName: 'X', mode: 'personal' },
		}),
		env,
		makeCtx(),
	);
	assert.equal(right.status, 401);
});

void test('a suppressed address gets no code stored', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	// Suppress first (the hash the worker computes for this address).
	await worker.default.fetch(
		req('/v1/auth/code', { body: { email: 'gone@example.org', turnstile: 'x' } }),
		env,
		makeCtx(),
	);
	env.DB._db.exec(
		`INSERT INTO suppressions (email_hash, at, reason)
		SELECT email_hash, 1, 'hard-bounce' FROM login_codes`,
	);
	env.DB._db.exec('DELETE FROM login_codes');
	const res = await worker.default.fetch(
		req('/v1/auth/code', { body: { email: 'gone@example.org', turnstile: 'x' } }),
		env,
		makeCtx(),
	);
	assert.equal(res.status, 204);
	const rows = env.DB._db.prepare('SELECT COUNT(*) AS n FROM login_codes').get() as { n: number };
	assert.equal(rows.n, 0);
});

void test('the per-IP creation cap and the aggregate ceiling answer typed codes', async () => {
	const worker = await freshWorker();
	const env = makeEnv({ MAX_ACCOUNTS: '2' });
	await signIn(worker, env, 'a@example.org');
	await signIn(worker, env, 'b@example.org');
	// Third creation on this IP is still under the creation cap (3/day)
	// but over MAX_ACCOUNTS: service-full.
	await worker.default.fetch(
		req('/v1/auth/code', { body: { email: 'c@example.org', turnstile: 'x' } }),
		env,
		makeCtx(),
	);
	const full = await worker.default.fetch(
		req('/v1/auth/verify', {
			body: { email: 'c@example.org', code: '000000', deviceName: 'X', mode: 'personal' },
		}),
		env,
		makeCtx(),
	);
	assert.equal(full.status, 503);
	assert.equal((await jsonOf(full)).error, 'service-full');
});

// --- account + sessions ----------------------------------------------------

void test('the account view lists usage and the sessions, current marked', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org', { deviceName: 'Desk' });
	const res = await worker.default.fetch(req('/v1/account', { token }), env, makeCtx());
	assert.equal(res.status, 200);
	const body = await jsonOf<{
		email: string;
		quotaBytes: number;
		sessions: { deviceName: string; mode: string; current: boolean }[];
	}>(res);
	assert.equal(body.email, 'pilot@example.org');
	assert.equal(body.quotaBytes, 250 * 1024 * 1024);
	assert.equal(body.sessions.length, 1);
	assert.equal(body.sessions[0].deviceName, 'Desk');
	assert.equal(body.sessions[0].current, true);
});

void test('sign-out kills the token; renaming sticks', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	const rename = await worker.default.fetch(
		req('/v1/sessions/current', { method: 'PATCH', token, body: { deviceName: 'Kneeboard' } }),
		env,
		makeCtx(),
	);
	assert.equal(rename.status, 200);
	const out = await worker.default.fetch(
		req('/v1/sessions/current', { method: 'DELETE', token }),
		env,
		makeCtx(),
	);
	assert.equal(out.status, 200);
	const after = await worker.default.fetch(req('/v1/account', { token }), env, makeCtx());
	assert.equal(after.status, 401);
});

void test('sign-out-everywhere is sudo-gated and revokes every session', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const a = await signIn(worker, env, 'pilot@example.org');
	const b = await signIn(worker, env, 'pilot@example.org');
	const bare = await worker.default.fetch(
		req('/v1/sessions', { method: 'DELETE', token: a.token, body: {} }),
		env,
		makeCtx(),
	);
	assert.equal(bare.status, 403);
	assert.equal((await jsonOf(bare)).error, 'sudo-required');
	// A fresh code arms the sudo.
	await worker.default.fetch(
		req('/v1/auth/code', { body: { email: 'pilot@example.org', turnstile: 'x' } }),
		env,
		makeCtx(),
	);
	const sudo = await worker.default.fetch(
		req('/v1/sessions', { method: 'DELETE', token: a.token, body: { code: '000000' } }),
		env,
		makeCtx(),
	);
	assert.equal(sudo.status, 200);
	for (const t of [a.token, b.token]) {
		const res = await worker.default.fetch(req('/v1/account', { token: t }), env, makeCtx());
		assert.equal(res.status, 401);
	}
});

// --- push / changes --------------------------------------------------------

void test('push creates, updates and detects the stale base', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	const created = await push(worker, env, token, [planDoc()]);
	assert.deepEqual(created[0], { ok: true, rev: 1, seq: 1 });
	const updated = await push(worker, env, token, [
		planDoc({ baseRev: 1, hash: 'h2', payload: { alg: 'none', data: 'version: 2\n' } }),
	]);
	assert.deepEqual(updated[0], { ok: true, rev: 2, seq: 2 });
	const stale = await push(worker, env, token, [
		planDoc({ baseRev: 1, hash: 'h3', payload: { alg: 'none', data: 'version: 3\n' } }),
	]);
	assert.equal(stale[0].ok, false);
	assert.equal(stale[0].conflict, true);
	const server = stale[0].server as { rev: number; hash: string; payload: { data: string } };
	assert.equal(server.rev, 2);
	assert.equal(server.hash, 'h2');
	assert.equal(server.payload.data, 'version: 2\n');
});

void test('a retried push whose intent already stands answers ok, never a conflict', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	await push(worker, env, token, [planDoc()]);
	// The response was lost; the client retries the SAME create.
	const retry = await push(worker, env, token, [planDoc()]);
	assert.deepEqual(retry[0], { ok: true, rev: 1, seq: 1 });
});

void test('a tombstone clears the refs and its retry reads as applied', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	await putBlob(worker, env, token, 'a'.repeat(64), 500);
	await push(worker, env, token, [
		planDoc({
			col: 'outings',
			id: '1735689600000',
			payload: undefined,
			blobs: [{ h: 'a'.repeat(64), n: 500 }],
		}),
	]);
	const dead = await push(worker, env, token, [
		{
			col: 'outings',
			id: '1735689600000',
			baseRev: 1,
			deleted: true,
			updatedAt: 2000,
			device: 'dev-a',
			hash: '',
			meta: {},
		},
	]);
	assert.deepEqual(dead[0], { ok: true, rev: 2, seq: 2 });
	const row = env.DB._db
		.prepare('SELECT deleted, blob_refs, payload FROM docs WHERE doc_id = ?')
		.get('1735689600000') as { deleted: number; blob_refs: null; payload: null };
	assert.equal(row.deleted, 1);
	assert.equal(row.blob_refs, null);
	assert.equal(row.payload, null);
	// The tombstone retry (lost response) is a both-deleted no-op.
	const retry = await push(worker, env, token, [
		{
			col: 'outings',
			id: '1735689600000',
			baseRev: 1,
			deleted: true,
			updatedAt: 2000,
			device: 'dev-a',
			hash: '',
			meta: {},
		},
	]);
	assert.deepEqual(retry[0], { ok: true, rev: 2, seq: 2 });
});

void test('changes pages in seq order and stands still when caught up', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	await push(worker, env, token, [
		planDoc(),
		planDoc({ id: 'p2', hash: 'h2' }),
		planDoc({ col: 'pilot', id: 'pilot', hash: 'h3', payload: { alg: 'none', data: '{}' } }),
	]);
	const res = await worker.default.fetch(req('/v1/sync/changes?since=0', { token }), env, makeCtx());
	const body = await jsonOf<{ seq: number; more: boolean; docs: { id: string; seq: number }[] }>(res);
	assert.equal(body.docs.length, 3);
	assert.equal(body.more, false);
	assert.equal(body.seq, 3);
	const caught = await jsonOf<{ docs: unknown[]; seq: number }>(
		await worker.default.fetch(req(`/v1/sync/changes?since=${body.seq}`, { token }), env, makeCtx()),
	);
	assert.equal(caught.docs.length, 0);
	assert.equal(caught.seq, 3);
});

void test('push validation refuses the malformed and the oversized', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	const bad = await worker.default.fetch(
		req('/v1/sync/push', { method: 'POST', token, body: { docs: [planDoc({ col: 'nope' })] } }),
		env,
		makeCtx(),
	);
	assert.equal(bad.status, 400);
	const fat = await worker.default.fetch(
		req('/v1/sync/push', {
			method: 'POST',
			token,
			body: { docs: [planDoc({ payload: { alg: 'none', data: 'x'.repeat(256 * 1024 + 1) } })] },
		}),
		env,
		makeCtx(),
	);
	assert.equal(fat.status, 413);
	assert.equal((await jsonOf(fat)).error, 'doc-too-large');
});

void test('bytes_used is recomputed from what is actually stored', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	await putBlob(worker, env, token, 'b'.repeat(64), 500);
	await push(worker, env, token, [
		planDoc({ payload: { alg: 'none', data: 'x'.repeat(100) } }),
		planDoc({
			col: 'outings',
			id: 'o1',
			hash: 'ho',
			payload: undefined,
			blobs: [{ h: 'b'.repeat(64), n: 500 }],
		}),
	]);
	const account = await jsonOf<{ bytesUsed: number }>(
		await worker.default.fetch(req('/v1/account', { token }), env, makeCtx()),
	);
	assert.equal(account.bytesUsed, 600);
});

void test('the quota counts the LEDGER, never the size a ref claims', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token, userId } = await signIn(worker, env, 'pilot@example.org');
	await putBlob(worker, env, token, 'b'.repeat(64), 100_000);
	// An under-declared ref: the stored 100,000 bytes must still count.
	await push(worker, env, token, [
		planDoc({ col: 'outings', id: 'o1', hash: 'ho', payload: undefined, blobs: [{ h: 'b'.repeat(64), n: 1 }] }),
	]);
	const account = await jsonOf<{ bytesUsed: number }>(
		await worker.default.fetch(req('/v1/account', { token }), env, makeCtx()),
	);
	assert.equal(account.bytesUsed, 100_000);
	// The nightly drift recompute agrees.
	env.DB._db.prepare('UPDATE users SET bytes_used = 0 WHERE id = ?').run(userId);
	await runCron(worker, env);
	const row = env.DB._db.prepare('SELECT bytes_used FROM users WHERE id = ?').get(userId) as {
		bytes_used: number;
	};
	assert.equal(row.bytes_used, 100_000);
	// A ref to a hash the account never uploaded is a ref to nothing.
	const ghost = await worker.default.fetch(
		req('/v1/sync/push', {
			method: 'POST',
			token,
			body: {
				docs: [
					planDoc({ col: 'outings', id: 'o2', hash: 'hg', payload: undefined, blobs: [{ h: 'c'.repeat(64), n: 1 }] }),
				],
			},
		}),
		env,
		makeCtx(),
	);
	assert.equal(ghost.status, 400);
	assert.equal((await jsonOf(ghost)).error, 'blob-unknown');
});

void test('an object from before the ledger gets its row from R2 at push time', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token, userId } = await signIn(worker, env, 'pilot@example.org');
	// Stored before the ledger existed: in R2, no ledger row.
	env.BLOBS.store.set(`u/${userId}/b/${'d'.repeat(64)}`, new Uint8Array(777));
	await push(worker, env, token, [
		planDoc({ col: 'outings', id: 'o1', hash: 'ho', payload: undefined, blobs: [{ h: 'd'.repeat(64), n: 5 }] }),
	]);
	const account = await jsonOf<{ bytesUsed: number }>(
		await worker.default.fetch(req('/v1/account', { token }), env, makeCtx()),
	);
	assert.equal(account.bytesUsed, 777);
});

void test('the quota refuses a push past the account cap', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token, userId } = await signIn(worker, env, 'pilot@example.org');
	env.DB._db
		.prepare('UPDATE users SET bytes_used = ? WHERE id = ?')
		.run(250 * 1024 * 1024, userId);
	const res = await worker.default.fetch(
		req('/v1/sync/push', { method: 'POST', token, body: { docs: [planDoc()] } }),
		env,
		makeCtx(),
	);
	assert.equal(res.status, 413);
	assert.equal((await jsonOf(res)).error, 'quota-exceeded');
});

// --- blobs -----------------------------------------------------------------

void test('blobs round-trip, dedupe, and 404 when absent', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	const hash = 'c'.repeat(64);
	const bytes = new Uint8Array([76, 1, 0, 42, 43]);
	const put = await worker.default.fetch(
		req(`/v1/blobs/${hash}`, { method: 'PUT', token, bytes }),
		env,
		makeCtx(),
	);
	assert.deepEqual(await jsonOf(put), { ok: true, existed: false });
	const again = await worker.default.fetch(
		req(`/v1/blobs/${hash}`, { method: 'PUT', token, bytes }),
		env,
		makeCtx(),
	);
	assert.deepEqual(await jsonOf(again), { ok: true, existed: true });
	const got = await worker.default.fetch(req(`/v1/blobs/${hash}`, { token }), env, makeCtx());
	assert.equal(got.status, 200);
	assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);
	const missing = await worker.default.fetch(
		req(`/v1/blobs/${'d'.repeat(64)}`, { token }),
		env,
		makeCtx(),
	);
	assert.equal(missing.status, 404);
});

void test('a blob past the quota headroom is refused on its ACTUAL size', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token, userId } = await signIn(worker, env, 'pilot@example.org');
	env.DB._db
		.prepare('UPDATE users SET bytes_used = ? WHERE id = ?')
		.run(250 * 1024 * 1024 - 2, userId);
	const res = await worker.default.fetch(
		req(`/v1/blobs/${'e'.repeat(64)}`, { method: 'PUT', token, bytes: new Uint8Array(10) }),
		env,
		makeCtx(),
	);
	assert.equal(res.status, 413);
	assert.equal((await jsonOf(res)).error, 'quota-exceeded');
});

void test('parked (unreferenced) blob bytes count against the quota at once', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token, userId } = await signIn(worker, env, 'pilot@example.org');
	// First upload parks in orphans with its stored size...
	const first = await worker.default.fetch(
		req(`/v1/blobs/${'a'.repeat(64)}`, { method: 'PUT', token, bytes: new Uint8Array(1000) }),
		env,
		makeCtx(),
	);
	assert.equal(first.status, 200);
	const row = env.DB._db
		.prepare('SELECT n FROM orphans WHERE user_id = ? AND hash = ?')
		.get(userId, 'a'.repeat(64)) as { n: number };
	assert.equal(row.n, 1000);
	// ...so a second upload sees quota minus the parked bytes: with
	// bytes_used raised to one byte under the cap minus those 1000, a
	// 1001-byte blob is refused while a doc-free account would take it.
	env.DB._db
		.prepare('UPDATE users SET bytes_used = ? WHERE id = ?')
		.run(250 * 1024 * 1024 - 2000, userId);
	const second = await worker.default.fetch(
		req(`/v1/blobs/${'b'.repeat(64)}`, { method: 'PUT', token, bytes: new Uint8Array(1001) }),
		env,
		makeCtx(),
	);
	assert.equal(second.status, 413);
	assert.equal((await jsonOf(second)).error, 'quota-exceeded');
	// A push that REFERENCES the parked blob clears its orphans row in
	// the same batch (no double count until the sweep).
	env.DB._db.prepare('UPDATE users SET bytes_used = 0 WHERE id = ?').run(userId);
	const doc = planDoc();
	doc.blobs = [{ h: 'a'.repeat(64), n: 1000 }];
	const pushed = await worker.default.fetch(
		req('/v1/sync/push', { method: 'POST', token, body: { docs: [doc] } }),
		env,
		makeCtx(),
	);
	assert.equal(pushed.status, 200);
	const left = env.DB._db
		.prepare('SELECT COUNT(*) AS n FROM orphans WHERE user_id = ?')
		.get(userId) as { n: number };
	assert.equal(left.n, 0);
});

void test('a since beyond the account seq clamps to a full reset feed', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	await worker.default.fetch(
		req('/v1/sync/push', { method: 'POST', token, body: { docs: [planDoc()] } }),
		env,
		makeCtx(),
	);
	// A registry restored from a stale backup (D1 Time Travel, a rebuilt
	// database) claims a seq the account never reached: the answer is the
	// reset marker plus the whole feed from zero, never an empty page.
	const res = await worker.default.fetch(
		req('/v1/sync/changes?since=999', { token }),
		env,
		makeCtx(),
	);
	assert.equal(res.status, 200);
	const body = await jsonOf<{ reset?: boolean; docs: unknown[] }>(res);
	assert.equal(body.reset, true);
	assert.equal(body.docs.length, 1);
});

// --- staged deletion -------------------------------------------------------

void test('the staged deletion revokes, restricts, restores', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const first = await signIn(worker, env, 'pilot@example.org');
	await push(worker, env, first.token, [planDoc()]);
	// Sudo-gated.
	const bare = await worker.default.fetch(
		req('/v1/account', { method: 'DELETE', token: first.token, body: {} }),
		env,
		makeCtx(),
	);
	assert.equal(bare.status, 403);
	await worker.default.fetch(
		req('/v1/auth/code', { body: { email: 'pilot@example.org', turnstile: 'x' } }),
		env,
		makeCtx(),
	);
	const staged = await worker.default.fetch(
		req('/v1/account', { method: 'DELETE', token: first.token, body: { code: '000000' } }),
		env,
		makeCtx(),
	);
	assert.equal(staged.status, 200);
	// Every session is revoked the moment deletion is asked.
	const dead = await worker.default.fetch(req('/v1/account', { token: first.token }), env, makeCtx());
	assert.equal(dead.status, 401);
	// Signing in during the window works and says pending_delete...
	const again = await signIn(worker, env, 'pilot@example.org');
	assert.equal(again.status, 'pending_delete');
	// ...and everything but /account and /restore refuses, typed.
	const pushRefused = await worker.default.fetch(
		req('/v1/sync/push', { method: 'POST', token: again.token, body: { docs: [planDoc()] } }),
		env,
		makeCtx(),
	);
	assert.equal(pushRefused.status, 403);
	assert.equal((await jsonOf(pushRefused)).error, 'account-pending-delete');
	const restore = await worker.default.fetch(
		req('/v1/account/restore', { method: 'POST', token: again.token, body: {} }),
		env,
		makeCtx(),
	);
	assert.equal(restore.status, 200);
	const back = await push(worker, env, again.token, [
		planDoc({ baseRev: 1, hash: 'h2', payload: { alg: 'none', data: 'version: 2\n' } }),
	]);
	assert.equal(back[0].ok, true);
});

// --- the cron sweeps -------------------------------------------------------

async function runCron(worker: WorkerModule, env: TestEnv): Promise<void> {
	const ctx = makeCtx();
	await worker.default.scheduled({ scheduledTime: Date.now() }, env, ctx);
	await Promise.all(ctx.waits);
}

void test('the purge sweep erases a due account whole, prefix included', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token, userId } = await signIn(worker, env, 'pilot@example.org');
	await push(worker, env, token, [planDoc()]);
	await worker.default.fetch(
		req(`/v1/blobs/${'f'.repeat(64)}`, { method: 'PUT', token, bytes: new Uint8Array(8) }),
		env,
		makeCtx(),
	);
	env.DB._db
		.prepare("UPDATE users SET status = 'pending_delete', delete_after = ? WHERE id = ?")
		.run(Date.now() - 1000, userId);
	await runCron(worker, env);
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 0);
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM docs').get()!.n, 0);
	assert.equal(env.BLOBS.store.size, 0);
});

void test('the tombstone purge moves the horizon and changes answers reset', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	await push(worker, env, token, [planDoc()]);
	await push(worker, env, token, [
		{ col: 'plans', id: 'p1', baseRev: 1, deleted: true, updatedAt: 2000, device: 'd', hash: '', meta: {} },
	]);
	// Retention keys on the SERVER stamp: the client clock a push carries
	// (updated_at) is no evidence of age, so ageing it alone purges
	// nothing...
	env.DB._db
		.prepare('UPDATE docs SET updated_at = ? WHERE deleted = 1')
		.run(Date.now() - 91 * DAY);
	await runCron(worker, env);
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM docs').get()!.n, 1);
	// ...while a row the server itself stamped 91 days ago goes, and a
	// legacy row with no server stamp falls back to the client clock.
	env.DB._db
		.prepare('UPDATE docs SET server_at = ? WHERE deleted = 1')
		.run(Date.now() - 91 * DAY);
	await runCron(worker, env);
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM docs').get()!.n, 0);
	const res = await jsonOf<{ reset?: boolean; docs: unknown[] }>(
		await worker.default.fetch(req('/v1/sync/changes?since=1', { token }), env, makeCtx()),
	);
	assert.equal(res.reset, true);
});

void test('a legacy tombstone with no server stamp still ages on its client clock', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	await push(worker, env, token, [planDoc()]);
	await push(worker, env, token, [
		{ col: 'plans', id: 'p1', baseRev: 1, deleted: true, updatedAt: 2000, device: 'd', hash: '', meta: {} },
	]);
	env.DB._db
		.prepare('UPDATE docs SET server_at = 0, updated_at = ? WHERE deleted = 1')
		.run(Date.now() - 91 * DAY);
	await runCron(worker, env);
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM docs').get()!.n, 0);
});

void test('a dedupe hit re-arms a ticking orphan clock', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token, userId } = await signIn(worker, env, 'pilot@example.org');
	const hash = '9'.repeat(64);
	await putBlob(worker, env, token, hash, 4);
	// Age the clock past the grace, then the second device PUTs the same
	// content (dedupe) right before pushing its doc: the object must
	// survive the sweep in between.
	env.DB._db.prepare('UPDATE orphans SET orphaned_at = ? WHERE user_id = ?').run(Date.now() - 31 * DAY, userId);
	const again = await putBlob(worker, env, token, hash, 4);
	assert.deepEqual(await jsonOf(again), { ok: true, existed: true });
	await runCron(worker, env);
	assert.equal(env.BLOBS.store.has(`u/${userId}/b/${hash}`), true);
});

void test('the orphan sweep graces 30 days, heals on re-reference, then deletes', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token, userId } = await signIn(worker, env, 'pilot@example.org');
	const orphanHash = '1'.repeat(64);
	const keptHash = '2'.repeat(64);
	for (const h of [orphanHash, keptHash]) {
		await worker.default.fetch(
			req(`/v1/blobs/${h}`, { method: 'PUT', token, bytes: new Uint8Array(4) }),
			env,
			makeCtx(),
		);
	}
	await push(worker, env, token, [
		planDoc({ col: 'outings', id: 'o1', hash: 'ho', payload: undefined, blobs: [{ h: keptHash, n: 4 }] }),
	]);
	await runCron(worker, env);
	// First sight: the unreferenced blob is CLOCKED, not deleted.
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM orphans').get()!.n, 1);
	assert.equal(env.BLOBS.store.size, 2);
	// Re-referencing heals the clock.
	await push(worker, env, token, [
		planDoc({
			col: 'outings',
			id: 'o1',
			baseRev: 1,
			hash: 'ho2',
			payload: undefined,
			blobs: [
				{ h: keptHash, n: 4 },
				{ h: orphanHash, n: 4 },
			],
		}),
	]);
	await runCron(worker, env);
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM orphans').get()!.n, 0);
	// Drop the ref again and age the clock past the grace: gone.
	await push(worker, env, token, [
		planDoc({
			col: 'outings',
			id: 'o1',
			baseRev: 2,
			hash: 'ho3',
			payload: undefined,
			blobs: [{ h: keptHash, n: 4 }],
		}),
	]);
	await runCron(worker, env);
	env.DB._db
		.prepare('UPDATE orphans SET orphaned_at = ? WHERE user_id = ?')
		.run(Date.now() - 31 * DAY, userId);
	await runCron(worker, env);
	assert.equal(env.BLOBS.store.has(`u/${userId}/b/${orphanHash}`), false);
	assert.equal(env.BLOBS.store.has(`u/${userId}/b/${keptHash}`), true);
	// The ledger follows the object out.
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM blobs').get()!.n, 1);
});

void test('the orphan sweep backfills the ledger from the listing, sizes included', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { userId } = await signIn(worker, env, 'pilot@example.org');
	env.BLOBS.store.set(`u/${userId}/b/${'e'.repeat(64)}`, new Uint8Array(4321));
	await runCron(worker, env);
	const ledger = env.DB._db.prepare('SELECT n FROM blobs WHERE user_id = ?').get(userId) as { n: number };
	assert.equal(ledger.n, 4321);
	const parked = env.DB._db.prepare('SELECT n FROM orphans WHERE user_id = ?').get(userId) as { n: number };
	assert.equal(parked.n, 4321);
});

void test('the expiry sweep drops dead sessions and spent codes', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	env.DB._db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1000);
	env.DB._db
		.prepare(
			'INSERT INTO login_codes (email_hash, code_hash, expires_at, requested_at, hour_start, day_start) VALUES (?, ?, ?, ?, ?, ?)',
		)
		.run('x', 'y', Date.now() - 1000, 1, 1, 1);
	await runCron(worker, env);
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM login_codes').get()!.n, 0);
	const res = await worker.default.fetch(req('/v1/account', { token }), env, makeCtx());
	assert.equal(res.status, 401);
});

// --- the golden wire fixture -----------------------------------------------

void test('the golden wire fixture replays against the real handler', async () => {
	const { readFileSync } = await import('node:fs');
	const { fileURLToPath } = await import('node:url');
	const fixture = JSON.parse(
		readFileSync(fileURLToPath(new URL('./fixtures/wire.json', import.meta.url)), 'utf8'),
	) as {
		steps: {
			name?: string;
			push?: unknown[];
			changes?: { since: number; full?: boolean };
			expect: unknown;
		}[];
	};
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	for (const step of fixture.steps) {
		if (step.push) {
			const res = await worker.default.fetch(
				req('/v1/sync/push', { method: 'POST', token, body: { docs: step.push } }),
				env,
				makeCtx(),
			);
			assert.equal(res.status, 200, step.name ?? '');
			assert.deepEqual(await jsonOf(res), step.expect, step.name ?? '');
		} else if (step.changes) {
			const res = await worker.default.fetch(
				req(
					`/v1/sync/changes?since=${step.changes.since}${step.changes.full ? '&full=1' : ''}`,
					{ token },
				),
				env,
				makeCtx(),
			);
			assert.equal(res.status, 200, step.name ?? '');
			assert.deepEqual(await jsonOf(res), step.expect, step.name ?? '');
		}
	}
});

void test('an authenticated own-address code request needs no Turnstile', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	env.DB._db.exec('DELETE FROM login_codes');
	delete (env as Record<string, unknown>).DEV_CODE; // real gating from here
	// Unauthenticated with no valid Turnstile: quietly no-op.
	await worker.default.fetch(
		req('/v1/auth/code', { body: { email: 'pilot@example.org', turnstile: 'nope' } }),
		env,
		makeCtx(),
	);
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM login_codes').get()!.n, 0);
	// The bearer vouches for its own address: the code stores.
	await worker.default.fetch(
		req('/v1/auth/code', { token, body: { email: 'pilot@example.org' } }),
		env,
		makeCtx(),
	);
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM login_codes').get()!.n, 1);
	// The bearer vouches for NO OTHER address.
	await worker.default.fetch(
		req('/v1/auth/code', { token, body: { email: 'other@example.org' } }),
		env,
		makeCtx(),
	);
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM login_codes').get()!.n, 1);
});

// --- the second-pass hardening ---------------------------------------------

void test('a full listing pages to its end past the horizon (full=1 continuations)', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	// 250 docs, three pushes (100 per push), then one tombstone aged out
	// of retention: the horizon lands ABOVE the first page's cursor.
	for (let batch = 0; batch < 3; batch++) {
		const docs = [];
		for (let i = 0; i < 100 && batch * 100 + i < 250; i++) {
			const k = batch * 100 + i;
			docs.push(planDoc({ id: `p${k}`, hash: `h${k}` }));
		}
		await push(worker, env, token, docs);
	}
	await push(worker, env, token, [
		{ col: 'plans', id: 'p0', baseRev: 1, deleted: true, updatedAt: 2000, device: 'd', hash: '', meta: {} },
	]);
	env.DB._db.prepare('UPDATE docs SET server_at = ? WHERE deleted = 1').run(Date.now() - 91 * DAY);
	await runCron(worker, env);
	const first = await jsonOf<{ reset?: boolean; more: boolean; seq: number; docs: unknown[] }>(
		await worker.default.fetch(req('/v1/sync/changes?since=0', { token }), env, makeCtx()),
	);
	assert.equal(first.reset, true);
	assert.equal(first.more, true);
	assert.equal(first.docs.length, 200);
	// The naive continuation sits below the horizon and would be clamped
	// back to zero for ever: page one again.
	const naive = await jsonOf<{ reset?: boolean; docs: { id: string }[] }>(
		await worker.default.fetch(req(`/v1/sync/changes?since=${first.seq}`, { token }), env, makeCtx()),
	);
	assert.equal(naive.reset, true);
	assert.equal(naive.docs[0].id, 'p1');
	// The continuation of a full listing says so and reads to the end.
	const rest = await jsonOf<{ reset?: boolean; more: boolean; docs: unknown[] }>(
		await worker.default.fetch(
			req(`/v1/sync/changes?since=${first.seq}&full=1`, { token }),
			env,
			makeCtx(),
		),
	);
	assert.equal(rest.reset, undefined);
	assert.equal(rest.more, false);
	assert.equal(first.docs.length + rest.docs.length, 249);
});

void test('a changes page is bounded by bytes as well as by count', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	const fat = (k: number) => planDoc({ id: `f${k}`, hash: `h${k}`, payload: { alg: 'none', data: 'y'.repeat(250 * 1024) } });
	await push(worker, env, token, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(fat));
	await push(worker, env, token, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map(fat));
	const first = await jsonOf<{ more: boolean; seq: number; docs: unknown[] }>(
		await worker.default.fetch(req('/v1/sync/changes?since=0', { token }), env, makeCtx()),
	);
	assert.equal(first.more, true);
	assert.ok(first.docs.length > 0 && first.docs.length < 20);
	const rest = await jsonOf<{ more: boolean; docs: unknown[] }>(
		await worker.default.fetch(req(`/v1/sync/changes?since=${first.seq}`, { token }), env, makeCtx()),
	);
	assert.equal(rest.more, false);
	assert.equal(first.docs.length + rest.docs.length, 20);
});

void test('parallel wrong guesses cannot exceed the attempt cap', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	await worker.default.fetch(
		req('/v1/auth/code', { body: { email: 'pilot@example.org', turnstile: 'x' } }),
		env,
		makeCtx(),
	);
	const guess = (code: string) =>
		worker.default.fetch(
			req('/v1/auth/verify', { body: { email: 'pilot@example.org', code, deviceName: 'X', mode: 'personal' } }),
			env,
			makeCtx(),
		);
	// Twelve guesses in flight at once, none awaited before the next
	// starts: a read-then-write cap would let every one of them through.
	const results = await Promise.all(Array.from({ length: 12 }, (_, i) => guess(String(100000 + i))));
	for (const r of results) {
		assert.equal(r.status, 401);
	}
	const row = env.DB._db.prepare('SELECT attempts FROM login_codes').get() as { attempts: number };
	assert.equal(row.attempts, 5);
	const right = await guess('000000');
	assert.equal(right.status, 401);
});

void test('a staged deletion past its deadline is sealed: no sign-in, no restore', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token, userId } = await signIn(worker, env, 'pilot@example.org');
	// The operator's immediate deletion (admin/delete.sql): due at once.
	env.DB._db
		.prepare("UPDATE users SET status = 'pending_delete', delete_after = ? WHERE id = ?")
		.run(Date.now() - 1, userId);
	await worker.default.fetch(
		req('/v1/auth/code', { body: { email: 'pilot@example.org', turnstile: 'x' } }),
		env,
		makeCtx(),
	);
	const verify = await worker.default.fetch(
		req('/v1/auth/verify', {
			body: { email: 'pilot@example.org', code: '000000', deviceName: 'X', mode: 'personal' },
		}),
		env,
		makeCtx(),
	);
	assert.equal(verify.status, 403);
	assert.equal((await jsonOf(verify)).error, 'account-pending-delete');
	// A bearer minted earlier cannot cancel it either.
	const restore = await worker.default.fetch(
		req('/v1/account/restore', { method: 'POST', token, body: {} }),
		env,
		makeCtx(),
	);
	assert.equal(restore.status, 403);
	// The sweep claims and purges; a claim refuses the same two doors.
	await runCron(worker, env);
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 0);
});

void test('the purge claims atomically and takes the ledger with the account', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token, userId } = await signIn(worker, env, 'pilot@example.org');
	await putBlob(worker, env, token, 'f'.repeat(64), 8);
	env.DB._db
		.prepare("UPDATE users SET status = 'purging', delete_after = ? WHERE id = ?")
		.run(Date.now() - 1000, userId);
	// A row already claimed by a sweep in progress refuses the bearer.
	const res = await worker.default.fetch(req('/v1/account', { token }), env, makeCtx());
	assert.equal(res.status, 403);
	// The sweep's own claim step finds nothing to claim (already
	// `purging`), so a second sweep does not double-run the purge; reset
	// the row to due and let it run once.
	env.DB._db.prepare("UPDATE users SET status = 'pending_delete' WHERE id = ?").run(userId);
	await runCron(worker, env);
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 0);
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM blobs').get()!.n, 0);
	assert.equal(env.BLOBS.store.size, 0);
});

void test('verify refuses a malformed mode instead of defaulting to 90 days', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	await worker.default.fetch(
		req('/v1/auth/code', { body: { email: 'pilot@example.org', turnstile: 'x' } }),
		env,
		makeCtx(),
	);
	const res = await worker.default.fetch(
		req('/v1/auth/verify', {
			body: { email: 'pilot@example.org', code: '000000', deviceName: 'X', mode: 'forever' },
		}),
		env,
		makeCtx(),
	);
	assert.equal(res.status, 400);
	// The code was not spent on the refusal.
	assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM login_codes').get()!.n, 1);
});

void test('push refuses a non-integer or negative updatedAt', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	// Written as JSON text, not literals: 1e400 is Infinity to the parser
	// and a precision loss to the linter.
	for (const updatedAt of ['1.5', '-1', '1e400']) {
		const res = await worker.default.fetch(
			// Raw JSON text: 1e400 must reach the parser as written (it
			// becomes Infinity), which JSON.stringify would refuse.
			new Request('https://api.loxodrome.fr/v1/sync/push', {
				method: 'POST',
				headers: {
					Origin: 'https://loxodrome.fr',
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: `{"docs":[${JSON.stringify(planDoc()).replace('"updatedAt":1000', `"updatedAt":${updatedAt}`)}]}`,
			}),
			env,
			makeCtx(),
		);
		assert.equal(res.status, 400, `updatedAt ${updatedAt}`);
	}
});

void test('every answer is no-store and nosniff; a 429 carries Retry-After', async () => {
	const worker = await freshWorker();
	const env = makeEnv();
	const { token } = await signIn(worker, env, 'pilot@example.org');
	const account = await worker.default.fetch(req('/v1/account', { token }), env, makeCtx());
	assert.equal(account.headers.get('cache-control'), 'no-store');
	assert.equal(account.headers.get('X-Content-Type-Options'), 'nosniff');
	await putBlob(worker, env, token, 'c'.repeat(64), 5);
	const blob = await worker.default.fetch(req(`/v1/blobs/${'c'.repeat(64)}`, { token }), env, makeCtx());
	assert.equal(blob.headers.get('cache-control'), 'no-store');
	// The auth bucket is 30 a minute per IP: the 31st answers 429 with the
	// header a client library honours.
	let last: Response | null = null;
	for (let i = 0; i < 31; i++) {
		last = await worker.default.fetch(
			req('/v1/auth/code', { body: { email: 'x@example.org', turnstile: 'x' }, ip: '198.51.100.9' }),
			env,
			makeCtx(),
		);
	}
	assert.equal(last!.status, 429);
	assert.match(last!.headers.get('Retry-After') ?? '', /^\d+$/);
});

void test('DEV_CODE beside the Turnstile secret refuses to serve', async () => {
	const worker = await freshWorker();
	const env = makeEnv({ TURNSTILE_SECRET: 'real' });
	const res = await worker.default.fetch(req('/v1/account'), env, makeCtx());
	assert.equal(res.status, 500);
	assert.equal((await jsonOf(res)).error, 'misconfigured');
});
