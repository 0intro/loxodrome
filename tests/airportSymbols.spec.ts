import { describe, expect, it, vi } from 'vitest';
import type { Airport, Runway } from '$lib/data/airports';
import {
	airportGlyph,
	airportStatus,
	airportSymbolReach,
	drawAirportGlyph,
	type AirportGlyph,
	facilityKind,
	isPaved,
	runwayBearing,
	runwayBars,
} from '$lib/map/airportSymbols';
import type { Paint2D } from '$lib/map/symbolBase';
import { FakePath, recorder } from './helpers/paint2d';

vi.stubGlobal('Path2D', FakePath);

function rwy(le: string, lengthFt: number | null = null, surface = 'ASP'): Runway {
	return {
		le,
		he: '',
		lengthFt,
		widthFt: null,
		surface,
		lit: false,
		leLdaFt: null,
		leToraFt: null,
		leTodaFt: null,
		leAsdaFt: null,
		heLdaFt: null,
		heToraFt: null,
		heTodaFt: null,
		heAsdaFt: null,
		leLighting: null,
		heLighting: null,
		lePos: null,
		hePos: null,
	};
}

// Only the listed fields matter for the function under test.
function airport(p: Partial<Airport>): Airport {
	return { runways: [], military: false, access: null, ...p } as unknown as Airport;
}

const bearings = (a: Airport) => runwayBars(a).map((b) => b.bearing);

describe('runwayBearing', () => {
	it('parses numeric designators to magnetic headings', () => {
		expect(runwayBearing('09')).toBe(90);
		expect(runwayBearing('9')).toBe(90);
		expect(runwayBearing('27')).toBe(270);
		expect(runwayBearing('36')).toBe(360);
		expect(runwayBearing('14L')).toBe(140);
		expect(runwayBearing('32R')).toBe(320);
	});

	it('returns null for non-directional or out-of-range ends', () => {
		expect(runwayBearing('H1')).toBeNull();
		expect(runwayBearing('')).toBeNull();
		expect(runwayBearing('N')).toBeNull();
		expect(runwayBearing('00')).toBeNull();
		expect(runwayBearing('37')).toBeNull();
	});
});

describe('facilityKind', () => {
	it('maps the OurAirports type to a drawing kind', () => {
		expect(facilityKind('large_airport')).toBe('aerodrome');
		expect(facilityKind('medium_airport')).toBe('aerodrome');
		expect(facilityKind('small_airport')).toBe('aerodrome');
		expect(facilityKind('balloonport')).toBe('aerodrome');
		expect(facilityKind('heliport')).toBe('heliport');
		expect(facilityKind('seaplane_base')).toBe('seaplane');
		expect(facilityKind('closed')).toBe('closed');
		expect(facilityKind('emergency_aerodrome')).toBe('emergency');
	});
});

describe('airportStatus', () => {
	it('is civil with no military/restricted markers', () => {
		expect(airportStatus(airport({}))).toBe('civil');
		expect(airportStatus(airport({ access: 'cap' }))).toBe('civil');
	});
	it('is military when flagged and not open to civil traffic', () => {
		expect(airportStatus(airport({ military: true }))).toBe('military');
	});
	it('is joint when military and open to civil traffic (STATE + GAT)', () => {
		expect(airportStatus(airport({ military: true, access: 'cap' }))).toBe('joint');
	});
	it('is military regardless of access restriction', () => {
		expect(airportStatus(airport({ military: true, access: 'restricted' }))).toBe('military');
	});
	it('is restricted when civil and restricted', () => {
		expect(airportStatus(airport({ access: 'restricted' }))).toBe('restricted');
	});
});

describe('runwayBars', () => {
	it('returns the single bearing for a one-runway field', () => {
		expect(bearings(airport({ runways: [rwy('09')] }))).toEqual([90]);
	});
	it('says per bar whether the runway has a paved part', () => {
		expect(runwayBars(airport({ runways: [rwy('09', 3000, 'ASP')] }))[0].paved).toBe(true);
		expect(runwayBars(airport({ runways: [rwy('09', 3000, 'TURF')] }))[0].paved).toBe(false);
		// Mixed (paved with a grass part) is paved; unreadable is not.
		expect(runwayBars(airport({ runways: [rwy('09', 3000, 'ASP+GRS')] }))[0].paved).toBe(true);
		expect(runwayBars(airport({ runways: [rwy('09', 3000, 'UNK')] }))[0].paved).toBe(false);
		expect(runwayBars(airport({ runways: [rwy('09', 3000, '')] }))[0].paved).toBe(false);
	});
	it('collapses a parallel pair to one orientation', () => {
		expect(bearings(airport({ runways: [rwy('14L', 9000), rwy('14R', 8000)] }))).toEqual([140]);
	});
	it('keeps two distinct orientations, longest runway first', () => {
		expect(bearings(airport({ runways: [rwy('13', 7000), rwy('04', 11000)] }))).toEqual([40, 130]);
	});
	it('caps at two bars and ignores non-numeric ends', () => {
		expect(runwayBars(airport({ runways: [rwy('09', 5000), rwy('18', 4000), rwy('13', 3000)] }))).toHaveLength(2);
		expect(runwayBars(airport({ runways: [rwy('H1'), rwy('N')] }))).toEqual([]);
	});
});

