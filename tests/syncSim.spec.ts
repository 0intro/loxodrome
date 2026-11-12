/* The deterministic simulation harness (docs/accounts-sync.md, Testing):
 * N virtual devices fold syncPass against the in-memory server, replaying
 * the contract's scripted sequences. The risk in a sync system is in
 * SEQUENCES, not shapes, and this is where the invariants are pinned:
 * absence never deletes, tombstones propagate, conflicts keep both sides
 * under `copy` and resolve by clock under `lww`, retries are idempotent,
 * an evicted store heals from the server, and the reset horizon turns a
 * long absence into a full reconcile instead of a delta with holes. */

import { describe, expect, it } from 'vitest';
import { syncPass, type ReplicaDoc, type ReplicaStore, type ReplicaTransport } from '$lib/sync/replicate';
import { contentHashInput, type SyncCollection } from '$lib/sync/model';
import { sha256HexOfText } from '$lib/sync/fingerprint';
import type { SyncRegistry } from '$lib/state/syncRegistry';
import { SimServer } from './helpers/syncSimServer';

interface LocalDoc {
	payloadText: string;
	meta: Record<string, unknown>;
	declaredNonEmpty?: boolean;
}

class SimDevice {
	registry: SyncRegistry;
	readonly local = new Map<string, LocalDoc>();
	readonly refiled: { col: SyncCollection; payloadText: string }[] = [];
	readonly progressLog: [number, number][] = [];
	clock: number;
	unreadable = false;
	applySupersedes = false;

	constructor(
		private readonly server: SimServer,
		readonly deviceId: string,
		clockBase: number,
	) {
		this.clock = clockBase;
		this.registry = { v: 1, deviceId, lastSeq: 0, docs: {}, tombstones: [] };
	}

	set(col: SyncCollection, id: string, payloadText: string, declaredNonEmpty?: boolean): void {
		this.local.set(`${col}/${id}`, {
			payloadText,
			meta: {},
			...(declaredNonEmpty !== undefined ? { declaredNonEmpty } : {}),
		});
	}

	/** The recordSyncTombstone mirror: entry out, tombstone in. */
	delete(col: SyncCollection, id: string): void {
		const key = `${col}/${id}`;
		const entry = this.registry.docs[key];
		this.local.delete(key);
		if (entry) {
			delete this.registry.docs[key];
			this.registry.tombstones.push({ col, id, updatedAt: this.clock++, rev: entry.rev });
		}
	}

	async sync(
		opts: { offline?: boolean; duplicatePush?: boolean; mode?: 'personal' | 'shared' } = {},
	) {
		const store: ReplicaStore = {
			list: () => {
				if (this.unreadable) {
					return Promise.resolve(null);
				}
				const out: ReplicaDoc[] = [...this.local.entries()].map(([key, v]) => {
					const [col, ...rest] = key.split('/');
					return {
						col: col as SyncCollection,
						id: rest.join('/'),
						payloadText: v.payloadText,
						meta: v.meta,
						...(v.declaredNonEmpty !== undefined
							? { declaredNonEmpty: v.declaredNonEmpty }
							: {}),
					};
				});
				return Promise.resolve(out);
			},
			apply: ({ doc, payloadText }) => {
				const key = `${doc.col}/${doc.id}`;
				if (this.applySupersedes && !doc.deleted) {
					return Promise.resolve('superseded' as const);
				}
				if (doc.deleted) {
					this.local.delete(key);
				} else {
					this.local.set(key, { payloadText: payloadText ?? '', meta: doc.meta });
				}
				return Promise.resolve();
			},
			refile: (col, payloadText, meta, origin) => {
				// The deterministic copy id (adapters.refileDoc): a retried
				// pass upserts the same copy instead of minting another.
				const id = `copy-${origin.id}-r${origin.rev}`;
				this.refiled.push({ col, payloadText });
				this.local.set(`${col}/${id}`, { payloadText, meta });
				return Promise.resolve(id);
			},
		};
		const transport: ReplicaTransport = opts.offline
			? {
					changes: () => Promise.reject(new Error('offline')),
					push: () => Promise.reject(new Error('offline')),
					putBlob: () => Promise.reject(new Error('offline')),
				}
			: {
					changes: (since, full) => Promise.resolve(this.server.changes(since, full)),
					push: (docs) => {
						if (opts.duplicatePush) {
							this.server.push(docs); // the lost-response replay
						}
						return Promise.resolve(this.server.push(docs));
					},
					putBlob: (hash, bytes) => {
						this.server.putBlob(hash, bytes);
						return Promise.resolve();
					},
				};
		const out = await syncPass({
			deviceId: this.deviceId,
			mode: opts.mode ?? 'personal',
			now: () => this.clock++,
			registry: this.registry,
			store,
			transport,
			progress: (done, total) => this.progressLog.push([done, total]),
		});
		this.registry = out.registry;
		return out;
	}
}

