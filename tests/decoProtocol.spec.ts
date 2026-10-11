/* The page-worker messages of the decoration paint (map/decoProtocol.ts):
 * every array a message carries is handed over, not copied, and a zone comes
 * out of a structured clone as it went in, its empty arc list still apart from
 * none. */

import { describe, expect, it } from 'vitest';
import { transfersOf, type ToWorker, type WireZone } from '$lib/map/decoProtocol';
import type { DecoZone } from '$lib/map/decoZone';

function zone(gid: number, arcs: Float64Array[] | null, internal: Float64Array[] | null): WireZone {
	return {
		gid,
		key: `Z${gid}`,
		area: gid,
		bbox: { minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 },
		ring: new Float64Array([1, 2, 1, 4, 3, 4, 3, 2]),
		arcs,
		internal,
		spec: { line: null, band: null, marks: null, glyph: null, labelColor: '#000000', crossEligible: false, minZoom: { band: 0, marks: 0, glyph: 0, label: 0 } },
		label: { text: `Z ${gid}`, color: '#123456', chip: null },
	} satisfies DecoZone & { gid: number };
}

describe('transfersOf', () => {
	it('hands over every array of every zone, and a painting’s id lists', () => {
		const a = zone(1, [new Float64Array([1, 2, 1, 4])], [new Float64Array([1, 4, 3, 4])]);
		const b = zone(2, null, null);
		const zones: ToWorker = { type: 'zones', zones: [a, b] };
		expect(transfersOf(zones)).toEqual([a.ring.buffer, a.arcs?.[0].buffer, a.internal?.[0].buffer, b.ring.buffer]);
		const ids = new Uint32Array([1, 2]);
		const hl = new Uint32Array([2]);
		const outlined = new Uint32Array([1]);
		const paint: ToWorker = {
			type: 'paint',
			seq: 1,
			frame: {
				view: { zoom: 9, originX: 0, originY: 0, paneX: 0, paneY: 0 },
				topLeft: { x: 0, y: 0 },
				size: { x: 800, y: 600 },
				margin: { left: 0, top: 0, right: 0, bottom: 0 },
				dpr: 1,
				labels: true,
				lines: false,
			},
			width: 800,
			height: 600,
			zones: ids,
			highlighted: hl,
			outlined,
		};
		expect(transfersOf(paint)).toEqual([ids.buffer, hl.buffer, outlined.buffer]);
		const gids = new Uint32Array([7]);
		expect(transfersOf({ type: 'forget', gids })).toEqual([gids.buffer]);
	});

	it('lets a zone through a structured clone as it went, and takes its arrays from the page', () => {
		const withArcs = zone(1, [], [new Float64Array([1, 2, 1, 4, 3, 4, 3, 2, 1, 2])]);
		const without = zone(2, null, null);
		const msg: ToWorker = { type: 'zones', zones: [withArcs, without] };
		const ring = [...withArcs.ring];
		const copy = structuredClone(msg, { transfer: transfersOf(msg) });
		if (copy.type !== 'zones') {
			throw new Error('not a zones message');
		}
		expect([...copy.zones[0].ring]).toEqual(ring);
		expect(copy.zones[0].arcs).toEqual([]);
		expect(copy.zones[1].arcs).toBeNull();
		expect(copy.zones[1].internal).toBeNull();
		expect(copy.zones[0].label).toEqual(withArcs.label);
		expect(copy.zones[0].spec).toEqual(withArcs.spec);
		// Handed over: the page's own arrays are empty now.
		expect(withArcs.ring.byteLength).toBe(0);
		expect(without.ring.byteLength).toBe(0);
	});
});
