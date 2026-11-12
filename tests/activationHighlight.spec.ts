/* The activation hatch is drawn once per activated airspace ID, from whichever
 * row the id index kept; a SELECTION names one ROW. Several rows share an id (a
 * MOA parent and its exclusion rings, ENAIRE's FIR + UIR + TMA under one
 * letter), and airspaceAt answers with the smallest row containing the point,
 * which is routinely not the row the hatch was built from.
 *
 * While the hatch took its own clicks the two could not disagree: its handler
 * selected the very key it had stored. Now that clicks are resolved by
 * featureAt, like every other filled area, the highlight has to meet the
 * selection on the ID they share, or a zone selected on the map would leave its
 * stripes unbolded (docs/map-hit-testing.md). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Airspace } from '$lib/data/airspaces';

/** The stroke-width pokes setPathStrokeWidth lands on each polygon's element,
 *  which is the whole of the selected signal for a hatch. */
interface FakeEl {
	strokeWidth: string | null;
}

const built: { ring: unknown; el: FakeEl }[] = vi.hoisted(() => []);

vi.mock('leaflet', () => {
	const built_ = built;
	class Polygon {
		el: FakeEl = { strokeWidth: null };
		constructor(public ring: unknown) {
			built_.push({ ring, el: this.el });
		}
		addTo(): this {
			return this;
		}
		on(): this {
			return this;
		}
		bringToFront(): this {
			return this;
		}
		getElement(): { setAttribute(name: string, value: string): void } {
			const el = this.el;
			return {
				setAttribute(name: string, value: string) {
					if (name === 'stroke-width') {
						el.strokeWidth = value;
					}
				},
			};
		}
	}
	const L = {
		// emphasisClones pulls in directDrawLayer, which subclasses L.Layer at
		// module scope; this spec never instantiates one.
		Layer: class {},
		Path: Polygon,
		polygon: (ring: unknown) => new Polygon(ring),
		svg: () => ({}),
		canvas: () => ({}),
		DomEvent: { stopPropagation: () => {} },
	};
	return { default: L, ...L };
});

const { renderActivations, highlightActivation, clearActivations, isActivationDrawn } =
	await import('$lib/map/activationLayer');

/** A map stub: the hatch only creates its pane and adds / removes layers. */
const map = {
	getPane: () => ({ style: {} }),
	createPane: () => ({ style: {} }),
	removeLayer: () => {},
} as unknown as import('leaflet').Map;

/** Two rows of ONE id, as a parent and its exclusion ring are filed. */
function row(id: string, name: string): Airspace {
	return {
		id,
		key: `${id}|${name}`,
		name,
		category: 'restricted',
		ring: [
			[48, 2],
			[48, 3],
			[49, 3],
		],
	} as unknown as Airspace;
}

const PARENT = row('LF-R 205', 'R 205 A');
const SUBRING = row('LF-R 205', 'R 205 A2');

beforeEach(() => {
	clearActivations(map);
	built.length = 0;
	// The id index keeps ONE row per id, the last one it saw; the hatch is
	// built from that row and knows nothing of its siblings.
	renderActivations(map, new Map([['LF-R 205', []]]), new Map([['LF-R 205', PARENT]]));
});

describe('highlightActivation', () => {
	it('draws one hatch per activated id', () => {
		expect(built).toHaveLength(1);
		expect(isActivationDrawn('LF-R 205')).toBe(true);
	});

	it('bolds the stripes for the row the hatch was built from', () => {
		highlightActivation(PARENT.key);
		expect(built[0].el.strokeWidth).toBe('3');
	});

	it('bolds them for a SIBLING row of the same id', () => {
		// The case the click resolver produces: airspaceAt returned the
		// smallest containing row, which is not the one the id index kept.
		highlightActivation(SUBRING.key);
		expect(built[0].el.strokeWidth).toBe('3');
	});

	it('restores the weight when the selection leaves', () => {
		highlightActivation(SUBRING.key);
		highlightActivation(null);
		expect(built[0].el.strokeWidth).toBe('2');
	});

	it("leaves another airspace's hatch alone", () => {
		highlightActivation('LF-R 999|SOMETHING ELSE');
		expect(built[0].el.strokeWidth).toBeNull();
	});
});