describe('runwayBars pavedOnly', () => {
	it('keeps only the runways with a paved part', () => {
		const a = airport({ runways: [rwy('09', 9000, 'GRASS'), rwy('13', 7000, 'ASP')] });
		expect(runwayBars(a, true).map((b) => b.bearing)).toEqual([130]);
	});
	it('keeps a short paved runway parallel to a longer grass one', () => {
		// The default dedup would drop the parallel paved runway behind the longer grass.
		const a = airport({ runways: [rwy('18', 9000, 'GRASS'), rwy('18', 3000, 'ASP')] });
		expect(runwayBars(a)[0].paved).toBe(false); // longest (grass) wins
		expect(runwayBars(a, true)).toHaveLength(1); // the paved runway survives
	});
	it('is empty when no runway is known to be paved', () => {
		expect(runwayBars(airport({ runways: [rwy('09', 3000, 'GRASS')] }), true)).toEqual([]);
		expect(runwayBars(airport({ runways: [rwy('09', 3000, 'UNK'), rwy('13', 2000, 'X')] }), true)).toEqual([]);
	});
});

describe('isPaved', () => {
	it('is true when any directional runway is hard-surfaced', () => {
		expect(isPaved(airport({ runways: [rwy('09', 5000, 'ASP')] }))).toBe(true);
		expect(isPaved(airport({ runways: [rwy('09', 9000, 'GRASS'), rwy('27', 3000, 'CONC')] }))).toBe(true);
	});
	it('is false for grass-only, no runway, or no known direction', () => {
		expect(isPaved(airport({ runways: [rwy('09', 5000, 'TURF')] }))).toBe(false);
		// Not KNOWN to be paved: an empty or unreadable surface draws the open
		// circle (docs/airport-symbols.md); it used to default to paved.
		expect(isPaved(airport({ runways: [rwy('09', 5000, '')] }))).toBe(false);
		expect(isPaved(airport({ runways: [rwy('09', 5000, 'UNK')] }))).toBe(false);
		expect(isPaved(airport({ runways: [] }))).toBe(false);
		expect(isPaved(airport({ runways: [rwy('H1', 3000, 'ASP')] }))).toBe(false);
	});
});

describe('airportGlyph', () => {
	const glyph = (p: Partial<Airport>) => {
		const g = airportGlyph(airport(p));
		return { kind: g.kind, status: g.status, bars: [...g.bars] };
	};

	it('carries the bars a paved civil, joint or military field draws, longest first', () => {
		const runways = [rwy('13', 7000), rwy('04', 11000)];
		expect(glyph({ type: 'large_airport', runways })).toEqual({ kind: 'aerodrome', status: 'civil', bars: [40, 130] });
		expect(glyph({ type: 'small_airport', runways, military: true })).toEqual({ kind: 'aerodrome', status: 'military', bars: [40, 130] });
		expect(glyph({ type: 'medium_airport', runways, military: true, access: 'cap' })).toEqual({ kind: 'aerodrome', status: 'joint', bars: [40, 130] });
		// Only the paved runways: a grass field draws the open body, no bar,
		// and so does one whose surface nobody can read.
		expect(glyph({ type: 'small_airport', runways: [rwy('09', 3000, 'GRASS')] }).bars).toEqual([]);
		expect(glyph({ type: 'small_airport', runways: [rwy('09', 3000, 'UNK')] }).bars).toEqual([]);
	});

	it('carries no bar where the symbol draws none', () => {
		const runways = [rwy('09', 5000)];
		expect(glyph({ type: 'small_airport', runways, access: 'restricted' })).toEqual({ kind: 'aerodrome', status: 'restricted', bars: [] });
		expect(glyph({ type: 'heliport', runways, military: true })).toEqual({ kind: 'heliport', status: 'military', bars: [] });
		expect(glyph({ type: 'seaplane_base', runways })).toEqual({ kind: 'seaplane', status: 'civil', bars: [] });
		// The closed mark shows no status either.
		expect(glyph({ type: 'closed', runways, military: true })).toEqual({ kind: 'closed', status: 'civil', bars: [] });
	});

	it('is read once per row, and a copy of the row reads its own', () => {
		const a = airport({ type: 'small_airport', runways: [rwy('09', 5000)] });
		expect(airportGlyph(a)).toBe(airportGlyph(a));
		const b = { ...a };
		expect(airportGlyph(b)).not.toBe(airportGlyph(a));
		expect(airportGlyph(b).key).toBe(airportGlyph(a).key);
	});

	it('draws the same for two fields with one key, and apart for two keys', () => {
		const calls = (a: Airport): string => {
			const r = recorder();
			drawAirportGlyph(r.ctx, airportGlyph(a), 0, 0, 7);
			return r.ops.join(' ');
		};
		const lfpg = airport({ type: 'large_airport', ident: 'LFPG', runways: [rwy('09L', 13800), rwy('08R', 8900), rwy('09R', 8800)] });
		const lfpo = airport({ type: 'medium_airport', ident: 'LFPO', runways: [rwy('08', 11900), rwy('07', 7900)] });
		// One bar each, 90 and 80: two keys, two drawings.
		expect(airportGlyph(lfpg).key).not.toBe(airportGlyph(lfpo).key);
		expect(calls(lfpg)).not.toBe(calls(lfpo));
		const twin = airport({ type: 'small_airport', ident: 'XXXX', runways: [rwy('09', 2000), rwy('08', 1000, 'CONC')] });
		expect(airportGlyph(twin).key).toBe(airportGlyph(lfpg).key);
		expect(calls(twin)).toBe(calls(lfpg));
		const heli = (p: Partial<Airport>) => calls(airport({ type: 'heliport', ...p }));
		expect(heli({ runways: [rwy('H1')] })).toBe(heli({ runways: [rwy('09', 900)] }));
	});
});