async function hashOf(payload: string): Promise<string> {
	return sha256HexOfText(contentHashInput(payload));
}

function rig(): { server: SimServer; a: SimDevice; b: SimDevice } {
	const server = new SimServer();
	return {
		server,
		a: new SimDevice(server, 'dev-a', 1_000_000),
		b: new SimDevice(server, 'dev-b', 2_000_000),
	};
}

describe('propagation', () => {
	it('reports upload progress over the dirty docs', async () => {
		const { a } = rig();
		a.set('plans', 'p1', 'v1');
		a.set('plans', 'p2', 'v1');
		a.set('outings', '100', 'row');
		await a.sync();
		expect(a.progressLog).toEqual([
			[0, 3],
			[1, 3],
			[2, 3],
			[3, 3],
		]);
		a.progressLog.length = 0;
		await a.sync(); // clean: nothing to report beyond the empty total
		expect(a.progressLog).toEqual([[0, 0]]);
	});

	it('a doc created on A reaches B, and a delete follows it', async () => {
		const { server, a, b } = rig();
		a.set('plans', 'p1', 'version: 1\n');
		await a.sync();
		expect(server.count()).toBe(1);
		await b.sync();
		expect(b.local.get('plans/p1')?.payloadText).toBe('version: 1\n');
		a.delete('plans', 'p1');
		await a.sync();
		await b.sync();
		expect(b.local.has('plans/p1')).toBe(false);
		expect(server.doc('plans/p1')?.deleted).toBe(true);
	});

	it('an offline pass changes nothing and the retry converges', async () => {
		const { a, b } = rig();
		a.set('plans', 'p1', 'v1');
		await a.sync({ offline: true }).catch(() => undefined);
		expect(a.registry.lastSeq).toBe(0);
		await a.sync();
		await b.sync();
		expect(b.local.size).toBe(1);
	});

	it('an UNREADABLE store skips the pass instead of reading as empty', async () => {
		const { server, a } = rig();
		a.set('plans', 'p1', 'v1');
		await a.sync();
		a.unreadable = true;
		const out = await a.sync();
		expect(out.pushed + out.pulled).toBe(0);
		expect(server.doc('plans/p1')?.deleted).toBe(false);
	});
});

describe('conflicts', () => {
	it('copy keeps both sides of a concurrent plan edit', async () => {
		const { server, a, b } = rig();
		a.set('plans', 'p1', 'base');
		await a.sync();
		await b.sync();
		a.set('plans', 'p1', 'a-edit');
		b.set('plans', 'p1', 'b-edit');
		await a.sync();
		await b.sync(); // pulls A's edit, conflicts, re-files its own
		expect(b.refiled).toHaveLength(1);
		expect(b.local.get('plans/p1')?.payloadText).toBe('a-edit');
		await b.sync(); // the copy pushes
		await a.sync();
		expect(server.live()).toHaveLength(2);
		const texts = [...a.local.values()].map((d) => d.payloadText).sort();
		expect(texts).toEqual(['a-edit', 'b-edit']);
	});

	it('lww resolves a tracked concurrent edit by the clock', async () => {
		const { server, a, b } = rig();
		a.set('acstate', 'tanked-fuel', '{"types":{},"v":1}');
		await a.sync();
		await b.sync();
		a.set('acstate', 'tanked-fuel', 'a-edit');
		b.set('acstate', 'tanked-fuel', 'b-edit');
		await a.sync();
		await b.sync(); // B's clock base is later: B wins, rebases, pushes
		await a.sync();
		expect(a.local.get('acstate/tanked-fuel')?.payloadText).toBe('b-edit');
		expect(server.live()).toHaveLength(1);
	});

	it('lww edit-versus-delete resurrects when the edit is later', async () => {
		const { server, a, b } = rig();
		a.set('outings', '100', 'row-v1');
		await a.sync();
		await b.sync();
		a.delete('outings', '100');
		b.set('outings', '100', 'row-v2');
		await a.sync();
		await b.sync(); // pulls the tombstone, edit is later: rebase-push
		expect(server.doc('outings/100')?.deleted).toBe(false);
		await a.sync();
		expect(a.local.get('outings/100')?.payloadText).toBe('row-v2');
	});

	it('adopting a server tombstone at push time leaves no tracked entry behind', async () => {
		const { server, a, b } = rig();
		const late = new SimDevice(server, 'dev-late', 9_000_000);
		a.set('outings', '100', 'row-v1');
		await a.sync();
		await b.sync();
		await late.sync();
		late.delete('outings', '100'); // the later clock: the delete wins under lww
		await late.sync();
		b.set('outings', '100', 'row-v2');
		await b.sync(); // the push conflicts, the server tombstone is adopted
		expect(b.local.has('outings/100')).toBe(false);
		// A tracked-but-absent key would read as an eviction and widen
		// every later pass to a full listing for nothing.
		expect(b.registry.docs['outings/100']).toBeUndefined();
		expect(server.doc('outings/100')?.deleted).toBe(true);
	});

	it('a non-empty declared beats the clocks on outing rows', async () => {
		const { server, a, b } = rig();
		a.set('outings', '100', 'plain');
		await a.sync();
		await b.sync();
		// A (earlier clock) holds the declared cells; B (later) does not.
		a.set('outings', '100', 'with-declared', true);
		b.set('outings', '100', 'without-declared', false);
		await b.sync();
		await a.sync(); // pull conflict: A's declared side wins, rebases
		await b.sync();
		expect(server.doc('outings/100')?.hash).toBe(await hashOf('with-declared'));
		expect(b.local.get('outings/100')?.payloadText).toBe('with-declared');
	});
});

