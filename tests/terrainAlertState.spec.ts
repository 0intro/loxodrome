/* The terrain-alert state around the pure fold (state/terrainAlert.svelte.ts):
 * the session memory belongs to ONE trace, the pilot's inhibit with it; a
 * replay debrief queues no chime; and a corridor tile that lands re-evaluates
 * on its own, the tile cache being a plain Map nothing reactive watches.
 *
 * The capsule fold is the real one; only the tile source is faked: a world of
 * 300 m ground with a 1 200 m ridge across the path, WALL_M thick, starting at
 * `wallLon`. The aircraft flies east at 120 kt and 3 500 ft, so the ridge
 * stands about 440 ft above its path. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecodedTile } from '$lib/map/terrain';
import type { TrackPoint } from '$lib/nav/trace';

const world = vi.hoisted(() => ({
	/** False: no tile is in hand yet (every lookup answers "loading"). */
	ready: true,
	wallLon: 0,
	/** A bowl instead of the wall: 300 m ground inside a 1 500 m rim
	 *  2 300 to 3 300 m from this centre. */
	bowl: null as { lat: number; lon: number } | null,
	visits: 0,
}));

/** The ridge's thickness along the path. */
const WALL_M = 400;

vi.mock('$lib/map/terrain', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/map/terrain')>();
	const { equirectangularDistanceM } = await import('$lib/notam/geometry');
	const cache = new Map<string, DecodedTile>();
	const wallDeg = WALL_M / (111_320 * Math.cos((46 * Math.PI) / 180));
	const lookup = (z: number, x: number, y: number): DecodedTile | undefined => {
		if (!world.ready) {
			return undefined;
		}
		const bowl = world.bowl;
		const key = `${z}/${x}/${y}/${bowl ? `${bowl.lat},${bowl.lon}` : world.wallLon}`;
		let tile = cache.get(key);
		if (!tile) {
			const max = new Int16Array(256 * 256);
			for (let col = 0; col < 256; col++) {
				const lon = real.tileColLon(z, x, col);
				const h = lon >= world.wallLon && lon < world.wallLon + wallDeg ? 1200 : 300;
				for (let row = 0; row < 256; row++) {
					if (bowl) {
						const d = equirectangularDistanceM(bowl.lat, bowl.lon, real.tileRowLat(z, y, row), lon);
						max[row * 256 + col] = d >= 2300 && d <= 3300 ? 1500 : 300;
					} else {
						max[row * 256 + col] = h;
					}
				}
			}
			tile = { z, tx: x, ty: y, mean: max, max, min: max };
			cache.set(key, tile);
		}
		return tile;
	};
	return {
		...real,
		peekCapsuleGround: (
			a: Parameters<typeof real.peekCapsuleGround>[0],
			b: Parameters<typeof real.peekCapsuleGround>[1],
			opts: Parameters<typeof real.peekCapsuleGround>[2],
		) => real.peekCapsuleGround(a, b, { ...opts, z: 12 }, lookup),
		visitTiles: () => {
			world.visits++;
			return Promise.resolve();
		},
		terrainTileDue: () => true,
		// The airspace side's ground memo, never reached here.
		elevationFtAt: () => Promise.resolve(300),
		peekElevationFtAt: () => undefined,
	};
});
// The store hands out the SAME arrays until a dataset changes, and the
// selector's memo keys on them: a fresh [] per call would re-key it on every
// read and hide whether anything else does.
const none = vi.hoisted(() => ({ airports: [] as unknown[], obstacles: [] as unknown[] }));
vi.mock('$lib/state/data.svelte', () => ({
	dataState: { airspacesLoaded: false, airportsLoaded: true, obstaclesLoaded: true },
	getAirspaces: () => [],
	getSupaips: () => [],
	getAirports: () => none.airports,
	getNavaids: () => [],
	getObstacles: () => none.obstacles,
	airportByIdent: () => null,
	navaidById: () => null,
	ensureAirports: () => Promise.resolve([]),
	ensureAirspaces: () => Promise.resolve(null),
	ensureNavaids: () => Promise.resolve([]),
	ensureObstacles: () => Promise.resolve([]),
	ensureSupaip: () => Promise.resolve([]),
}));
vi.mock('$lib/state/routeTerrain.svelte', () => ({ routeTerrainSamples: () => null }));

