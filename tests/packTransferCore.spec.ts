/* The pack transfer worker's work (offline/packTransferCore.ts) over the
 * in-memory OPFS (tests/helpers/opfsFake.ts, Chromium's locks) and a fake
 * archive route (tests/helpers/archiveServer.ts). What it must do, in this
 * order: take the part's lock before any request, empty the part before it
 * names a new edition, drop a tail past the stamp before writing, stamp what
 * each flush made durable, and post its one terminal message only after both
 * handles are closed. A kill keeps every written byte, and the next attempt
 * builds on the last stamp, never on the size. */
import { describe, expect, it, vi } from 'vitest';

import { formatSidecar } from '$lib/offline/packTransfer';
import { PackTransferCore, type CoreOptions } from '$lib/offline/packTransferCore';
import type { FromWorker, StartJob } from '$lib/offline/packTransferProtocol';
import { archiveServer, patternArchive, type ArchiveServerOptions } from './helpers/archiveServer';
import { FakeFile, FakeRoot, type FakeDir } from './helpers/opfsFake';

const E0 = '"edition-0"';
const E1 = '"edition-1"';
const ARCHIVE = patternArchive(1000);
const OLD = patternArchive(1000, 97);
const DIR = 'basemap-packs';
const PART = 'planign.pmtiles.part';
const SIDE = 'planign.pmtiles.etag';
const JOB: StartJob = { type: 'start', dir: DIR, part: PART, etagFile: SIDE, url: 'https://charts.example/planign/archive' };

interface Rig {
	root: FakeRoot;
	packs: FakeDir;
	server: ReturnType<typeof archiveServer>;
	core: PackTransferCore;
	posts: FromWorker[];
	/** Whether each file was locked when the terminal message was posted. */
	lockedAtEnd: { part: boolean | null; side: boolean | null };
}

async function rig(opts: CoreOptions = {}, serverOpts: ArchiveServerOptions = {}, root = new FakeRoot()): Promise<Rig> {
	const packs = await root.getDirectoryHandle(DIR, { create: true });
	const server = archiveServer(ARCHIVE, { etag: E1, ...serverOpts });
	const posts: FromWorker[] = [];
	const lockedAtEnd: Rig['lockedAtEnd'] = { part: null, side: null };
	let clock = 0;
	const core = new PackTransferCore(
		{
			post: (m) => {
				if (m.type === 'done' || m.type === 'failed') {
					lockedAtEnd.part = packs.file(PART)?.locked ?? null;
					lockedAtEnd.side = packs.file(SIDE)?.locked ?? null;
				}
				posts.push(m);
			},
			root: () => Promise.resolve(root as unknown as FileSystemDirectoryHandle),
			probe: () => null,
			now: () => (clock += 100),
			sleep: () => Promise.resolve(),
			fetch: server.fetch,
		},
		{ lockWaitMs: 0, ...opts },
	);
	return { root, packs, server, core, posts, lockedAtEnd };
}

const terminal = (posts: FromWorker[]): FromWorker | undefined =>
	posts.find((m) => m.type === 'done' || m.type === 'failed' || m.type === 'unsupported');

async function settle(r: Rig): Promise<FromWorker> {
	await vi.waitFor(() => expect(terminal(r.posts)).toBeDefined());
	return terminal(r.posts) as FromWorker;
}

