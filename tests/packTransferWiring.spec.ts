/* downloadPack through the pack transfer worker, end to end in process: a
 * Worker stand-in carries the messages over a real MessageChannel (so they
 * are cloned and arrive asynchronously, as between threads) to the real core
 * (offline/packTransferCore.ts), over the in-memory OPFS and a fake archive
 * route. Pinned:
 *   - a download is written by the worker through its sync handle and
 *     committed by the page: no writable ever touches the part;
 *   - a pause rejects only once the worker has let go of the part, every
 *     written byte kept, and a Delete then leaves nothing;
 *   - listPacks during a transfer never reads the part;
 *   - an unsupported worker hands the download to the page, which keeps it
 *     for the rest of the session;
 *   - a kill, then a relaunch's resume through a fresh worker, builds on the
 *     last stamp and ends byte-exact. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatSidecar } from '$lib/offline/packTransfer';
import { PackTransferCore } from '$lib/offline/packTransferCore';
import type { FromWorker, ToWorker } from '$lib/offline/packTransferProtocol';
import { archiveServer, patternArchive } from './helpers/archiveServer';
import { FakeRoot, fakeStorage, type FakeDir } from './helpers/opfsFake';

const E1 = '"edition-1"';
const ARCHIVE = patternArchive(1000);
const URL_ = 'https://charts.example/planign/archive';
const PART = 'planign.pmtiles.part';
const SIDE = 'planign.pmtiles.etag';

let root: FakeRoot;
let packs: FakeDir;
let server: ReturnType<typeof archiveServer>;
let workersMade: number;
let probeReason: string | null;
let flushBytes: number | undefined;

/** A Worker that is the real core on the far side of a MessageChannel. */
class ChannelWorker {
	onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	onmessageerror: ((e: unknown) => void) | null = null;
	private readonly ch = new MessageChannel();
	constructor() {
		workersMade++;
		const core = new PackTransferCore(
			{
				post: (m) => {
					this.ch.port2.postMessage(m);
				},
				root: () => Promise.resolve(root as unknown as FileSystemDirectoryHandle),
				probe: () => probeReason,
				now: () => Date.now(),
				sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
				fetch: server.fetch,
			},
			{ lockWaitMs: 1, ...(flushBytes === undefined ? {} : { flushBytes }) },
		);
		this.ch.port1.onmessage = (e: MessageEvent<FromWorker>) => this.onmessage?.(e);
		this.ch.port2.onmessage = (e: MessageEvent<ToWorker>) => {
			core.handle(e.data);
		};
		queueMicrotask(() => {
			core.start();
		});
	}
	postMessage(m: ToWorker): void {
		this.ch.port1.postMessage(m);
	}
	terminate(): void {
		this.ch.port1.close();
		this.ch.port2.close();
	}
}

async function modules(): Promise<{
	store: typeof import('../src/lib/offline/packStore');
	client: typeof import('../src/lib/offline/packTransferClient');
}> {
	const store = await import('../src/lib/offline/packStore');
	const client = await import('../src/lib/offline/packTransferClient');
	return { store, client };
}