/** The farthest any shape a painter draws reaches from its anchor, CSS px:
 *  every point of a path (a circle's centre plus its radius), plus half the
 *  width of the line a stroke draws it with. A rotation about the anchor
 *  (the runway bars) keeps it. */
function farthest(draw: (ctx: Paint2D) => void): number {
	let lineWidth = 1;
	let far = 0;
	const extent = (p: FakePath): number => {
		let m = 0;
		for (const op of p.ops) {
			const n = op.slice(1).split(',').map(Number);
			switch (op[0]) {
				case 'M':
				case 'L':
					m = Math.max(m, Math.hypot(n[0], n[1]));
					break;
				case 'A':
					m = Math.max(m, Math.hypot(n[0], n[1]) + n[2]);
					break;
				case 'R':
					for (const [x, y] of [
						[n[0], n[1]],
						[n[0] + n[2], n[1]],
						[n[0], n[1] + n[3]],
						[n[0] + n[2], n[1] + n[3]],
					]) {
						m = Math.max(m, Math.hypot(x, y));
					}
					break;
				case 'T':
					m = Math.max(m, Math.hypot(n[0], n[1]), Math.hypot(n[2], n[3]));
					break;
				case 'Z':
					break;
				default:
					throw new Error(`a path op the spec does not read: ${op}`);
			}
		}
		return m;
	};
	const ctx = new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === 'fill') {
					return (p: FakePath) => {
						far = Math.max(far, extent(p));
					};
				}
				if (prop === 'stroke') {
					return (p: FakePath) => {
						far = Math.max(far, extent(p) + lineWidth / 2);
					};
				}
				return () => {};
			},
			set(_t, prop, v) {
				if (prop === 'lineWidth') {
					lineWidth = v as number;
				}
				return true;
			},
		},
	);
	draw(ctx as unknown as Paint2D);
	return far;
}

describe('airportSymbolReach', () => {
	const glyphs: AirportGlyph[] = [];
	for (const status of ['civil', 'military', 'joint'] as const) {
		for (const bars of [[], [90], [40, 130]]) {
			glyphs.push({ kind: 'aerodrome', status, bars, key: '' });
		}
	}
	glyphs.push({ kind: 'aerodrome', status: 'restricted', bars: [], key: '' });
	for (const kind of ['heliport', 'seaplane'] as const) {
		for (const status of ['civil', 'military', 'joint', 'restricted'] as const) {
			glyphs.push({ kind, status, bars: [], key: '' });
		}
	}
	glyphs.push({ kind: 'closed', status: 'civil', bars: [], key: '' });
	glyphs.push({ kind: 'emergency', status: 'civil', bars: [], key: '' });

	for (const s of [7, 10]) {
		it(`holds every shape a symbol of radius ${s} draws, its strokes and a pixel of fringe`, () => {
			const r = airportSymbolReach(s);
			const inside = Math.min(r.left, r.top, r.right, r.bottom);
			for (const g of glyphs) {
				const far = farthest((ctx) => {
					drawAirportGlyph(ctx, g, 0, 0, s);
				});
				expect(far, `${g.kind} ${g.status} ${g.bars.join(',')}`).toBeGreaterThan(s * 0.9);
				expect(far + 1, `${g.kind} ${g.status} ${g.bars.join(',')}`).toBeLessThanOrEqual(inside);
			}
		});
	}
});