describe('idempotency', () => {
	it('a lost-response replay never fabricates a conflict copy', async () => {
		const { server, a } = rig();
		a.set('plans', 'p1', 'v1');
		await a.sync({ duplicatePush: true });
		expect(a.refiled).toHaveLength(0);
		expect(server.count()).toBe(1);
		expect(a.registry.docs['plans/p1']?.rev).toBe(1);
	});
});

describe('the content reconcile', () => {
	it('adopts an identical untracked doc silently', async () => {
		const { a, b } = rig();
		a.set('plans', 'p1', 'same');
		await a.sync();
		b.set('plans', 'p1', 'same'); // arrived by file on B, byte-equal
		await b.sync();
		expect(b.refiled).toHaveLength(0);
		expect(b.registry.docs['plans/p1']?.rev).toBe(1);
	});

	it('keeps both when an adoptable untracked doc differs (copy)', async () => {
		const { server, a, b } = rig();
		a.set('plans', 'p1', 'account-version');
		await a.sync();
		b.set('plans', 'p1', 'local-version');
		await b.sync();
		await b.sync();
		expect(server.live()).toHaveLength(2);
	});

	it('a FRESH untracked lww edit runs the fold: the newer write wins', async () => {
		const { server, a, b } = rig();
		a.set('pilot', 'pilot', 'alpha');
		await a.sync();
		// B types its own pilot doc before its first pull of A's: no
		// registry entry, NOT preexisting (typed after sign-in), so the
		// lww fold applies and B's later clock rebases and pushes.
		b.set('pilot', 'pilot', 'bravo');
		await b.sync();
		expect(b.local.get('pilot/pilot')?.payloadText).toBe('bravo');
		const row = server.doc('pilot/pilot');
		expect(row?.payload?.data).toBe('bravo');
		await a.sync();
		expect(a.local.get('pilot/pilot')?.payloadText).toBe('bravo');
	});

	it('applies over a HELD-BACK differing leftover in SHARED mode (the shared residual)', async () => {
		const { server, a, b } = rig();
		a.set('plans', 'p1', 'account-version');
		await a.sync();
		b.set('plans', 'p1', 'leftover');
		b.registry.preexisting = ['plans/p1'];
		await b.sync({ mode: 'shared' });
		expect(b.refiled).toHaveLength(0);
		expect(b.local.get('plans/p1')?.payloadText).toBe('account-version');
		expect(server.live()).toHaveLength(1);
	});

	it('PERSONAL mode keeps a held-back differing copy doc as a copy, held back with it', async () => {
		const { server, a, b } = rig();
		a.set('plans', 'p1', 'account-version');
		await a.sync();
		// B signed out with its data kept and edited p1 meanwhile: the
		// edit is the pilot's own, pending the merge confirm.
		b.set('plans', 'p1', 'my-offline-edit');
		b.registry.preexisting = ['plans/p1'];
		const first = await b.sync();
		expect(b.local.get('plans/p1')?.payloadText).toBe('account-version');
		expect(b.refiled).toHaveLength(1);
		expect(b.local.get('plans/copy-p1-r1')?.payloadText).toBe('my-offline-edit');
		// The copy is held back like its origin: nothing uploads before
		// the confirm, and the confirm's count names it.
		expect(first.unadopted).toBe(1);
		expect(b.registry.preexisting).toEqual(['plans/copy-p1-r1']);
		await b.sync();
		expect(server.live()).toHaveLength(1);
		delete b.registry.preexisting; // "add"
		await b.sync();
		expect(server.live()).toHaveLength(2);
	});

	it('PERSONAL mode leaves a held-back differing lww doc alone until adopted', async () => {
		const { server, a, b } = rig();
		a.set('pilot', 'pilot', 'account-pilot');
		await a.sync();
		b.set('pilot', 'pilot', 'my-pilot');
		b.registry.preexisting = ['pilot/pilot'];
		const first = await b.sync();
		// Untouched, untracked, counted: a later local delete records no
		// tombstone against a doc this device never adopted.
		expect(b.local.get('pilot/pilot')?.payloadText).toBe('my-pilot');
		expect(b.registry.docs['pilot/pilot']).toBeUndefined();
		expect(first.unadopted).toBe(1);
		expect(server.doc('pilot/pilot')?.payload?.data).toBe('account-pilot');
		delete b.registry.preexisting; // "add": the push meets the conflict fold
		await b.sync();
		expect(server.doc('pilot/pilot')?.payload?.data).toBe('my-pilot');
		expect(b.registry.docs['pilot/pilot']?.rev).toBe(2);
		await a.sync();
		expect(a.local.get('pilot/pilot')?.payloadText).toBe('my-pilot');
	});
});

