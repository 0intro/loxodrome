/* Pins the chart-palette single source of truth (src/lib/map/palette.ts):
 * every canonical hex as a literal (the drift-guard: a palette edit must
 * consciously touch this spec), the identity relations the chart defines,
 * and per-category completeness of the derived sets. The CSS mirrors are
 * locked separately by tests/paletteSync.spec.ts. */
import { describe, expect, it } from 'vitest';
import {
	ACTIVATION_HATCH_FILL,
	ACTIVATION_STROKE,
	AEM_BAND,
	AIRPORT,
	AIRSPACE_CHIP_DAY,
	AIRSPACE_CHIP_NIGHT,
	CUE_RING,
	DARK,
	FIR_INTERNAL,
	HALO,
	LABEL_HALO,
	NAVAID,
	OBSTACLE_INK,
	PAPER,
	SIA,
} from '$lib/map/palette';
import type { AirspaceCategory } from '$lib/state/layers.svelte';

const CATEGORIES = [
	'controlled', 'restricted', 'activity', 'trafficmgmt', 'transit', 'siv', 'fir',
] as const;

describe('SIA inks (Legende2026 flat samples)', () => {
	it('pins every ink', () => {
		expect(SIA).toEqual({
			zone: '#E30613',
			ctl: '#164194',
			classE: '#87B1E3',
			siv: '#00713C',
			dlg: '#004D91',
			ink: '#1D1D1B',
			inkSoft: '#3D3D3C',
			tra: '#C3854A',
		});
	});

	it('pins the aeromodelling bands, high = the family red', () => {
		expect(AEM_BAND).toEqual({ low: '#EF7D00', mid: '#AB3A8D', high: '#E30613' });
		expect(AEM_BAND.high).toBe(SIA.zone);
	});

	it('pins every dark hover companion', () => {
		expect(DARK).toEqual({
			'#E30613': '#9B040D',
			'#164194': '#0D2A62',
			'#87B1E3': '#0D2A62',
			'#00713C': '#004726',
			'#004D91': '#003564',
			'#1D1D1B': '#000000',
			'#3D3D3C': '#1D1D1B',
			'#C3854A': '#8F5D2E',
			'#EF7D00': '#A85800',
			'#AB3A8D': '#73265E',
		});
	});
});

describe('point-symbol inks', () => {
	it('pins the aerodrome panel', () => {
		expect(AIRPORT).toEqual({
			civil: '#164194',
			military: '#E52E15',
			militaryGlyph: '#E30613',
			restrictedFill: '#c9ccd1',
			restrictedRing: '#3a4250',
			closedInk: '#1D1D1B',
		});
	});

	it('pins the navaid inks', () => {
		expect(NAVAID).toEqual({
			radionav: '#164194',
			ils: '#d2691e',
			waypoint: '#5a6470',
			unserviceable: '#878d96',
		});
	});

	it('pins the supporting inks', () => {
		expect(OBSTACLE_INK).toBe('#164194');
		expect(PAPER).toBe('#ffffff');
		expect(HALO).toBe('rgba(255, 255, 255, 0.92)');
		expect(LABEL_HALO).toBe('rgba(255, 255, 255, 0.85)');
		expect(CUE_RING).toBe('#cb2026');
		// Visually matched (the chart scan is not colour-authoritative).
		expect(FIR_INTERNAL).toBe('#9A9A9A');
	});

	it('holds the chart-defined identities', () => {
		expect(AIRPORT.civil).toBe(SIA.ctl);
		expect(AIRPORT.militaryGlyph).toBe(SIA.zone);
		expect(AIRPORT.closedInk).toBe(SIA.ink);
		expect(NAVAID.radionav).toBe(SIA.ctl);
		expect(OBSTACLE_INK).toBe(SIA.ctl);
	});
});

describe('per-category derived sets', () => {
	it('pins the day chips', () => {
		expect(AIRSPACE_CHIP_DAY).toEqual({
			controlled: '#164194',
			restricted: '#E30613',
			activity: '#f0767d',
			trafficmgmt: '#1D1D1B',
			transit: '#C3854A',
			siv: '#00713C',
			fir: '#1D1D1B',
		});
	});

	it('pins the night chips', () => {
		expect(AIRSPACE_CHIP_NIGHT).toEqual({
			controlled: '#5c85d6',
			restricted: '#ff5a52',
			activity: '#ff8d86',
			trafficmgmt: '#cfd3d7',
			transit: '#d99a5e',
			siv: '#25b563',
			fir: '#9aa3ad',
		});
	});

	it('pins the activation strokes as the dark companions', () => {
		expect(ACTIVATION_STROKE).toEqual({
			controlled: '#0D2A62',
			restricted: '#9B040D',
			activity: '#9B040D',
			trafficmgmt: '#000000',
			transit: '#8F5D2E',
			siv: '#004726',
			fir: '#000000',
		});
	});

	it('pins the activation hatch fills as the base inks', () => {
		expect(ACTIVATION_HATCH_FILL).toEqual({
			controlled: '#164194',
			restricted: '#E30613',
			activity: '#E30613',
			trafficmgmt: '#1D1D1B',
			transit: '#C3854A',
			siv: '#00713C',
			fir: '#1D1D1B',
		});
	});

	it('covers every airspace category, exactly', () => {
		// Compile-time completeness against the category union...
		const dayCheck: Record<AirspaceCategory, string> = AIRSPACE_CHIP_DAY;
		const nightCheck: Record<AirspaceCategory, string> = AIRSPACE_CHIP_NIGHT;
		const strokeCheck: Record<AirspaceCategory, string> = ACTIVATION_STROKE;
		const fillCheck: Record<AirspaceCategory, string> = ACTIVATION_HATCH_FILL;
		void dayCheck; void nightCheck; void strokeCheck; void fillCheck;
		// ...and runtime key-set equality (no extras, no gaps).
		const want = [...CATEGORIES].sort();
		for (const set of [AIRSPACE_CHIP_DAY, AIRSPACE_CHIP_NIGHT,
			ACTIVATION_STROKE, ACTIVATION_HATCH_FILL]) {
			expect(Object.keys(set).sort()).toEqual(want);
		}
	});
});
