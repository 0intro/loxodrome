/* One call at a time, a call made while one is in flight JOINING it rather
 * than queueing behind it. The cron ticks every minute and a tick can take
 * longer (a publication reads every block's canary tiles, a listing waits on
 * its publisher): queued, the ticks would pile up behind one that hangs,
 * without bound. */

export class Coalescer<T> {
	private inFlight: { since: number; done: Promise<T> } | null = null;

	/** Runs fn, unless a call is in flight: that one is joined, and
	 *  `joined` told how long it has run. */
	run(nowMs: number, fn: () => Promise<T>, joined?: (ageMs: number) => void): Promise<T> {
		if (this.inFlight) {
			joined?.(nowMs - this.inFlight.since);
			return this.inFlight.done;
		}
		const done = fn().finally(() => {
			if (this.inFlight?.done === done) {
				this.inFlight = null;
			}
		});
		this.inFlight = { since: nowMs, done };
		return done;
	}
}
