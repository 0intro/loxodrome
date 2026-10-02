/* decoWorkerClient.ts: the page's side of the decoration worker
 * (decoPaint.worker.ts), what lets the decorations' paint, 35 to 60 ms a
 * settle in Firefox at a 1.2 display scale, leave the main thread.
 *
 * Zones go across once each, under a number the page keeps per zone object
 * (the object dies with its row, and a FinalizationRegistry tells the worker
 * to let it go), their arrays handed over: the page keeps no ring it no longer
 * paints. A painting names its zones by number, and comes back as a bitmap.
 *
 * The worker is trusted only while it keeps answering. It is dropped for good,
 * with one console warning naming why, when it says it cannot paint here
 * (`unsupported`), fails a painting, raises an error, or keeps a painting
 * past the deadline while the page is visible. Two things are no verdict on
 * the worker and re-arm the deadline instead: a hidden page, whose timers
 * wait until it shows again, and a deadline the page itself ran late, a long
 * task on the main thread holding back the answer as much as the timer. The
 * layer then paints on the page, as it does before the worker is ready. */

import type { DecoFrame } from './decoPaint';
import { transfersOf, type FromWorker, type ToWorker, type WireZone } from './decoProtocol';
import type { DecoZone } from './decoZone';

/** How long a worker may take to say it is ready, while the page is visible.
 *  The page paints until then, so this only decides when a worker that never
 *  answers is given up: long enough for a first visit on a slow network,
 *  which fetches the script beside everything else. */
export const READY_TIMEOUT_MS = 20_000;
/** How long a painting may take, while the page is visible. Until it lands
 *  the previous painting stays on screen, placed for the current view, so a
 *  slow one costs nothing but its lateness, and giving up on it would only
 *  move the same work onto the main thread: the deadline is for a worker
 *  that stopped answering, not for a slow device. */
export const PAINT_TIMEOUT_MS = 5000;
/** A deadline that fires this late says the PAGE did not run. */
export const STALL_MS = 250;

export interface WorkerHandlers {
	/** Painting `seq` landed. */
	frame(seq: number, bitmap: ImageBitmap): void;
	/** The worker is gone for good: every painting it held is lost. */
	down(reason: string): void;
}

/** The worker, as the page makes one: the constructor call is written out
 *  where Vite finds it and bundles the worker beside the app. */
export function startDecoWorker(): Worker | null {
	if (typeof Worker !== 'function') {
		return null;
	}
	try {
		return new Worker(new URL('./decoPaint.worker.ts', import.meta.url), { type: 'module' });
	} catch {
		return null;
	}
}

export class DecoWorkerClient {
	private worker: Worker | null;
	private isReady = false;
	private readonly gids = new WeakMap<DecoZone, number>();
	private nextGid = 1;
	// The last zone list and its numbers: a list handed again (the layer
	// keeps one while its rows stand) is named without walking it, and its
	// zones all went across already.
	private lastList: { zones: readonly DecoZone[]; ids: Uint32Array } | null = null;
	private forgotten: number[] = [];
	private readonly finalizer =
		typeof FinalizationRegistry === 'function'
			? new FinalizationRegistry<number>((gid) => {
					this.forgotten.push(gid);
				})
			: null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private waitingFor: { seq: number | null; ms: number; reason: string } | null = null;
	private readonly onVisibility = (): void => {
		if (!document.hidden && this.waitingFor) {
			this.arm(this.waitingFor.seq, this.waitingFor.ms, this.waitingFor.reason);
		}
	};

	constructor(
		worker: Worker,
		private readonly handlers: WorkerHandlers,
	) {
		this.worker = worker;
		worker.onmessage = (e: MessageEvent<FromWorker>) => {
			this.receive(e.data);
		};
		worker.onerror = (e) => {
			e.preventDefault();
			this.fail(`error: ${e.message}`);
		};
		worker.onmessageerror = () => {
			this.fail('messageerror');
		};
		document.addEventListener('visibilitychange', this.onVisibility);
		this.arm(null, READY_TIMEOUT_MS, 'ready-timeout');
	}

