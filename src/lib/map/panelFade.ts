/* panelFade.ts: what is on the way in and what is on the way out.
 *
 * The VAC overlay draws a mosaic of sheets, and the set changes as the view
 * does: a neighbour crosses its zoom ceiling, a chart leaves the screen, the
 * bitmap budget turns one away. Swapped instantly those read as glitches
 * rather than as transitions, so each panel carries an alpha and is given a
 * moment to arrive or to go.
 *
 * Pure and Leaflet-free on purpose: the layer that uses it cannot be reached
 * from a node test, and none of this arithmetic needs a map. */

/** One panel on screen, or on its way off it. */
export interface FadeEntry<T> {
	key: string;
	item: T;
	/** 0 to 1. Only ever drawn above 0. */
	alpha: number;
	/** Where alpha is heading: 1 while wanted AND drawable, else 0. */
	target: number;
}

/** Merge the wanted list into the fading set.
 *
 *  `wanted` is in PAINT order, back to front. A panel that has gone keeps
 *  its old place rather than being pushed to one end: it is on its way out,
 *  and sliding under its neighbours on the way would be its own glitch.
 *
 *  A panel with no bitmap yet is not "arriving", it is absent: its alpha
 *  stays at 0 and it starts to rise the moment there is something to show. */
export function mergeFades<T extends { canvas: unknown }>(
	current: readonly FadeEntry<T>[],
	wanted: readonly { key: string; item: T }[],
	instant = false,
): FadeEntry<T>[] {
	const held = new Map(current.map((e) => [e.key, e]));
	const out: FadeEntry<T>[] = wanted.map((w) => {
		const was = held.get(w.key);
		const target = w.item.canvas ? 1 : 0;
		const alpha = was ? was.alpha : 0;
		return { key: w.key, item: w.item, alpha: instant ? target : alpha, target };
	});
	const kept = new Set(out.map((e) => e.key));
	current.forEach((e, i) => {
		if (kept.has(e.key) || instant || e.alpha <= 0) {
			return;
		}
		out.splice(Math.min(i, out.length), 0, { ...e, target: 0 });
	});
	return out;
}

/** Step every alpha toward its target and drop what has finished leaving.
 *
 *  Returns the surviving entries and whether anything is still moving, which
 *  is what tells the layer to ask for another frame. A duration of zero is
 *  the reduced-motion path: everything arrives at its target at once. */
export function stepFades<T>(
	entries: readonly FadeEntry<T>[],
	dtMs: number,
	durationMs: number,
): { entries: FadeEntry<T>[]; moving: boolean } {
	const step = durationMs > 0 ? Math.max(0, dtMs) / durationMs : 1;
	const out: FadeEntry<T>[] = [];
	let moving = false;
	for (const e of entries) {
		let alpha = e.alpha;
		if (alpha !== e.target) {
			alpha =
				e.target > alpha ? Math.min(e.target, alpha + step) : Math.max(e.target, alpha - step);
			if (alpha !== e.target) {
				moving = true;
			}
		}
		if (e.target === 0 && alpha <= 0) {
			continue;
		}
		out.push(alpha === e.alpha ? e : { ...e, alpha });
	}
	return { entries: out, moving };
}
