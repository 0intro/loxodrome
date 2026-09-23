/* The zero-dependency test harness (the notam-proxy/test posture):
 * node:test drives worker.fetch DIRECTLY, with the D1 binding faked by
 * a ~70-line adapter over Node's built-in node:sqlite and R2 by a Map.
 * The adapter encodes the D1 fidelity pitfalls the plan validation
 * listed: .all() answers {results, success, meta}; batch() wraps its
 * statements in ONE transaction and rolls back wholesale on any error
 * (the worker itself never issues BEGIN/COMMIT); blobs cross as
 * Uint8Array. */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ORIGIN = 'https://loxodrome.fr';

let fresh = 0;

export interface WorkerModule {
	default: {
		fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
		scheduled(controller: unknown, env: unknown, ctx: unknown): void | Promise<void>;
	};
}

/** Import a fresh copy of the worker (module-global rate-limit state
 *  resets per test; the cache keys on the full URL). */
export async function freshWorker(): Promise<WorkerModule> {
	return (await import(`../worker.ts?fresh=${fresh++}`)) as WorkerModule;
}

// --- the D1 adapter --------------------------------------------------------

interface D1Result {
	results: unknown[];
	success: boolean;
	meta: { changes: number; last_row_id: number };
}

interface FakeStatement {
	bind(...args: unknown[]): FakeStatement;
	all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: unknown }>;
	first<T = unknown>(): Promise<T | null>;
	run(): Promise<D1Result>;
	_sql: string;
	_bound: unknown[];
}

export interface FakeD1 {
	prepare(sql: string): FakeStatement;
	batch(stmts: FakeStatement[]): Promise<D1Result[]>;
	/** Test-side escape hatch: raw SQL against the underlying database. */
	_db: DatabaseSync;
}

function runOne(db: DatabaseSync, sql: string, args: unknown[]): D1Result {
	// D1 rejects a bind-count mismatch; node:sqlite would silently bind
	// NULL into the missing slots, which is exactly how an unbound WHERE
	// precondition hides (found the hard way: pinned here so it stays
	// found).
	let maxParam = 0;
	for (const m of sql.matchAll(/\?(\d+)/g)) {
		maxParam = Math.max(maxParam, Number(m[1]));
	}
	if (args.length !== maxParam) {
		throw new Error(`bind mismatch: ${args.length} args for ${maxParam} params`);
	}
	const stmt = db.prepare(sql);
	// D1 binds numbers, strings and nulls; node:sqlite matches. RETURNING
	// rows come back from .all(); everything else reports changes.
	if (/\bRETURNING\b/i.test(sql) || /^\s*SELECT/i.test(sql)) {
		const rows = stmt.all(...(args as never[])) as unknown[];
		return { results: rows, success: true, meta: { changes: 0, last_row_id: 0 } };
	}
	const info = stmt.run(...(args as never[]));
	return {
		results: [],
		success: true,
		meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
	};
}

export function makeD1(): FakeD1 {
	const db = new DatabaseSync(':memory:');
	// EVERY migration, in order: the schema under test is the one
	// `wrangler d1 migrations apply` produces, not the first file alone.
	const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
	for (const name of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
		db.exec(readFileSync(`${dir}${name}`, 'utf8'));
	}
	const make = (sql: string, bound: unknown[]): FakeStatement => ({
		_sql: sql,
		_bound: bound,
		bind: (...args: unknown[]) => make(sql, args),
		all: <T>() => {
			const out = runOne(db, sql, bound);
			return Promise.resolve({ results: out.results as T[], success: true, meta: out.meta });
		},
		first: <T>() => {
			const out = runOne(db, sql, bound);
			return Promise.resolve((out.results[0] as T | undefined) ?? null);
		},
		run: () => Promise.resolve(runOne(db, sql, bound)),
	});
	return {
		prepare: (sql: string) => make(sql, []),
		// ONE transaction, rolled back wholesale on any statement error:
		// D1's own batch contract, and what the worker's seq arithmetic
		// leans on. The worker never issues BEGIN/COMMIT itself.
		batch: (stmts: FakeStatement[]) => {
			db.exec('BEGIN');
			try {
				const out = stmts.map((s) => runOne(db, s._sql, s._bound));
				db.exec('COMMIT');
				return Promise.resolve(out);
			} catch (err) {
				db.exec('ROLLBACK');
				return Promise.reject(err instanceof Error ? err : new Error(String(err)));
			}
		},
		_db: db,
	};
}