beforeEach(async () => {
	vi.resetModules();
	root = new FakeRoot();
	packs = await root.getDirectoryHandle('basemap-packs', { create: true });
	server = archiveServer(ARCHIVE, { etag: E1 });
	workersMade = 0;
	probeReason = null;
	flushBytes = undefined;
	vi.stubGlobal('navigator', fakeStorage(root));
	vi.stubGlobal('fetch', server.fetch);
	vi.stubGlobal('Worker', ChannelWorker);
	vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('a download through the worker', () => {
	it('is written by the worker and committed by the page, no writable on the part', async () => {
		const { store } = await modules();
		const ref = { family: store.BASEMAP_PACK_FAMILY, id: 'planign' };
		expect(await store.downloadPack(ref, URL_)).toEqual({ bytes: 1000, etag: E1 });
		expect(packs.file('planign.pmtiles')?.data).toEqual(ARCHIVE);
		expect(packs.names()).toEqual(['manifest.json', 'planign.pmtiles']);
		expect(root.log).toContain(`lock ${PART}`);
		expect(root.log.some((l) => l.startsWith(`write ${PART}`))).toBe(true);
		expect(root.log.some((l) => l.startsWith(`commit ${PART}`))).toBe(false);
		expect(workersMade).toBe(1);
	});

	it('rejects a pause only once the worker has let go, every byte kept, and a Delete leaves nothing', async () => {
		const { store } = await modules();
		const ref = { family: store.BASEMAP_PACK_FAMILY, id: 'planign' };
		let release!: () => void;
		server.set({ etag: E1, holdAfter: 500, hold: new Promise<void>((r) => (release = r)) });
		const ac = new AbortController();
		const kept: number[] = [];
		const running = store.downloadPack(ref, URL_, { signal: ac.signal, onProgress: ({ received }) => kept.push(received) });
		await vi.waitFor(() => expect(packs.file(PART)?.data.length).toBe(500));
		// The stop crosses the channel before the body moves again: released
		// only afterwards, or the worker could finish first, and a done that
		// crosses a stop rightly wins.
		ac.abort();
		await expect(running).rejects.toMatchObject({ name: 'AbortError' });
		release();
		expect(packs.file(PART)?.locked).toBe(false);
		expect(kept.at(-1)).toBe(500);
		expect(await store.partBytes(ref)).toBe(500);
		await store.deletePack(ref);
		expect(packs.names().filter((n) => n !== 'manifest.json')).toEqual([]);
	});

	it('lets listPacks run during a transfer without reading the part', async () => {
		const { store } = await modules();
		const ref = { family: store.BASEMAP_PACK_FAMILY, id: 'planign' };
		packs.put('other.pmtiles', 10);
		let release!: () => void;
		server.set({ etag: E1, holdAfter: 300, hold: new Promise<void>((r) => (release = r)) });
		root.getFileThrowsWhenLocked = true;
		const running = store.downloadPack(ref, URL_);
		await vi.waitFor(() => expect(packs.file(PART)?.locked).toBe(true));
		expect(Object.keys(await store.listPacks(store.BASEMAP_PACK_FAMILY))).toEqual(['other']);
		release();
		await running;
	});

	it('hands the download to the page when the worker is unsupported, for the rest of the session', async () => {
		const { store } = await modules();
		const ref = { family: store.BASEMAP_PACK_FAMILY, id: 'planign' };
		probeReason = 'no sync access handles';
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await store.downloadPack(ref, URL_);
		expect(packs.file('planign.pmtiles')?.data).toEqual(ARCHIVE);
		expect(root.log.some((l) => l.startsWith(`commit ${PART}`))).toBe(true);
		await store.deletePack(ref);
		await store.downloadPack(ref, URL_);
		expect(workersMade).toBe(1);
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it('survives a kill: a relaunch resumes through a fresh worker from the last stamp, byte-exact', async () => {
		flushBytes = 128;
		const first = await modules();
		const ref = { family: first.store.BASEMAP_PACK_FAMILY, id: 'planign' };
		server.set({ etag: E1, holdAfter: 600, hold: new Promise(() => undefined) });
		void first.store.downloadPack(ref, URL_).catch(() => undefined);
		await vi.waitFor(() => expect(packs.file(PART)?.data.length).toBe(600));
		// The kill: the page and its worker are gone mid-write; the browser
		// drops the locks and keeps the bytes.
		root.releaseLocks();
		expect(packs.text(SIDE)).toBe(formatSidecar(512, E1));

		vi.resetModules();
		server.set({ etag: E1 });
		const relaunch = await modules();
		expect(await relaunch.store.partBytes(ref)).toBe(512);
		await relaunch.store.downloadPack(ref, URL_);
		expect(server.requests.filter((q) => q.method === 'GET').at(-1)?.range).toBe('bytes=512-');
		expect(packs.file('planign.pmtiles')?.data).toEqual(ARCHIVE);
	});
});
