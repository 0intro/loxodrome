/* Pins Direct-To's list arithmetic (route/directTo.ts): the alternate lands
 * right after the route being flown, so the trip pairing attaches it to
 * that trip; an existing alternate of that trip becomes the orphan; a flown
 * route the list lacks appends. The state module's directTo is one undo
 * step over this; `role: alternate` round-trips through the YAML already
 * (tests/routeYaml.spec.ts). */

import { describe, expect, it } from 'vitest';
import { insertDirectTo } from '$lib/route/directTo';
import { orderedTrips, orphanAlternates, type RouteLike } from '$lib/aircraft/trips';

/* What "attached" means, read back through the app's own trip folding: the
 * direct-to is the flown trip's alternate. The assertion lives here rather
 * than beside insertDirectTo, which nothing but this file would call. */
function directToAttached<T extends RouteLike & { id: string }>(
	list: readonly T[],
	flownId: string,
	directToId: string,
): boolean {
	const trips = orderedTrips(list);
	const flown = trips.find((t) => t.route.id === flownId);
	return flown?.alternate?.id === directToId;
}

type R = { id: string; alternate?: boolean | undefined };
const trip = (id: string): R => ({ id });
const alt = (id: string): R => ({ id, alternate: true });

describe('insertDirectTo', () => {
	it('inserts right after the flown route, which then owns it as its alternate', () => {
		const list = [trip('t1'), trip('t2'), trip('t3')];
		const out = insertDirectTo(list, 't2', alt('d'));
		expect(out.map((r) => r.id)).toEqual(['t1', 't2', 'd', 't3']);
		expect(directToAttached(out, 't2', 'd')).toBe(true);
		expect(orderedTrips(out).map((t) => [t.route.id, t.alternate?.id ?? null])).toEqual([
			['t1', null],
			['t2', 'd'],
			['t3', null],
		]);
	});

	it('outranks a planned alternate of the flown trip, which becomes the orphan', () => {
		const list = [trip('t1'), alt('a1'), trip('t2')];
		const out = insertDirectTo(list, 't1', alt('d'));
		expect(out.map((r) => r.id)).toEqual(['t1', 'd', 'a1', 't2']);
		expect(directToAttached(out, 't1', 'd')).toBe(true);
		expect(orphanAlternates(out).map((r) => r.id)).toEqual(['a1']);
	});

	it('follows a flown route that is itself an alternate', () => {
		const list = [trip('t1'), alt('a1'), trip('t2')];
		const out = insertDirectTo(list, 'a1', alt('d'));
		expect(out.map((r) => r.id)).toEqual(['t1', 'a1', 'd', 't2']);
	});

	it('appends when the flown id is not in the list, and never mutates the input', () => {
		const list = [trip('t1')];
		const out = insertDirectTo(list, 'gone', alt('d'));
		expect(out.map((r) => r.id)).toEqual(['t1', 'd']);
		expect(list).toHaveLength(1);
	});
});
