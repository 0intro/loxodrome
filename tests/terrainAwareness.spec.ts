/* The relative-terrain rule (nav/terrainAwareness.ts, docs/terrain-awareness.md)
 * and the altitude it is read against (state/terrainAwareness.svelte.ts).
 *
 * The rule is Garmin's Terrain Proximity, read out of the GPS 175 firmware:
 * red at or above the aircraft or less than 100 ft below, yellow 100 to
 * 1 000 ft below, clear beyond. What these pins hold is that every surface
 * reading it (the raster's integer-metre compare, the obstacle tint in feet)
 * lands on the SAME tier, on real Alpine ground and not only on round
 * numbers, and that the reference is withheld exactly where Garmin shows
 * TER N/A. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	FT_PER_M,
	OBSTACLE_TIER_INK,
	REFERENCE_HYSTERESIS_FT,
	REFERENCE_QUANTUM_FT,
	TERRAIN_BANDS,
	nextReferenceFt,
	quantiseReferenceFt,
	relativeTier,
	tierThresholdsM,
} from '$lib/nav/terrainAwareness';
import { decodeTerrainTile } from '$lib/map/terrainTile';
import { NO_DATA } from '$lib/map/terrain';
import { bandColours, paintTile } from '$lib/map/terrainShade';

describe('the bands', () => {
	it('are the firmware fixed-wing pair, most severe first', () => {
		expect(TERRAIN_BANDS.map((b) => [b.tier, b.belowFt, b.ink])).toEqual([
			['red', 100, '#ff0000'],
			['yellow', 1000, '#ffff00'],
		]);
		// The obstacle yellow is the firmware's darker one, not the terrain's.
		expect(OBSTACLE_TIER_INK).toEqual({ red: '#ff0000', yellow: '#d2d200' });
	});

	it('grade a height at its edges exactly', () => {
		const ref = 3000;
		expect(relativeTier(3500, ref)).toBe('red'); // above the aircraft
		expect(relativeTier(3000, ref)).toBe('red');
		expect(relativeTier(2900, ref)).toBe('red'); // exactly 100 ft below
		expect(relativeTier(2899.9, ref)).toBe('yellow');
		expect(relativeTier(2000, ref)).toBe('yellow'); // exactly 1 000 ft below
		expect(relativeTier(1999.9, ref)).toBeNull();
		expect(relativeTier(null, ref)).toBeNull();
		expect(relativeTier(Number.NaN, ref)).toBeNull();
		expect(relativeTier(100, Number.NaN)).toBeNull();
	});

	it('quantise the reference DOWN to 10 ft, never above the aircraft', () => {
		expect(quantiseReferenceFt(1234)).toBe(1230);
		expect(quantiseReferenceFt(1239.9)).toBe(1230);
		expect(quantiseReferenceFt(-4)).toBe(-10);
		expect(quantiseReferenceFt(7406.2)).toBe(7400);
		for (let ft = -50; ft < 5000; ft += 0.7) {
			expect(quantiseReferenceFt(ft)).toBeLessThanOrEqual(ft);
		}
	});

	it('move the reference down at once and up only past the hysteresis', () => {
		// Hovering on a step boundary: 1 199 / 1 201 / 1 199 ... used to flip
		// 1 200 <-> 1 190 on every fix and repaint every tile in view.
		let ref: number | null = null;
		const seen = new Set<number>();
		for (let i = 0; i < 40; i++) {
			ref = nextReferenceFt(ref, i % 2 === 0 ? 1199 : 1201);
			seen.add(ref);
		}
		expect([...seen]).toEqual([1190]);
		// A climb takes the step once clear of the jitter.
		expect(nextReferenceFt(1190, 1202.9)).toBe(1190);
		expect(nextReferenceFt(1190, 1203)).toBe(1200);
		// A descent below the step moves it at once: never above the aircraft.
		expect(nextReferenceFt(1200, 1199.5)).toBe(1190);
		// Whatever the sequence, the reference stands at or below the altitude.
		ref = null;
		for (let i = 0; i < 2000; i++) {
			const ft = 3000 + 40 * Math.sin(i / 7) + ((i * 37) % 11) - 5;
			ref = nextReferenceFt(ref, ft);
			expect(ref).toBeLessThanOrEqual(ft);
			expect(ft - ref).toBeLessThan(REFERENCE_QUANTUM_FT + REFERENCE_HYSTERESIS_FT);
		}
	});

	it('put the raster metre edges exactly where the feet rule does', () => {
		for (const ref of [0, 130, 1000, 2350, 7400, 12345.6]) {
			const thr = tierThresholdsM(ref);
			for (let v = -500; v <= 5000; v++) {
				const tier = relativeTier(v * FT_PER_M, ref);
				const byMetres = v >= thr[0] ? 'red' : v >= thr[1] ? 'yellow' : null;
				expect(byMetres, `ref ${ref} ft, ground ${v} m`).toBe(tier);
			}
		}
	});
});

describe('the shading over real ground', () => {
	it('colours each pixel of an Alpine tile by the tier its own maximum reaches', async () => {
		const tile = await decodeTerrainTile(readFileSync('tests/fixtures/terrain-alps-12-2126-1459.tile'));
		expect(tile).not.toBeNull();
		const max = tile!.max ?? tile!.mean;
		const out = new Uint32Array(max.length);
		const colours = bandColours();
		// Mid-slope: some of the tile red, some yellow, some clear.
		const ref = 9000;
		const painted = paintTile(out, max, tierThresholdsM(ref), colours);
		let red = 0;
		let yellow = 0;
		for (let i = 0; i < max.length; i++) {
			const v = max[i];
			const tier = v === NO_DATA ? null : relativeTier(v * FT_PER_M, ref);
			const want = tier === 'red' ? colours[0] : tier === 'yellow' ? colours[1] : 0;
			if (out[i] !== want) {
				throw new Error(`pixel ${i}: ${v} m against ${ref} ft painted ${out[i]}, the rule says ${want}`);
			}
			red += tier === 'red' ? 1 : 0;
			yellow += tier === 'yellow' ? 1 : 0;
		}
		expect(painted).toBe(red + yellow);
		// The fixture is Mont Blanc's tile: at 9 000 ft all three answers occur.
		expect(red).toBeGreaterThan(1000);
		expect(yellow).toBeGreaterThan(1000);
		expect(max.length - red - yellow).toBeGreaterThan(1000);
	});
});

function workingStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	} as unknown as Storage;
}

describe('the persisted layer choice', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.stubGlobal('localStorage', workingStorage());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('is on by default and stores nothing while it is', async () => {
		const { layers, persistLayers } = await import('$lib/state/layers.svelte');
		expect(layers.terrainAwareness).toBe(true);
		persistLayers();
		expect(localStorage.getItem('loxodrome:layers')).toBeNull();
		layers.terrainAwareness = false;
		persistLayers();
		expect(JSON.parse(localStorage.getItem('loxodrome:layers') ?? '{}')).toMatchObject({
			v: 1,
			terrainAwareness: false,
		});
	});

	it('reads back off, and a stale or malformed doc falls back to on', async () => {
		localStorage.setItem('loxodrome:layers', JSON.stringify({ v: 1, terrainAwareness: false }));
		expect((await import('$lib/state/layers.svelte')).layers.terrainAwareness).toBe(false);
		vi.resetModules();
		localStorage.setItem('loxodrome:layers', JSON.stringify({ v: 1, terrainAwareness: 'no' }));
		expect((await import('$lib/state/layers.svelte')).layers.terrainAwareness).toBe(true);
		vi.resetModules();
		// A doc from before the field: every other field kept, this one on.
		localStorage.setItem('loxodrome:layers', JSON.stringify({ v: 1, supaip: true }));
		const { layers } = await import('$lib/state/layers.svelte');
		expect(layers.supaip).toBe(true);
		expect(layers.terrainAwareness).toBe(true);
	});
});

describe('the reference altitude', () => {
	const T0 = Date.parse('2026-07-08T13:30:00Z');

	function trace(alt: number | null): { lat: number; lon: number; altFt: number | null; timeMs: number; speedKt: number; trackDeg: number }[] {
		return Array.from({ length: 30 }, (_, i) => ({
			lat: 46.2 + i * 0.001,
			lon: 6.3,
			altFt: alt == null ? null : alt + i * 10,
			timeMs: T0 + i * 1000,
			speedKt: 100,
			trackDeg: 0,
		}));
	}

	beforeEach(() => {
		vi.resetModules();
		vi.stubGlobal('localStorage', workingStorage());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('is nothing without a pose, and the playhead altitude in replay', async () => {
		const rec = await import('$lib/state/navRecording.svelte');
		const ta = await import('$lib/state/terrainAwareness.svelte');
		expect(ta.terrainReferenceState()).toEqual({ ref: null, withheld: null });
		rec.importTrace(trace(4200), 'msl');
		// importTrace parks the playhead on the trace's first fix.
		expect(ta.terrainReference()).toEqual({ altFt: 4200, source: 'replay' });
		rec.setPlayhead(T0 + 10_000);
		expect(ta.terrainReference()?.altFt).toBeCloseTo(4300, 6);
	});

	it('is withheld, and says why, where the pose has no altitude', async () => {
		const rec = await import('$lib/state/navRecording.svelte');
		const ta = await import('$lib/state/terrainAwareness.svelte');
		rec.importTrace(trace(null), 'msl');
		expect(ta.terrainReferenceState()).toEqual({ ref: null, withheld: 'noAltitude' });
	});

	it('is withheld on a degraded or lost live fix, Garmin TER N/A', async () => {
		const rec = await import('$lib/state/navRecording.svelte');
		const ta = await import('$lib/state/terrainAwareness.svelte');
		const fix = { lat: 46.2, lon: 6.3, altFt: 5000, timeMs: T0, speedKt: 100, trackDeg: 0, accuracyM: 5 };
		rec.nav.traceDatum = 'msl';
		rec.nav.recording = true;
		rec.nav.lastFix = fix;
		rec.nav.nowMs = T0 + 1_000;
		expect(ta.terrainReference()).toEqual({ altFt: 5000, source: 'live' });
		rec.nav.nowMs = T0 + 6_000; // past STALE_MS
		expect(ta.terrainReferenceState()).toEqual({ ref: null, withheld: 'degraded' });
		rec.nav.nowMs = T0 + 16_000; // past LOST_MS
		expect(ta.terrainReferenceState()).toEqual({ ref: null, withheld: 'lost' });
		rec.nav.nowMs = T0 + 1_000;
		rec.nav.lastFix = { ...fix, accuracyM: 80 }; // coarser than DEGRADED_ACCURACY_M
		expect(ta.terrainReferenceState().withheld).toBe('degraded');
		rec.nav.recording = false;
	});
});