	/** Ready to take a painting. */
	get ready(): boolean {
		return this.isReady && this.worker !== null;
	}

	/** Ask for painting `seq`: the zones it names go across first, if new. */
	paint(
		seq: number,
		frame: DecoFrame,
		width: number,
		height: number,
		zones: readonly DecoZone[],
		highlighted: readonly DecoZone[],
		outlined: readonly DecoZone[],
	): void {
		const fresh: WireZone[] = [];
		const ids = (list: readonly DecoZone[]): Uint32Array => {
			const out = new Uint32Array(list.length);
			list.forEach((z, i) => {
				let gid = this.gids.get(z);
				if (gid === undefined) {
					gid = this.nextGid++;
					this.gids.set(z, gid);
					this.finalizer?.register(z, gid);
					fresh.push({ ...z, gid });
				}
				out[i] = gid;
			});
			return out;
		};
		let zoneIds: Uint32Array;
		if (this.lastList?.zones === zones) {
			zoneIds = this.lastList.ids;
		} else {
			zoneIds = ids(zones);
			this.lastList = { zones, ids: zoneIds };
		}
		const highlightedIds = ids(highlighted);
		const outlinedIds = ids(outlined);
		if (this.forgotten.length > 0) {
			this.post({ type: 'forget', gids: Uint32Array.from(this.forgotten) });
			this.forgotten = [];
		}
		if (fresh.length > 0) {
			this.post({ type: 'zones', zones: fresh });
		}
		// A copy, the message handing its buffer over: the list kept here
		// names the next painting too.
		this.post({ type: 'paint', seq, frame, width, height, zones: zoneIds.slice(), highlighted: highlightedIds, outlined: outlinedIds });
		this.arm(seq, PAINT_TIMEOUT_MS, 'paint-timeout');
	}

	/** Stop the worker; nothing more is reported, not even a message it
	 *  posted before it stopped. */
	dispose(): void {
		this.disarm();
		document.removeEventListener('visibilitychange', this.onVisibility);
		if (this.worker) {
			this.worker.onmessage = null;
			this.worker.onerror = null;
			this.worker.onmessageerror = null;
			this.worker.terminate();
		}
		this.worker = null;
		this.isReady = false;
	}

	private post(msg: ToWorker): void {
		this.worker?.postMessage(msg, transfersOf(msg));
	}

	private receive(msg: FromWorker): void {
		if (!this.worker) {
			return;
		}
		switch (msg.type) {
			case 'ready':
				this.isReady = true;
				this.disarm();
				return;
			case 'unsupported':
				this.fail(`unsupported: ${msg.reason}`);
				return;
			case 'frame':
				if (this.waitingFor?.seq === msg.seq) {
					this.disarm();
				}
				this.handlers.frame(msg.seq, msg.bitmap);
				return;
			case 'failed':
				this.fail(`failed: ${msg.reason}`);
				return;
		}
	}

	private fail(reason: string): void {
		if (!this.worker) {
			return;
		}
		this.dispose();
		console.warn(`[loxodrome] airspace decorations painted on the page: worker ${reason}`);
		this.handlers.down(reason);
	}

	/** Expect an answer within `ms` of visible time. */
	private arm(seq: number | null, ms: number, reason: string): void {
		this.disarm();
		this.waitingFor = { seq, ms, reason };
		// Wall time, not performance.now(): a clock stepped forward reads as a
		// stall and costs one more wait, which is the safe way to be wrong.
		const due = Date.now() + ms;
		this.timer = setTimeout(() => {
			this.timer = null;
			if (document.hidden) {
				// Not judged while hidden: the visibility listener re-arms.
				return;
			}
			if (Date.now() - due > STALL_MS) {
				// The page ran this late: an answer may be queued behind it.
				this.arm(seq, ms, reason);
				return;
			}
			this.fail(reason);
		}, ms);
	}

	private disarm(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.waitingFor = null;
	}
}
