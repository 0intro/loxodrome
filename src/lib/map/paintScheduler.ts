/* paintScheduler.ts: when a layer that paints away from its display canvas
 * (in a worker, or on an offscreen canvas) asks for a painting, and which one
 * it shows.
 *
 * One painting in flight at a time. A request made meanwhile is owed (dirty)
 * and sent when the painting in flight lands, so a burst of requests costs
 * two paintings, not one per request. Requests are pumped in a microtask, like
 * DirectDrawLayer's own paints: one view reset fires zoomend, moveend and
 * viewreset from a single call, and the handlers after the first (the airspace
 * cull among them) must have run before the view is taken for a paint.
 *
 * Held from a zoom's start to its settle: Leaflet animates toward a view the
 * map does not report yet, so nothing is sent, and a painting that lands
 * meanwhile, made for the view before the zoom, is dropped and owed again.
 * Otherwise every painting that lands is shown: it is always newer than the
 * one on screen, and the layer places it for wherever the map has gone since.
 *
 * Pure: the layer does the sending, the showing and the dropping. */

export interface PaintIo<F> {
	/** Paint the current view as `seq`, the view taken now. */
	send(seq: number): void;
	/** Show a painting that landed. */
	present(frame: F): void;
	/** Throw a painting away (close its bitmap). */
	discard(frame: F): void;
}

export class PaintScheduler<F> {
	private seq = 0;
	private inFlight: number | null = null;
	private dirty = false;
	private held = false;
	private queued = false;
	private waiters: (() => void)[] = [];

	constructor(private readonly io: PaintIo<F>) {}

	/** A painting of the current view is owed. */
	request(): void {
		this.dirty = true;
		this.queue();
	}

	/** A painting of the current view is owed, and sent now if nothing is on
	 *  its way nor queued: a `move`'s request, which nothing later in its task
	 *  makes stale, and which the worker is best handed before the page
	 *  paints its own layers in the microtasks after it. */
	requestNow(): void {
		this.dirty = true;
		this.pump();
	}

	/** A zoom has started: send nothing, show nothing, until release(). */
	hold(): void {
		this.held = true;
	}

	/** The view has settled: send what is owed. */
	release(): void {
		if (!this.held) {
			return;
		}
		this.held = false;
		this.queue();
	}

	/** Painting `seq` has landed. */
	arrived(seq: number, frame: F): void {
		if (seq !== this.inFlight) {
			this.io.discard(frame);
			return;
		}
		this.inFlight = null;
		if (this.held) {
			this.io.discard(frame);
			this.dirty = true;
		} else {
			this.io.present(frame);
		}
		this.pump();
	}

	/** Painting `seq` did not land: it is owed again, for the layer to send
	 *  once it has something to send it with. */
	failed(seq: number): void {
		if (seq !== this.inFlight) {
			return;
		}
		this.inFlight = null;
		this.dirty = true;
		this.settle();
	}

	/** Forget whatever is in flight and owed (the layer is going away, or
	 *  changing painter), and let every waiter go. */
	reset(): void {
		this.inFlight = null;
		this.dirty = false;
		this.held = false;
		this.flush();
	}

	/** Nothing owed, nothing in flight, not held. */
	get idle(): boolean {
		return !this.dirty && this.inFlight === null && !this.held && !this.queued;
	}

	/** The painting in flight, if any. */
	get pending(): number | null {
		return this.inFlight;
	}

	/** Held: a zoom (a wheel, a pinch, a flyTo) runs, and its `move`s are no
	 *  view to paint. */
	get holding(): boolean {
		return this.held;
	}

	/** Resolves once idle: what is on screen is the view as it stands. */
	whenIdle(): Promise<void> {
		if (this.idle) {
			return Promise.resolve();
		}
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	private queue(): void {
		if (this.queued) {
			return;
		}
		this.queued = true;
		queueMicrotask(() => {
			this.queued = false;
			this.pump();
		});
	}

	private pump(): void {
		if (this.held || this.inFlight !== null || !this.dirty || this.queued) {
			this.settle();
			return;
		}
		this.dirty = false;
		const seq = ++this.seq;
		this.inFlight = seq;
		this.io.send(seq);
		this.settle();
	}

	private settle(): void {
		if (this.idle) {
			this.flush();
		}
	}

	private flush(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const w of waiters) {
			w();
		}
	}
}
