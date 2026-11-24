/* Hovering a SIGMET row draws its clone over the map, and the clone goes
 * with the row: an advisory leaving the list under a still pointer (expired,
 * or replaced by a refetch) fires no mouseleave, and neither does a host
 * that unmounts. The hook runs in a real host effect (tests/env/webnode.ts),
 * and the map side is a spy. */

import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromIsigmet, type Sigmet } from '$lib/weather/sigmet';

const map = vi.hoisted(() => ({ drawn: [] as (string | null)[] }));
vi.mock('$lib/map/sigmetLayer', () => ({
	hoverSigmet: (it: { sigmet: Sigmet } | null): void => {
		map.drawn.push(it?.sigmet.id ?? null);
	},
}));

// The data module first: its module effect reads the NOTAM tick, and the
// cycle the SIGMET state enters from elsewhere runs it before that is done.
import '$lib/state/data.svelte';
import { mountSigmetHover, rows } from './helpers/sigmetHoverHost.svelte';

function advisory(series: string): Sigmet {
	return fromIsigmet({
		icaoId: 'LFPW',
		firId: 'LFFF',
		seriesId: series,
		hazard: 'ICE',
		coords: [
			{ lat: 47, lon: 1 },
			{ lat: 49, lon: 3 },
			{ lat: 47, lon: 5 },
		],
		validTimeFrom: 1_794_960_000,
		validTimeTo: 1_794_974_400,
	});
}

const a3 = advisory('A03');
const a4 = advisory('A04');

let host: ReturnType<typeof mountSigmetHover>;

beforeEach(() => {
	map.drawn = [];
	rows.list = [a3, a4];
	host = mountSigmetHover();
});

afterEach(() => {
	host.stop();
});

function point(s: Sigmet | null): void {
	host.hover.set(s);
	flushSync();
}

describe('the SIGMET row hover', () => {
	it('draws the hovered row, and clears it on leaving', () => {
		point(a3);
		expect(map.drawn.at(-1)).toBe(a3.id);
		point(null);
		expect(map.drawn.at(-1)).toBeNull();
	});

	it('clears the clone when the row leaves the list under a still pointer', () => {
		point(a3);
		rows.list = [a4];
		flushSync();
		expect(map.drawn.at(-1)).toBeNull();
		// The advisory coming back draws nothing: the pointer left it.
		rows.list = [a3, a4];
		flushSync();
		expect(map.drawn.at(-1)).toBeNull();
	});

	it('clears the clone when the host unmounts', () => {
		point(a4);
		host.stop();
		expect(map.drawn.at(-1)).toBeNull();
	});
});
