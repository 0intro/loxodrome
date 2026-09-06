import { describe, expect, it } from 'vitest';
import type { Airport, Runway } from '$lib/data/airports';
import {
	airportStatus,
	facilityKind,
	isHardSurface,
	isPaved,
	runwayBearing,
	runwayBars,
} from '$lib/map/airportSymbols';

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

describe('isHardSurface', () => {
	it('treats paved keywords as hard', () => {
		for (const s of ['ASP', 'ASPH', 'ASPHALT', 'CON', 'CONC', 'CONCRETE', 'PEM', 'BIT']) {
			expect(isHardSurface(s)).toBe(true);
		}
	});
	it('treats unpaved keywords as soft', () => {
		for (const s of ['TURF', 'GRASS', 'GRS', 'GVL', 'GRAVEL', 'DIRT', 'EARTH', 'WATER']) {
			expect(isHardSurface(s)).toBe(false);
		}
	});
	it('defaults unknown surfaces to hard', () => {
		expect(isHardSurface('UNK')).toBe(true);
		expect(isHardSurface('')).toBe(true);
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
	it('carries the surface hardness per bar', () => {
		expect(runwayBars(airport({ runways: [rwy('09', 3000, 'ASP')] }))[0].hard).toBe(true);
		expect(runwayBars(airport({ runways: [rwy('09', 3000, 'TURF')] }))[0].hard).toBe(false);
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

describe('runwayBars hardOnly', () => {
	it('keeps only hard-surfaced runways', () => {
		const a = airport({ runways: [rwy('09', 9000, 'GRASS'), rwy('13', 7000, 'ASP')] });
		expect(runwayBars(a, true).map((b) => b.bearing)).toEqual([130]);
	});
	it('keeps a short paved runway parallel to a longer grass one', () => {
		// The default dedup would drop the parallel paved runway behind the longer grass.
		const a = airport({ runways: [rwy('18', 9000, 'GRASS'), rwy('18', 3000, 'ASP')] });
		expect(runwayBars(a)[0].hard).toBe(false); // longest (grass) wins
		expect(runwayBars(a, true)).toHaveLength(1); // the paved runway survives
	});
	it('is empty when no runway is hard', () => {
		expect(runwayBars(airport({ runways: [rwy('09', 3000, 'GRASS')] }), true)).toEqual([]);
	});
});

describe('isPaved', () => {
	it('is true when any directional runway is hard-surfaced', () => {
		expect(isPaved(airport({ runways: [rwy('09', 5000, 'ASP')] }))).toBe(true);
		expect(isPaved(airport({ runways: [rwy('09', 9000, 'GRASS'), rwy('27', 3000, 'CONC')] }))).toBe(true);
	});
	it('is false for grass-only, no runway, or no known direction', () => {
		expect(isPaved(airport({ runways: [rwy('09', 5000, 'TURF')] }))).toBe(false);
		expect(isPaved(airport({ runways: [] }))).toBe(false);
		expect(isPaved(airport({ runways: [rwy('H1', 3000, 'ASP')] }))).toBe(false);
	});
});