// --- the R2 fake -----------------------------------------------------------

export interface FakeR2 {
	put(key: string, value: Uint8Array): Promise<void>;
	get(key: string): Promise<{ body: ReadableStream } | null>;
	/** `size` as R2 reports it: the ledger reads it on the dedupe path
	 *  and the orphan sweep on its backfill. */
	head(key: string): Promise<{ key: string; size: number } | null>;
	delete(keys: string | string[]): Promise<void>;
	list(opts?: { prefix?: string; cursor?: string }): Promise<{
		objects: { key: string; size: number }[];
		truncated: boolean;
		cursor?: string;
	}>;
	store: Map<string, Uint8Array>;
}

export function makeR2(): FakeR2 {
	const store = new Map<string, Uint8Array>();
	return {
		store,
		put: (key, value) => {
			store.set(key, value);
			return Promise.resolve();
		},
		get: (key) => {
			const bytes = store.get(key);
			if (!bytes) {
				return Promise.resolve(null);
			}
			const body = new Blob([bytes as unknown as ArrayBuffer]).stream();
			return Promise.resolve({ body });
		},
		head: (key) => {
			const bytes = store.get(key);
			return Promise.resolve(bytes ? { key, size: bytes.length } : null);
		},
		delete: (keys) => {
			for (const k of Array.isArray(keys) ? keys : [keys]) {
				store.delete(k);
			}
			return Promise.resolve();
		},
		list: (opts) => {
			const prefix = opts?.prefix ?? '';
			const objects = [...store.keys()]
				.filter((k) => k.startsWith(prefix))
				.sort()
				.map((key) => ({ key, size: store.get(key)!.length }));
			return Promise.resolve({ objects, truncated: false });
		},
	};
}

// --- env / ctx / req -------------------------------------------------------

export interface TestEnv {
	DB: FakeD1;
	BLOBS: FakeR2;
	DEV_CODE: string;
	ALLOW_ORIGINS?: string;
	MAX_ACCOUNTS?: string;
	MAX_TOTAL_BYTES?: string;
	[key: string]: unknown;
}

export function makeEnv(over: Partial<TestEnv> = {}): TestEnv {
	return { DB: makeD1(), BLOBS: makeR2(), DEV_CODE: '000000', ...over };
}

export function makeCtx(): { waitUntil(p: Promise<unknown>): void; waits: Promise<unknown>[] } {
	const waits: Promise<unknown>[] = [];
	return {
		waits,
		waitUntil: (p) => {
			waits.push(p);
		},
	};
}

export function req(
	path: string,
	opts: {
		method?: string;
		body?: unknown;
		bytes?: Uint8Array;
		token?: string;
		origin?: string | null;
		ip?: string;
	} = {},
): Request {
	const headers = new Headers();
	if (opts.origin !== null) {
		headers.set('Origin', opts.origin ?? ORIGIN);
	}
	headers.set('CF-Connecting-IP', opts.ip ?? '203.0.113.7');
	if (opts.token) {
		headers.set('Authorization', `Bearer ${opts.token}`);
	}
	let body: RequestInit['body'] | undefined;
	if (opts.bytes) {
		body = opts.bytes;
	} else if (opts.body !== undefined) {
		body = JSON.stringify(opts.body);
		headers.set('Content-Type', 'application/json');
	}
	return new Request(`https://api.loxodrome.fr${path}`, {
		method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
		headers,
		...(body !== undefined ? { body } : {}),
	});
}

export async function jsonOf<T = Record<string, unknown>>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

/** Sign in a fresh account through the real flow; answers the token. */
export async function signIn(
	worker: WorkerModule,
	env: TestEnv,
	email: string,
	over: { mode?: string; deviceName?: string } = {},
): Promise<{ token: string; userId: string; created: boolean; status: string }> {
	const code = await worker.default.fetch(
		req('/v1/auth/code', { body: { email, turnstile: 'x', locale: 'en' } }),
		env,
		makeCtx(),
	);
	if (code.status !== 204) {
		throw new Error(`auth/code answered ${code.status}`);
	}
	const verify = await worker.default.fetch(
		req('/v1/auth/verify', {
			body: {
				email,
				code: env.DEV_CODE,
				deviceName: over.deviceName ?? 'Test device',
				mode: over.mode ?? 'personal',
			},
		}),
		env,
		makeCtx(),
	);
	if (verify.status !== 200) {
		throw new Error(`auth/verify answered ${verify.status}`);
	}
	return jsonOf(verify);
}
