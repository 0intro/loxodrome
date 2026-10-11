/* Hovering a nav-log enroute line flashes the sectors of THAT line on THAT
 * leg. The same text prints on many rows ("SEINE - INFORMATION: 134.300" over
 * SIV SEINE 1 on one leg, SEINE 3 on the next), and resolving the hover by its
 * text over every leg flashed the first row's sectors wherever the pointer was.
 * The hook runs in a real host effect (tests/env/webnode.ts); the map side is
 * a spy. */

import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrouteFreqLine } from '$lib/route/airspaces';

const map = vi.hoisted(() => ({ flashed: [] as string[][], cleared: 0 }));
vi.mock('$lib/map/selectionHighlight', () => ({
	hoverFeatures: (_kind: string, ids: readonly string[]): void => {
		map.flashed.push([...ids]);
	},
	clearHover: (): void => {
		map.cleared++;
	},
}));

import { legs, mountEnrouteHover } from './helpers/enrouteHoverHost.svelte';

function line(freq: string, keys: string[], closed = false): EnrouteFreqLine {
	return {
		label: 'SEINE - INFORMATION',
		freq,
		keys,
		...(closed ? { closed: true, closedBy: 'A0001/26' } : {}),
	};
}

const pmn = [line('134.300', ['SEINE 1'])];
const guedelon = [line('134.300', ['SEINE 3']), line('120.330', ['SEINE 4'])];

let host: ReturnType<typeof mountEnrouteHover>;

beforeEach(() => {
	map.flashed = [];
	map.cleared = 0;
	legs.byFromId = new Map([
		['wp-3', pmn],
		['wp-11', guedelon],
	]);
	host = mountEnrouteHover();
});

afterEach(() => {
	host.stop();
});

function point(fromId: string, l: EnrouteFreqLine | null): void {
	host.hover.set(l ? { fromId, line: l } : null);
	flushSync();
}

describe('the nav log enroute-line hover', () => {
	it('flashes the hovered leg own sectors when two legs print the same line', () => {
		point('wp-11', guedelon[0]);
		expect(map.flashed.at(-1)).toEqual(['SEINE 3']);
		point('wp-11', guedelon[1]);
		expect(map.flashed.at(-1)).toEqual(['SEINE 4']);
		point('wp-3', pmn[0]);
		expect(map.flashed.at(-1)).toEqual(['SEINE 1']);
	});

	it('tells an open and a struck line on one channel apart', () => {
		const shared = [line('134.300', ['SEINE 1']), line('134.300', ['SEINE 2'], true)];
		legs.byFromId = new Map([['wp-4', shared]]);
		flushSync();
		point('wp-4', shared[1]);
		expect(map.flashed.at(-1)).toEqual(['SEINE 2']);
		point('wp-4', shared[0]);
		expect(map.flashed.at(-1)).toEqual(['SEINE 1']);
	});

	it('lets go when the hovered leg is gone from the log', () => {
		point('wp-11', guedelon[1]);
		const flashes = map.flashed.length;
		const cleared = map.cleared;
		legs.byFromId = new Map([['wp-3', pmn]]);
		flushSync();
		expect(map.cleared).toBeGreaterThan(cleared);
		expect(map.flashed.length).toBe(flashes);
	});

	it('clears when the pointer leaves', () => {
		point('wp-11', guedelon[0]);
		const cleared = map.cleared;
		point('wp-11', null);
		expect(map.cleared).toBeGreaterThan(cleared);
	});
});