const LAT = 46;
const LON0 = 6;
/** 120 kt east at 46 N, degrees of longitude a second. */
const DLON = (120 * 1852) / 3600 / (111_320 * Math.cos((LAT * Math.PI) / 180));

/** `n` seconds of level flight east, on a fresh array each call. */
function trace(t0: number, n = 20): TrackPoint[] {
	const pts: TrackPoint[] = [];
	for (let i = 0; i < n; i++) {
		pts.push({ lat: LAT, lon: LON0 + i * DLON, altFt: 3500, timeMs: t0 + i * 1000, speedKt: 120, trackDeg: 90 });
	}
	return pts;
}

/** Load a trace in replay, the playhead on its last fix, the wall `aheadS`
 *  seconds ahead of it. */
async function replay(t0: number, aheadS: number): Promise<void> {
	const { importTrace, setPlayhead } = await import('$lib/state/navRecording.svelte');
	importTrace(trace(t0), 'msl');
	setPlayhead(t0 + 19_000);
	world.wallLon = LON0 + (19 + aheadS) * DLON;
}

const T0 = Date.parse('2026-07-08T13:40:00Z');

describe('the terrain-alert session', () => {
	beforeEach(() => {
		vi.resetModules();
		world.ready = true;
		world.bowl = null;
		world.visits = 0;
	});

	it('grades the wall ahead as a caution, and a replay queues no chime', async () => {
		await replay(T0, 45);
		const { terrainAlerts, drainTerrainFires } = await import('$lib/state/terrainAlert.svelte');
		const r = terrainAlerts();
		expect(r?.alerts.map((a) => `${a.kind}:${a.level}`)).toEqual(['terrain:caution']);
		expect(r?.fired).toEqual([{ kind: 'terrain', level: 'caution' }]);
		expect(drainTerrainFires()).toEqual([]);
	});

	it('scopes the inhibit to the trace it was set on', async () => {
		await replay(T0, 45);
		const { terrainAlerts, terrainInhibited, setTerrainInhibit } = await import(
			'$lib/state/terrainAlert.svelte'
		);
		setTerrainInhibit(true);
		expect(terrainInhibited()).toBe(true);
		expect(terrainAlerts()?.idle).toBe('inhibited');
		expect(terrainAlerts()?.alerts).toEqual([]);
		// Another flight: the inhibit does not follow it.
		await replay(T0 + 3600_000, 45);
		expect(terrainInhibited()).toBe(false);
		expect(terrainAlerts()?.alerts).toHaveLength(1);
	});

	it('lifts the inhibit at the next flight after a landing on a field, never before', async () => {
		// Fly, land on a 1 000 ft field and stop two minutes, fly again.
		const pts: TrackPoint[] = [];
		const phases: [number, number, number][] = [
			[20, 10, 1000],
			[200, 120, 3500],
			[140, 5, 1000],
			[60, 120, 2000],
		];
		let t = 0;
		let lon = LON0;
		for (const [dur, kt, alt] of phases) {
			for (let i = 0; i < dur; i++) {
				pts.push({ lat: LAT, lon, altFt: alt, timeMs: T0 + t * 1000, speedKt: kt, trackDeg: 90 });
				lon += (kt * 1852) / 3600 / (111_320 * Math.cos((LAT * Math.PI) / 180));
				t++;
			}
		}
		const field = pts[300];
		none.airports.push({ ident: 'LSXX', lat: field.lat, lon: field.lon, elevFt: 1000 });
		try {
			const { importTrace, setPlayhead } = await import('$lib/state/navRecording.svelte');
			const { terrainInhibited, setTerrainInhibit } = await import('$lib/state/terrainAlert.svelte');
			importTrace(pts, 'msl');
			setPlayhead(T0 + 100_000);
			setTerrainInhibit(true);
			expect(terrainInhibited()).toBe(true);
			// Landed and stopped: the inhibit holds until the next takeoff.
			setPlayhead(T0 + 340_000);
			expect(terrainInhibited()).toBe(true);
			setPlayhead(T0 + 380_000);
			expect(terrainInhibited()).toBe(false);
			// The first flight, scrubbed back to, is still the one it was set on.
			setPlayhead(T0 + 100_000);
			expect(terrainInhibited()).toBe(true);
			// A helicopter's landing never closes the gate: the inhibit stands.
			const { setIconKind } = await import('$lib/state/navRecording.svelte');
			setIconKind('helicopter');
			setPlayhead(T0 + 380_000);
			expect(terrainInhibited()).toBe(true);
			setIconKind('plane');
		} finally {
			none.airports.length = 0;
		}
	});

	it('resets the acknowledgements with the trace', async () => {
		await replay(T0, 45);
		const { terrainAlerts, acknowledgeTerrainAlert } = await import('$lib/state/terrainAlert.svelte');
		expect(terrainAlerts()?.alerts[0].acked).toBe(false);
		acknowledgeTerrainAlert('terrain');
		expect(terrainAlerts()?.alerts[0].acked).toBe(true);
		// The same flight two hours later, as its own trace: a FORWARD jump.
		await replay(T0 + 2 * 3600_000, 45);
		expect(terrainAlerts()?.alerts[0].acked).toBe(false);
	});

	it('routes an acknowledgement from the merged stack to the terrain ledger', async () => {
		await replay(T0, 45);
		const { alertSurfaceNow, acknowledgeSurfaceAlert } = await import('$lib/state/alertStack');
		const m = alertSurfaceNow();
		expect(m.banner?.key).toBe('terrain:terrain');
		expect(m.chip).toEqual({ kind: 'alerts', ink: 'caution', solid: false });
		acknowledgeSurfaceAlert(m.banner!);
		const after = alertSurfaceNow();
		expect(after.banner).toBeNull();
		expect(after.panel.acked.map((a) => a.key)).toEqual(['terrain:terrain']);
		expect(after.chip?.kind).toBe('acked');
	});

	it('takes the next ridge for a new threat once the row has gone', async () => {
		// One acknowledgement used to quiet every ridge after it: the ledger
		// was keyed by kind and each new row refreshed it.
		await replay(T0, 45);
		const { setPlayhead } = await import('$lib/state/navRecording.svelte');
		const { terrainAlerts, acknowledgeTerrainAlert } = await import('$lib/state/terrainAlert.svelte');
		setPlayhead(T0 + 4000);
		world.wallLon = LON0 + (4 + 45) * DLON;
		expect(terrainAlerts()?.alerts[0]).toMatchObject({ kind: 'terrain', acked: false });
		acknowledgeTerrainAlert('terrain');
		expect(terrainAlerts()?.alerts[0].acked).toBe(true);
		// Clear ground for longer than the demotion hold: the row goes.
		world.wallLon = LON0 + 10_000 * DLON;
		for (let t = 5; t <= 16; t++) {
			setPlayhead(T0 + t * 1000);
			terrainAlerts();
		}
		expect(terrainAlerts()?.alerts).toEqual([]);
		// The next ridge is a new threat: shown, and sounding.
		setPlayhead(T0 + 19_000);
		world.wallLon = LON0 + (19 + 45) * DLON;
		const next = terrainAlerts();
		expect(next?.alerts[0]).toMatchObject({ kind: 'terrain', acked: false });
		expect(next?.fired).toEqual([{ kind: 'terrain', level: 'caution' }]);
	});

	it('keeps the acknowledgement on the same ridge as the aircraft closes on it', async () => {
		// The ridge is named by where its crest stands, re-read from every fix.
		await replay(T0, 45);
		const { setPlayhead } = await import('$lib/state/navRecording.svelte');
		const { terrainAlerts, acknowledgeTerrainAlert } = await import('$lib/state/terrainAlert.svelte');
		setPlayhead(T0 + 4000);
		world.wallLon = LON0 + (4 + 50) * DLON;
		expect(terrainAlerts()?.alerts[0]).toMatchObject({ level: 'caution', acked: false });
		acknowledgeTerrainAlert('terrain');
		for (let t = 5; t <= 19; t++) {
			setPlayhead(T0 + t * 1000);
			const r = terrainAlerts();
			expect(r?.alerts[0]).toMatchObject({ level: 'caution', acked: true });
			expect(r?.fired).toEqual([]);
		}
	});

	it('takes a ridge standing apart from the acknowledged one for a new threat, inside the hold', async () => {
		// A constant ground identity carried the acknowledgement and the sound
		// memory over to the next ridge while the demotion hold kept the row.
		await replay(T0, 45);
		const { setPlayhead } = await import('$lib/state/navRecording.svelte');
		const { terrainAlerts, acknowledgeTerrainAlert } = await import('$lib/state/terrainAlert.svelte');
		const { ALONG_BIN_M } = await import('$lib/nav/terrainAlert');
		setPlayhead(T0 + 10_000);
		world.wallLon = LON0 + (10 + 20) * DLON;
		const first = terrainAlerts();
		expect(first?.alerts[0]).toMatchObject({ level: 'warning', acked: false });
		expect(first?.fired).toEqual([{ kind: 'terrain', level: 'warning' }]);
		acknowledgeTerrainAlert('terrain');
		// Clear ground for 5 s: the hold keeps the row.
		world.wallLon = LON0 + 10_000 * DLON;
		for (let t = 11; t <= 15; t++) {
			setPlayhead(T0 + t * 1000);
			expect(terrainAlerts()?.alerts[0]).toMatchObject({ held: true });
		}
		// A ridge 11 s of flight (680 m) beyond the first one's start, so
		// 280 m of clear ground beyond it, more than a bin.
		const apartM = (11 * 120 * 1852) / 3600 - WALL_M;
		expect(apartM).toBeGreaterThan(ALONG_BIN_M);
		setPlayhead(T0 + 16_000);
		world.wallLon = LON0 + (16 + 25) * DLON;
		const next = terrainAlerts();
		expect(next?.alerts[0]).toMatchObject({ level: 'warning', held: false, acked: false });
		expect(next?.fired).toEqual([{ kind: 'terrain', level: 'warning' }]);
	});

	it('takes a ridge overlapping the one acknowledged for the same ridge', async () => {
		// Ground read again where it was, give or take the bins moving with
		// the aircraft: the acknowledgement stays with it.
		await replay(T0, 45);
		const { setPlayhead } = await import('$lib/state/navRecording.svelte');
		const { terrainAlerts, acknowledgeTerrainAlert } = await import('$lib/state/terrainAlert.svelte');
		setPlayhead(T0 + 10_000);
		world.wallLon = LON0 + (10 + 20) * DLON;
		expect(terrainAlerts()?.fired).toEqual([{ kind: 'terrain', level: 'warning' }]);
		acknowledgeTerrainAlert('terrain');
		setPlayhead(T0 + 11_000);
		world.wallLon = LON0 + (10 + 25) * DLON; // 310 m beyond
		const r = terrainAlerts();
		expect(r?.alerts[0]).toMatchObject({ level: 'warning', acked: true });
		expect(r?.fired).toEqual([]);
	});

	it('keeps one threat through a steep turn under a rim, and the acknowledgement with it', async () => {
		// Circling a bowl whose rim stands above the aircraft, at a 45 degree
		// bank: the rim's stretch swung past the corridor's half-width every
		// second, and each new name chimed again and shed the acknowledgement.
		const { destinationPoint } = await import('$lib/notam/geometry');
		const centre = { lat: 45.9, lon: 6.8 };
		world.bowl = centre;
		const kt = 90;
		const radiusM = 220;
		const turn = (kt * 1852) / 3600 / radiusM; // radians a second
		const pts: TrackPoint[] = [];
		for (let k = 0; k < 90; k++) {
			const bearing = (turn * k * 180) / Math.PI;
			const p = destinationPoint(centre.lat, centre.lon, bearing, radiusM);
			pts.push({ lat: p.lat, lon: p.lon, altFt: 3281, timeMs: T0 + k * 1000, speedKt: kt, trackDeg: (bearing + 90) % 360 });
		}
		const { importTrace, setPlayhead } = await import('$lib/state/navRecording.svelte');
		importTrace(pts, 'msl');
		const { terrainAlerts, acknowledgeTerrainAlert } = await import('$lib/state/terrainAlert.svelte');
		const threats = new Set<string>();
		let fired = 0;
		let shown = 0;
		let acked = 0;
		for (let k = 30; k < 90; k++) {
			setPlayhead(T0 + k * 1000);
			const r = terrainAlerts();
			fired += r?.fired.length ?? 0;
			const a = r?.alerts.find((x) => x.kind === 'terrain' && !x.held);
			if (a) {
				shown++;
				threats.add(a.threat);
				acked += a.acked ? 1 : 0;
				if (k === 31) {
					acknowledgeTerrainAlert('terrain');
				}
			}
		}
		expect({ shown, threats: threats.size, fired, acked }).toEqual({ shown: 60, threats: 1, fired: 1, acked: 58 });
	});

	it('takes the ridge after an evaluation gap for a new threat', async () => {
		// A lost fix or a forward scrub ends the hold; the ground's identity
		// used to survive it, and the next ridge came up acknowledged.
		const { importTrace, setPlayhead } = await import('$lib/state/navRecording.svelte');
		importTrace(trace(T0, 120), 'msl');
		const { terrainAlerts, acknowledgeTerrainAlert } = await import('$lib/state/terrainAlert.svelte');
		setPlayhead(T0 + 10_000);
		world.wallLon = LON0 + (10 + 45) * DLON;
		expect(terrainAlerts()?.alerts[0]).toMatchObject({ level: 'caution', acked: false });
		acknowledgeTerrainAlert('terrain');
		setPlayhead(T0 + 70_000);
		world.wallLon = LON0 + (70 + 45) * DLON;
		const r = terrainAlerts();
		expect(r?.alerts[0]).toMatchObject({ level: 'caution', held: false, acked: false });
		expect(r?.fired).toEqual([{ kind: 'terrain', level: 'caution' }]);
	});

	it('clears the acknowledgements on a rewind', async () => {
		await replay(T0, 45);
		const { setPlayhead } = await import('$lib/state/navRecording.svelte');
		const { terrainAlerts, acknowledgeTerrainAlert } = await import('$lib/state/terrainAlert.svelte');
		terrainAlerts();
		acknowledgeTerrainAlert('terrain');
		expect(terrainAlerts()?.alerts[0].acked).toBe(true);
		// Scrubbed back: the replay shows what the flight showed then.
		setPlayhead(T0 + 4000);
		world.wallLon = LON0 + (4 + 45) * DLON;
		expect(terrainAlerts()?.alerts[0].acked).toBe(false);
	});

	it('reads no corridor while the ground row is off or inhibited', async () => {
		world.ready = false;
		await replay(T0, 45);
		const { terrainAlerts, setTerrainTier, setTerrainInhibit } = await import('$lib/state/terrainAlert.svelte');
		setTerrainTier('terrain', false);
		terrainAlerts();
		expect(world.visits).toBe(0);
		setTerrainTier('terrain', true);
		setTerrainInhibit(true);
		terrainAlerts();
		expect(world.visits).toBe(0);
		setTerrainInhibit(false);
		terrainAlerts();
		expect(world.visits).toBe(1);
	});

	it('keeps an acknowledgement for five minutes after its row left', async () => {
		// The aircraft holds one place (every fix at it, 120 kt through the
		// air), so the ridge ahead lies where it lay each time it shows.
		const pts: TrackPoint[] = [];
		for (let i = 0; i < 300; i++) {
			pts.push({ lat: LAT, lon: LON0, altFt: 3500, timeMs: T0 + i * 1000, speedKt: 120, trackDeg: 90 });
		}
		const { importTrace, setPlayhead } = await import('$lib/state/navRecording.svelte');
		importTrace(pts, 'msl');
		const { terrainAlerts, acknowledgeTerrainAlert } = await import('$lib/state/terrainAlert.svelte');
		const ridge = LON0 + 45 * DLON;
		setPlayhead(T0 + 10_000);
		world.wallLon = ridge;
		expect(terrainAlerts()?.alerts[0]).toMatchObject({ level: 'caution', acked: false });
		acknowledgeTerrainAlert('terrain');
		// Gone for four minutes.
		world.wallLon = LON0 + 10_000 * DLON;
		for (let t = 11; t <= 250; t += 10) {
			setPlayhead(T0 + t * 1000);
			terrainAlerts();
		}
		expect(terrainAlerts()?.alerts).toEqual([]);
		setPlayhead(T0 + 251_000);
		world.wallLon = ridge;
		const back = terrainAlerts();
		expect(back?.alerts[0]).toMatchObject({ level: 'caution', acked: true });
		expect(back?.fired).toEqual([]);
	});

	it('shapes the phase by a field up to 15 NM away', async () => {
		// 14 NM ahead, 3 000 ft under the aircraft (3 200 ft above the field
		// at 300 ft): terminal, under the 3 500 ft line at 15 NM. The field
		// search reaching only 5 NM left it en route.
		const nmDeg = 1852 / (111_320 * Math.cos((LAT * Math.PI) / 180));
		none.airports = [
			{
				ident: 'LFXX',
				name: 'LFXX',
				type: 'small_airport',
				lat: LAT,
				lon: LON0 + 19 * DLON + 14 * nmDeg,
				elevFt: 300,
				runways: [],
			},
		];
		try {
			await replay(T0, 45);
			const { terrainAlerts } = await import('$lib/state/terrainAlert.svelte');
			expect(terrainAlerts()?.phase).toBe('terminal');
		} finally {
			none.airports = [];
		}
	});

	it('takes the nearest field with a stated elevation for the phase', async () => {
		// A strip with no elevation 1 NM ahead used to hide the aerodrome 2 NM
		// ahead, 500 ft under the aircraft: en route, not an approach.
		const field = (ident: string, nm: number, elevFt: number | null): unknown => ({
			ident,
			name: ident,
			type: 'small_airport',
			lat: LAT,
			lon: LON0 + 19 * DLON + (nm * 1852) / (111_320 * Math.cos((LAT * Math.PI) / 180)),
			elevFt,
			runways: [],
		});
		none.airports = [field('LF01', 1, null), field('LFXX', 2, 3000)];
		try {
			await replay(T0, 45);
			const { terrainAlerts } = await import('$lib/state/terrainAlert.svelte');
			expect(terrainAlerts()?.phase).toBe('approach');
		} finally {
			none.airports = [];
		}
	});

	it('re-evaluates when the missing corridor tiles land', async () => {
		world.ready = false;
		await replay(T0, 45);
		const { terrainAlerts, terrainInputGaps } = await import('$lib/state/terrainAlert.svelte');
		const before = terrainAlerts();
		expect(before?.alerts).toEqual([]);
		expect(before?.unread).toBe(true);
		expect(terrainInputGaps()).toEqual({ unread: true, obstacles: false, obstaclesPartial: false });
		expect(world.visits).toBe(1);
		// The batch settles: the tiles are in hand and the memo must not keep
		// answering from before, although no pose, clock or preference moved.
		world.ready = true;
		await new Promise((r) => setTimeout(r, 0));
		const after = terrainAlerts();
		expect(after).not.toBe(before);
		expect(after?.alerts.map((a) => a.kind)).toEqual(['terrain']);
		expect(terrainInputGaps()).toBeNull();
	});
});