describe('adoption', () => {
	it('preexisting docs hold back until adopted', async () => {
		const { server, b } = rig();
		b.set('plans', 'p1', 'mine');
		b.registry.preexisting = ['plans/p1'];
		const held = await b.sync();
		expect(held.unadopted).toBe(1);
		expect(server.count()).toBe(0);
		delete b.registry.preexisting; // the merge confirm's "add"
		await b.sync();
		expect(server.count()).toBe(1);
	});
});

describe('eviction and reset', () => {
	it('an evicted store heals from the server, deleting nothing', async () => {
		const { server, a, b } = rig();
		a.set('plans', 'p1', 'v1');
		a.set('outings', '100', 'row');
		await a.sync();
		await b.sync();
		expect(b.local.size).toBe(2);
		b.local.clear(); // the eviction
		await b.sync();
		expect(b.local.size).toBe(2);
		expect(server.live()).toHaveLength(2);
	});

	it('a full listing past the horizon pages to its end (>200 docs)', async () => {
		const { server, a, b } = rig();
		for (let k = 0; k < 250; k++) {
			a.set('plans', `p${k}`, `v${k}`);
		}
		await a.sync();
		a.delete('plans', 'p0');
		await a.sync();
		server.purgeTombstones(); // the horizon now sits above page one's cursor
		const out = await b.sync();
		expect(out.reset).toBe(true);
		// Every live doc landed in ONE pass: the continuation pages were not
		// clamped back to zero.
		expect(b.local.size).toBe(249);
		expect(b.local.has('plans/p0')).toBe(false);
	});

	it('the reset reconciliation spares a DIRTY tracked doc the listing lacks', async () => {
		const { server, a, b } = rig();
		a.set('plans', 'doomed', 'v1');
		await a.sync();
		await b.sync();
		a.delete('plans', 'doomed');
		await a.sync();
		server.purgeTombstones();
		// B edited its copy while away: the later action, not to vanish.
		b.set('plans', 'doomed', 'b-edit');
		const out = await b.sync();
		expect(out.reset).toBe(true);
		expect(b.local.get('plans/doomed')?.payloadText).toBe('b-edit');
		// Dropped from tracking by the reconciliation, it pushed as a fresh
		// doc in the same pass's push half: the edit is the account's again.
		expect(server.doc('plans/doomed')?.deleted).toBe(false);
		expect(server.doc('plans/doomed')?.payload?.data).toBe('b-edit');
		expect(b.registry.docs['plans/doomed']?.rev).toBe(1);
	});

	it('a purge horizon turns the delta into a full reconcile', async () => {
		const { server, a, b } = rig();
		a.set('plans', 'keep', 'v1');
		a.set('plans', 'doomed', 'v1');
		await a.sync();
		await b.sync();
		a.delete('plans', 'doomed');
		await a.sync();
		server.purgeTombstones(); // B never saw the tombstone; it is gone
		const out = await b.sync();
		expect(out.reset).toBe(true);
		expect(b.local.has('plans/doomed')).toBe(false);
		expect(b.local.has('plans/keep')).toBe(true);
	});
});

describe('the superseded verdict', () => {
	it('answers an arriving doc with a tombstone at its own rev', async () => {
		const { server, a, b } = rig();
		a.set('outings', '200', 'logbook-row');
		await a.sync();
		b.applySupersedes = true; // B's local trace covers the row
		await b.sync();
		await b.sync(); // the tombstone pushes
		expect(server.doc('outings/200')?.deleted).toBe(true);
		await a.sync();
		expect(a.local.has('outings/200')).toBe(false);
	});
});