describe('a transfer written in place', () => {
	it('writes a fresh part once, stamps it, and posts done with both locks released', async () => {
		const r = await rig();
		r.core.start();
		r.core.handle(JOB);
		expect(await settle(r)).toEqual({ type: 'done', received: 1000, total: 1000, etag: E1 });
		expect(r.posts[0]).toEqual({ type: 'ready' });
		expect(r.packs.file(PART)?.data).toEqual(ARCHIVE);
		expect(r.packs.text(SIDE)).toBe(formatSidecar(1000, E1));
		expect(r.lockedAtEnd).toEqual({ part: false, side: false });
		expect(r.packs.names().some((n) => n.includes('.crswap'))).toBe(false);
		expect(r.root.log.some((l) => l.startsWith('commit'))).toBe(false);
	});

	it('takes the part lock before any request', async () => {
		const r = await rig();
		let lockedAtHead: boolean | undefined;
		const fetchImpl = r.server.fetch;
		(r.core as unknown as { env: { fetch: typeof fetch } }).env.fetch = ((url: string, init?: RequestInit) => {
			lockedAtHead ??= r.packs.file(PART)?.locked;
			return fetchImpl(url, init);
		}) as typeof fetch;
		r.core.handle(JOB);
		await settle(r);
		expect(lockedAtHead).toBe(true);
	});

	it('resumes from the stamp, dropping the tail past it first', async () => {
		const r = await rig();
		const part = new Uint8Array(600);
		part.set(ARCHIVE.slice(0, 400));
		r.packs.put(PART, part);
		r.packs.put(SIDE, formatSidecar(400, E1));
		r.core.handle(JOB);
		expect(await settle(r)).toMatchObject({ type: 'done', received: 1000 });
		expect(r.server.requests[1].range).toBe('bytes=400-');
		const truncated = r.root.log.indexOf(`truncate ${PART} 400`);
		const firstWrite = r.root.log.findIndex((l) => l.startsWith(`write ${PART}`));
		expect(truncated).toBeGreaterThanOrEqual(0);
		expect(firstWrite).toBeGreaterThan(truncated);
		expect(r.packs.file(PART)?.data).toEqual(ARCHIVE);
	});

	it('resumes a page-path part from its size and turns its record into a stamp', async () => {
		const r = await rig();
		r.packs.put(PART, ARCHIVE.slice(0, 600));
		r.packs.put(SIDE, E1);
		r.core.handle(JOB);
		await settle(r);
		expect(r.server.requests[1].range).toBe('bytes=600-');
		expect(r.packs.text(SIDE)).toBe(formatSidecar(1000, E1));
		expect(r.packs.file(PART)?.data).toEqual(ARCHIVE);
	});

	it('empties and flushes the part before it names a new edition', async () => {
		const r = await rig();
		r.packs.put(PART, OLD.slice(0, 600));
		r.packs.put(SIDE, formatSidecar(600, E0));
		r.core.handle(JOB);
		await settle(r);
		const i = (line: string): number => r.root.log.indexOf(line);
		expect(i(`truncate ${PART} 0`)).toBeGreaterThanOrEqual(0);
		expect(i(`flush ${PART} 0`)).toBeGreaterThan(i(`truncate ${PART} 0`));
		expect(i(`truncate ${SIDE} 0`)).toBeGreaterThan(i(`flush ${PART} 0`));
		expect(r.packs.file(PART)?.data).toEqual(ARCHIVE);
		expect(r.packs.text(SIDE)).toBe(formatSidecar(1000, E1));
	});

	it('answers a complete part on the HEAD alone', async () => {
		const r = await rig();
		r.packs.put(PART, ARCHIVE);
		r.packs.put(SIDE, formatSidecar(1000, E1));
		r.core.handle(JOB);
		expect(await settle(r)).toEqual({ type: 'done', received: 1000, total: 1000, etag: E1 });
		expect(r.server.requests.map((q) => q.method)).toEqual(['HEAD']);
	});

	it('keeps every written byte on a pause, stamps them, and reports them', async () => {
		let release!: () => void;
		const hold = new Promise<void>((res) => (release = res));
		const r = await rig({}, { holdAfter: 500, hold });
		r.core.handle(JOB);
		await vi.waitFor(() => expect(r.packs.file(PART)?.data.length).toBe(500));
		r.core.handle({ type: 'abort' });
		release();
		expect(await settle(r)).toEqual({ type: 'failed', received: 500, total: 1000, failure: { kind: 'abort' } });
		expect(r.packs.file(PART)?.data).toEqual(ARCHIVE.slice(0, 500));
		expect(r.packs.text(SIDE)).toBe(formatSidecar(500, E1));
		expect(r.lockedAtEnd).toEqual({ part: false, side: false });
	});

	it('survives a kill: the next attempt builds on the last stamp, never the size', async () => {
		const first = await rig({ flushBytes: 128 }, { holdAfter: 600, hold: new Promise(() => undefined) });
		first.core.handle(JOB);
		await vi.waitFor(() => expect(first.packs.file(PART)?.data.length).toBe(600));
		// The kill: no finally ran, the browser drops the locks, the bytes stay.
		first.root.releaseLocks();
		expect(first.packs.text(SIDE)).toBe(formatSidecar(512, E1));

		const next = await rig({ flushBytes: 128 }, {}, first.root);
		next.core.handle(JOB);
		expect(await settle(next)).toMatchObject({ type: 'done', received: 1000 });
		expect(next.server.requests[1].range).toBe('bytes=512-');
		expect(next.packs.file(PART)?.data).toEqual(ARCHIVE);
	});

	it('flushes and stamps every flushBytes', async () => {
		const r = await rig({ flushBytes: 256 });
		r.core.handle(JOB);
		await settle(r);
		const stamps = r.root.log.filter((l) => l.startsWith(`write ${SIDE} 0`));
		// The opening record, one per 256 bytes, the final stamp.
		expect(stamps.length).toBeGreaterThanOrEqual(5);
		r.root.log.forEach((l, i) => {
			if (l.startsWith(`write ${SIDE} 0`) && i > 0) {
				const before = r.root.log.slice(0, i).reverse().find((x) => x.startsWith(`flush ${PART}`) || x.startsWith(`truncate ${SIDE}`));
				expect(before, `stamp at ${i} follows a flush of the part`).toBeDefined();
			}
		});
	});

	it('finishes a chunk the handle wrote short, and fails on a write that makes no progress', async () => {
		const halves = await rig();
		const part = halves.packs.put(PART, 0);
		part.shortWrite = (n) => Math.ceil(n / 2);
		halves.core.handle(JOB);
		expect(await settle(halves)).toMatchObject({ type: 'done', received: 1000 });
		expect(halves.packs.file(PART)?.data).toEqual(ARCHIVE);

		const stuck = await rig();
		stuck.packs.put(PART, 0).shortWrite = () => 0;
		stuck.core.handle(JOB);
		expect(await settle(stuck)).toMatchObject({ type: 'failed', failure: { kind: 'error', message: expect.stringMatching(/no progress/) as string } });
	});

	it('keeps the name of a quota refusal', async () => {
		const r = await rig();
		r.packs.put(PART, 0).shortWrite = () => {
			throw new DOMException('quota', 'QuotaExceededError');
		};
		r.core.handle(JOB);
		expect(await settle(r)).toMatchObject({ type: 'failed', failure: { kind: 'error', name: 'QuotaExceededError' } });
		expect(r.lockedAtEnd.part).toBe(false);
	});

	it('waits out a lock another context is releasing, and gives up on one it keeps', async () => {
		const brief = await rig({ lockTries: 5 });
		const held = await brief.packs.put(PART, 0).createSyncAccessHandle();
		let sleeps = 0;
		(brief.core as unknown as { env: { sleep: () => Promise<void> } }).env.sleep = () => {
			if (++sleeps === 2) {
				held.close();
			}
			return Promise.resolve();
		};
		brief.core.handle(JOB);
		expect(await settle(brief)).toMatchObject({ type: 'done' });

		const kept = await rig({ lockTries: 3 });
		await kept.packs.put(PART, 0).createSyncAccessHandle();
		kept.core.handle(JOB);
		expect(await settle(kept)).toMatchObject({ type: 'failed', failure: { kind: 'error', name: 'NoModificationAllowedError' } });
		expect(kept.server.requests).toEqual([]);
	});

	it('ends as a pause when stopped while waiting for a lock, without a request', async () => {
		const r = await rig({ lockTries: 1000 });
		await r.packs.put(PART, 0).createSyncAccessHandle();
		let sleeps = 0;
		(r.core as unknown as { env: { sleep: () => Promise<void> } }).env.sleep = () => {
			if (++sleeps === 3) {
				r.core.handle({ type: 'abort' });
			}
			return Promise.resolve();
		};
		r.core.handle(JOB);
		expect(await settle(r)).toEqual({ type: 'failed', received: 0, total: null, failure: { kind: 'abort' } });
		expect(sleeps).toBeLessThan(10);
		expect(r.server.requests).toEqual([]);
	});

	it('answers unsupported before writing or fetching anything', async () => {
		const probed = await rig();
		(probed.core as unknown as { env: { probe: () => string } }).env.probe = () => 'no sync access handles';
		probed.core.start();
		expect(probed.posts).toEqual([{ type: 'unsupported', reason: 'no sync access handles' }]);

		const missing = await rig();
		const original = Object.getOwnPropertyDescriptor(FakeFile.prototype, 'createSyncAccessHandle');
		Object.defineProperty(FakeFile.prototype, 'createSyncAccessHandle', { value: undefined, configurable: true });
		try {
			missing.core.handle(JOB);
			expect(await settle(missing)).toMatchObject({ type: 'unsupported' });
		} finally {
			Object.defineProperty(FakeFile.prototype, 'createSyncAccessHandle', original as PropertyDescriptor);
		}
		expect(missing.server.requests).toEqual([]);
		expect(missing.packs.names()).toEqual([]);
	});

	it('posts progress at most every progressMs', async () => {
		const r = await rig({ progressMs: 250 });
		r.core.handle(JOB);
		await settle(r);
		const progress = r.posts.filter((m) => m.type === 'progress');
		// 16 chunks of 64 bytes, the clock 100 ms on per read: about one in three.
		expect(progress.length).toBeGreaterThanOrEqual(4);
		expect(progress.length).toBeLessThanOrEqual(7);
	});

	it('leaves no file behind when a first attempt is refused', async () => {
		const r = await rig({}, { headStatus: 404 });
		r.core.handle(JOB);
		expect(await settle(r)).toEqual({ type: 'failed', received: 0, total: null, failure: { kind: 'http', status: 404, phase: 'HEAD' } });
		expect(r.packs.names()).toEqual([]);
	});

	it('runs one transfer, whatever else it is asked', async () => {
		const r = await rig();
		r.core.handle(JOB);
		r.core.handle(JOB);
		await settle(r);
		expect(r.server.requests.filter((q) => q.method === 'HEAD')).toHaveLength(1);
		expect(r.posts.filter((m) => m.type === 'done')).toHaveLength(1);
	});
});
