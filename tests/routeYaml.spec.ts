/* Unit tests for the saved-routes YAML format: the pure build / stringify / parse
 * round-trip (loaded fields survive, saved-only fields are ignored on load) and
 * loadRoutes (ident resolution, free points, dropped idents, the route cap). */

import { describe, it, expect } from 'vitest';
import {
	buildRoutesDoc,
	stringifyRoutesDoc,
	parseRoutesDoc,
	withPlanName,
	type SaveWaypoint,
	type LegNavlog,
	type WaypointInfo,
	type LoadedRoute,
} from '$lib/route/yaml';
import {
	loadRoutes,
	routes,
	routeSettings,
	MAX_ROUTES,
	type WaypointAnchor,
} from '$lib/state/route.svelte';
import { windAloft } from '$lib/state/windAloft.svelte';

describe('build + stringify + parse round-trip', () => {
	const waypoints: SaveWaypoint[] = [
		{ kind: 'airport', ident: 'LFPL', lat: 48.6747, lon: 2.1071, alt: 1500, altAuto: true, notes: 'depart' },
		{ kind: 'free', lat: 48.5901, lon: 2.4567, label: "L'obélisque", alt: 2500, altAuto: false },
		{ kind: 'navaid', ident: 'MLN', lat: 48.6, lon: 2.6, alt: 2500, altAuto: true },
		{ kind: 'airport', ident: 'LFPK', lat: 48.84, lon: 2.68, alt: 1200, altAuto: true },
	];
	const legs: LegNavlog[] = [
		{ course: 98, heading: 102, distance: 10, distanceRemaining: 32, safetyAltitude: 1000, ete: 6 },
		{ course: 62, distance: 6, distanceRemaining: 22 },
		{ course: 264, distance: 16, distanceRemaining: 16 },
	];
	const info: WaypointInfo[] = [
		{ frequencies: 'TWR / A/A : 118.605\nGND : 122.130', airspace: 'Classe A 1500' },
		{ airspace: 'Classe A 2500' },
		{},
		{},
	];
	const text = stringifyRoutesDoc(buildRoutesDoc([{ name: 'Test', waypoints, legs, info }]));

	it('keeps the loaded-vs-saved header comment', () => {
		expect(text.startsWith('#')).toBe(true);
		expect(text).toMatch(/ignored on load/);
	});

	it('round-trips every loaded field', () => {
		const { routes: rs } = parseRoutesDoc(text);
		expect(rs).toHaveLength(1);
		expect(rs[0].name).toBe('Test');
		const w = rs[0].waypoints;
		expect(w).toHaveLength(4);
		// airport: ident only, no coords; leg.altitude/auto loaded.
		expect(w[0]).toMatchObject({ ident: 'LFPL', altitude: 1500, auto: true, notes: 'depart' });
		expect(w[0].lat).toBeUndefined();
		// free: coords + name, no ident.
		expect(w[1]).toMatchObject({ lat: 48.5901, lon: 2.4567, name: "L'obélisque", altitude: 2500, auto: false });
		expect(w[1].ident).toBeUndefined();
		// navaid: ident.
		expect(w[2].ident).toBe('MLN');
		// destination: no leg -> no altitude/auto.
		expect(w[3]).toMatchObject({ ident: 'LFPK' });
		expect(w[3].altitude).toBeUndefined();
		expect(w[3].auto).toBeUndefined();
	});

	it('keeps course/distance on parse (for reconstruction) and drops the rest', () => {
		// Present in the document text...
		expect(text).toMatch(/course: 98/);
		expect(text).toMatch(/distance_remaining: 32/);
		expect(text).toMatch(/safety_altitude: 1000/);
		expect(text).toMatch(/Classe A 1500/);
		expect(text).toMatch(/118\.605/);
		const w = parseRoutesDoc(text).routes[0].waypoints[0] as Record<string, unknown>;
		// course / distance are read - they position name-only waypoints...
		expect(w.course).toBe(98);
		expect(w.distance).toBe(10);
		// ...the rest of the nav-log snapshot stays ignored.
		expect(w.frequencies).toBeUndefined();
		expect(w.airspace).toBeUndefined();
		expect(w.distance_remaining).toBeUndefined();
		expect(w.heading).toBeUndefined();
		expect(w.safety_altitude).toBeUndefined();
	});

	it('serialises a combined airport + enroute frequency block, dropped on load', () => {
		// The export joins the airport lines and the per-leg enroute lines into the
		// one `frequencies` field (airport, newline, enroute).
		const wps: SaveWaypoint[] = [
			{ kind: 'airport', ident: 'LFPL', lat: 48.6747, lon: 2.1071, alt: 1500, altAuto: true },
			{ kind: 'airport', ident: 'LFPK', lat: 48.84, lon: 2.68, alt: 1200, altAuto: true },
		];
		const combined: WaypointInfo[] = [
			{ frequencies: 'TWR / A/A : 118.605\nTMA SEINE 5: 120.500\nSIV PARIS SUD: 135.225' },
			{},
		];
		const doc = stringifyRoutesDoc(buildRoutesDoc([{ name: 'F', waypoints: wps, info: combined }]));
		expect(doc).toMatch(/118\.605/); // airport line
		expect(doc).toMatch(/TMA SEINE 5: 120\.500/); // enroute line
		expect(doc).toMatch(/SIV PARIS SUD: 135\.225/);
		const w = parseRoutesDoc(doc).routes[0].waypoints[0] as Record<string, unknown>;
		expect(w.frequencies).toBeUndefined(); // saved-only, ignored on load
	});
});

describe('parseRoutesDoc validation', () => {
	it('rejects a missing or unknown version', () => {
		expect(() => parseRoutesDoc('routes: []')).toThrow(/version/);
		expect(() => parseRoutesDoc('version: 2\nroutes: []')).toThrow(/version/);
	});
	it('rejects a non-mapping document and a non-list routes', () => {
		expect(() => parseRoutesDoc('- a\n- b')).toThrow(/mapping/);
		expect(() => parseRoutesDoc('version: 1\nroutes: {}')).toThrow(/list/);
	});
	it('accepts a name-only waypoint (positioned later by dead reckoning)', () => {
		const { routes: rs } = parseRoutesDoc('version: 1\nroutes:\n- waypoints:\n  - name: x');
		expect(rs[0].waypoints[0]).toMatchObject({ name: 'x' });
		expect(rs[0].waypoints[0].ident).toBeUndefined();
		expect(rs[0].waypoints[0].lat).toBeUndefined();
	});
	it('rejects a waypoint with no name, ident, or coordinates', () => {
		expect(() => parseRoutesDoc('version: 1\nroutes:\n- waypoints:\n  - notes: y')).toThrow(
			/ident, lat\/lon, or a name/,
		);
	});
	it('accepts an empty routes list', () => {
		expect(parseRoutesDoc('version: 1\nroutes: []')).toEqual({ routes: [] });
	});
});

describe('per-leg wind override', () => {
	it('round-trips leg.wind_dir / wind_speed; the wind snapshot stays saved-only', () => {
		const doc = buildRoutesDoc([
			{
				name: 'W',
				waypoints: [
					{ kind: 'free', lat: 48, lon: 2, alt: 3000, altAuto: true, windDirDeg: 240, windSpeedKt: 15 },
					{ kind: 'free', lat: 49, lon: 2, alt: 3000, altAuto: true },
				],
				legs: [{ course: 358, wind: '240°/15 kt' }],
			},
		]);
		const text = stringifyRoutesDoc(doc);
		expect(text).toContain('wind_dir: 240');
		expect(text).toContain('wind_speed: 15');
		expect(text).toMatch(/wind: "?240°\/15 kt"?/);
		const wp = parseRoutesDoc(text).routes[0].waypoints[0];
		expect(wp.windDirDeg).toBe(240);
		expect(wp.windSpeedKt).toBe(15);
	});

	it('ignores a lone override half and never reads the snapshot string back', () => {
		const p = parseRoutesDoc(
			'version: 1\nroutes:\n- waypoints:\n  - lat: 48\n    lon: 2\n    leg: {altitude: 3000, auto: true, wind_dir: 240, wind: 240/15}\n  - lat: 49\n    lon: 2\n',
		);
		expect(p.routes[0].waypoints[0].windDirDeg).toBeUndefined();
		expect(p.routes[0].waypoints[0].windSpeedKt).toBeUndefined();
	});

	it('seeds waypoint overrides on load', () => {
		loadRoutes(
			{
				routes: [
					{
						name: null,
						waypoints: [
							{ lat: 48, lon: 2, altitude: 3000, auto: true, windDirDeg: 200, windSpeedKt: 10 },
							{ lat: 49, lon: 2 },
						],
					},
				],
			},
			() => null,
		);
		expect(routes.list[0].waypoints[0].windDirDeg).toBe(200);
		expect(routes.list[0].waypoints[0].windSpeedKt).toBe(10);
		expect(routes.list[0].waypoints[1].windDirDeg).toBeUndefined();
	});
});

describe('manual frequencies override', () => {
	it('round-trips frequencies_manual; the effective snapshot stays saved-only', () => {
		const doc = buildRoutesDoc([
			{
				name: 'F',
				waypoints: [
					{
						kind: 'airport',
						ident: 'LFPL',
						lat: 48.6747,
						lon: 2.1071,
						alt: 1500,
						altAuto: true,
						freqsManual: 'TWR: 118.605\nGLIDER: 123.500',
					},
					{ kind: 'airport', ident: 'LFPK', lat: 48.84, lon: 2.68, alt: 1200, altAuto: true },
				],
				// The Save side writes the same effective text as the snapshot.
				info: [{ frequencies: 'TWR: 118.605\nGLIDER: 123.500' }, {}],
			},
		]);
		const text = stringifyRoutesDoc(doc);
		expect(text).toContain('frequencies_manual: |-'); // block scalar, lines verbatim
		expect(text).toMatch(/GLIDER: 123\.500/);
		const w = parseRoutesDoc(text).routes[0].waypoints;
		expect(w[0].freqsManual).toBe('TWR: 118.605\nGLIDER: 123.500');
		expect(w[1].freqsManual).toBeUndefined(); // automatic cell: absent key
		// The snapshot itself stays ignored on load.
		expect((w[0] as Record<string, unknown>).frequencies).toBeUndefined();
	});

	it('degrades a malformed frequencies_manual to automatic', () => {
		// A hand-written unquoted value parses as a YAML number, not a string.
		const p = parseRoutesDoc(
			'version: 1\nroutes:\n- waypoints:\n  - lat: 48\n    lon: 2\n    frequencies_manual: 121.5\n',
		);
		expect(p.routes[0].waypoints[0].freqsManual).toBeUndefined();
	});

	it('seeds overrides on load for anchored, name-only, and free waypoints', () => {
		const resolve = (tok: string): WaypointAnchor | null =>
			tok === 'LFPL' ? { lat: 48.8, lon: 2.6, kind: 'airport', refId: 'LFPL', ident: 'LFPL' } : null;
		loadRoutes(
			{
				routes: [
					{
						name: null,
						waypoints: [
							{ ident: 'LFPL', freqsManual: 'TWR: 118.605', course: 90, distance: 10 },
							{ name: 'DR point', freqsManual: 'SIV PARIS: 135.225' },
							{ lat: 49, lon: 2, freqsManual: 'FIS: 120.325' },
						],
					},
				],
			},
			resolve,
		);
		const w = routes.list[0].waypoints;
		expect(w[0].freqsManual).toBe('TWR: 118.605'); // anchored
		expect(w[1].freqsManual).toBe('SIV PARIS: 135.225'); // name-only, dead-reckoned
		expect(w[1].estimated).toBe(true);
		expect(w[2].freqsManual).toBe('FIS: 120.325'); // free
	});
});

describe('settings block', () => {
	it('round-trips the planning options', () => {
		const text = stringifyRoutesDoc(
			buildRoutesDoc([{ name: 'T', waypoints: [] }], undefined, {
				vfr: false,
				semicircular: true,
				transitionAltitudeFt: 4000,
				windForecast: false,
				temperatureTas: true,
			}),
		);
		expect(text).toContain('semi_circular: true');
		expect(text).toContain('transition_altitude: 4000');
		expect(text).toContain('wind_forecast: false');
		expect(text).toContain('temperature_tas: true');
		const s = parseRoutesDoc(text).settings!;
		expect(s.vfr).toBe(false);
		expect(s.semicircular).toBe(true);
		expect(s.transitionAltitudeFt).toBe(4000);
		expect(s.windForecast).toBe(false);
		expect(s.temperatureTas).toBe(true);
	});
	it('is absent when the writer gets no settings, undefined on old files', () => {
		const text = stringifyRoutesDoc(buildRoutesDoc([{ name: 'T', waypoints: [] }]));
		expect(text).not.toContain('settings:');
		expect(parseRoutesDoc('version: 1\nroutes: []').settings).toBeUndefined();
	});
	it('omits transition_altitude when the TA is automatic (null)', () => {
		const text = stringifyRoutesDoc(
			buildRoutesDoc([{ name: 'T', waypoints: [] }], undefined, {
				vfr: true,
				semicircular: true,
				transitionAltitudeFt: null,
				windForecast: true,
				temperatureTas: false,
			}),
		);
		expect(text).toContain('settings:');
		expect(text).not.toContain('transition_altitude');
		expect(parseRoutesDoc(text).settings!.transitionAltitudeFt).toBeUndefined();
	});
	it('tolerates a malformed block or values (only stated keys survive)', () => {
		expect(parseRoutesDoc('version: 1\nsettings: 5\nroutes: []').settings).toBeUndefined();
		const s = parseRoutesDoc(
			'version: 1\nsettings:\n  semi_circular: yes\n  transition_altitude: high\n  vfr: true\nroutes: []',
		).settings!;
		// YAML 1.2 core schema: a plain "yes" is a string, not a boolean.
		expect(s.semicircular).toBeUndefined();
		expect(s.transitionAltitudeFt).toBeUndefined();
		expect(s.vfr).toBe(true);
	});
	it('applies wind_forecast / temperature_tas to the session on load', () => {
		windAloft.useForecastForLegs = true;
		windAloft.tempTas = false;
		loadRoutes({ routes: [], settings: { windForecast: false, temperatureTas: true } }, () => null);
		expect(windAloft.useForecastForLegs).toBe(false);
		expect(windAloft.tempTas).toBe(true);
		loadRoutes({ routes: [], settings: {} }, () => null);
		expect(windAloft.useForecastForLegs).toBe(false); // untouched by absent keys
		windAloft.useForecastForLegs = true;
		windAloft.tempTas = false;
	});

	it('applies the stated keys to routeSettings on load; absent TA clears to auto', () => {
		routeSettings.vfr = true;
		routeSettings.semicircular = false;
		routeSettings.transitionAltitudeFt = 5000;
		loadRoutes(
			{ routes: [], settings: { semicircular: true, transitionAltitudeFt: undefined, vfr: undefined } },
			() => null,
		);
		expect(routeSettings.semicircular).toBe(true);
		expect(routeSettings.vfr).toBe(true); // untouched
		// The one deviation from "absent keys leave session values untouched":
		// a settings block WITHOUT transition_altitude states "automatic", so
		// it clears a session override (files only carry the key when the TA
		// was manually overridden).
		expect(routeSettings.transitionAltitudeFt).toBeNull();
		// A present key restores an override.
		loadRoutes({ routes: [], settings: { transitionAltitudeFt: 6500 } }, () => null);
		expect(routeSettings.transitionAltitudeFt).toBe(6500);
		routeSettings.transitionAltitudeFt = null;
		routeSettings.semicircular = false;
	});
});

describe('the plan name', () => {
	/* The plan's own descriptive name: a caption stored in the file, written
	 * after `version` and omitted entirely when there is none, so an unnamed
	 * plan's bytes never move (docs/flights-library.md). */
	const plain = stringifyRoutesDoc(
		buildRoutesDoc([{ name: 'T', waypoints: [{ kind: 'airport', ident: 'LFPL', lat: 48.6, lon: 2.1, alt: 1500, altAuto: true }] }]),
	);

	it('emits nothing at all when the plan is unnamed, blank or whitespace', () => {
		const wps: SaveWaypoint[] = [
			{ kind: 'airport', ident: 'LFPL', lat: 48.6, lon: 2.1, alt: 1500, altAuto: true },
		];
		for (const name of [undefined, null, '', '   ']) {
			expect(stringifyRoutesDoc(buildRoutesDoc([{ name: 'T', waypoints: wps }], undefined, undefined, name))).toBe(
				plain,
			);
		}
		expect(parseRoutesDoc(plain).planName).toBeUndefined();
	});

	it('writes the name between version and settings, and reads it back', () => {
		const text = stringifyRoutesDoc(
			buildRoutesDoc([{ name: 'T', waypoints: [] }], undefined, {
				vfr: true,
				semicircular: false,
				transitionAltitudeFt: null,
				windForecast: true,
				temperatureTas: false,
			}, 'Nav examen'),
		);
		expect(text.indexOf('version:')).toBeLessThan(text.indexOf('name: Nav examen'));
		expect(text.indexOf('name: Nav examen')).toBeLessThan(text.indexOf('settings:'));
		expect(parseRoutesDoc(text).planName).toBe('Nav examen');
	});

	it('normalises the same way on write and on read', () => {
		// One line, trimmed, capped: the value has to survive a table row and a
		// file name, and both sides must agree or a rename then a Store would
		// flip-flop the bytes.
		const text = stringifyRoutesDoc(
			buildRoutesDoc([{ name: 'T', waypoints: [] }], undefined, undefined, '  Nav   examen \n retour  '),
		);
		expect(parseRoutesDoc(text).planName).toBe('Nav examen retour');
		const long = 'x'.repeat(200);
		expect(parseRoutesDoc(`version: 1\nname: ${long}\nroutes: []`).planName).toHaveLength(80);
	});

	it('round-trips a name YAML would otherwise read as something else', () => {
		for (const name of ['123', 'yes', '# 1', 'A: B']) {
			const text = stringifyRoutesDoc(buildRoutesDoc([{ name: 'T', waypoints: [] }], undefined, undefined, name));
			expect(parseRoutesDoc(text).planName).toBe(name);
		}
	});
});

describe('withPlanName', () => {
	/* The catalog's rename edits the STORED text in place: everything the
	 * format declares saved-only (the whole `leg:` snapshot) belongs to a file
	 * the user may have downloaded and an external tool may read, so a
	 * parse-and-rebuild is not an option. */
	const waypoints: SaveWaypoint[] = [
		{ kind: 'airport', ident: 'LFPL', lat: 48.6747, lon: 2.1071, alt: 1500, altAuto: true },
		{ kind: 'airport', ident: 'LFPK', lat: 48.84, lon: 2.68, alt: 1200, altAuto: true },
	];
	const legs: LegNavlog[] = [
		{ course: 98, heading: 102, distance: 10, distanceRemaining: 10, safetyAltitude: 1000, ete: 6 },
	];
	const info: WaypointInfo[] = [{ frequencies: 'TWR : 118.605\nGND : 122.130' }, {}];
	const rich = stringifyRoutesDoc(
		buildRoutesDoc([{ name: 'Sortie', waypoints, legs, info }], { aircraft: 'f-gorq' }, {
			vfr: true,
			semicircular: false,
			transitionAltitudeFt: null,
			windForecast: true,
			temperatureTas: false,
		}),
	);

	it('adds, replaces and clears, leaving the file otherwise byte-identical', () => {
		const named = withPlanName(rich, 'Nav examen');
		expect(parseRoutesDoc(named).planName).toBe('Nav examen');
		expect(withPlanName(named, null)).toBe(rich);
		const renamed = withPlanName(named, 'Nav examen 2');
		expect(parseRoutesDoc(renamed).planName).toBe('Nav examen 2');
		expect(withPlanName(renamed, '')).toBe(rich);
	});

	it('keeps the header comment above version, and the saved-only snapshot intact', () => {
		const named = withPlanName(rich, 'Nav examen');
		expect(named.startsWith('#')).toBe(true);
		expect(named).toMatch(/ignored on load/);
		expect(named.indexOf('#')).toBeLessThan(named.indexOf('version:'));
		expect(named.indexOf('version:')).toBeLessThan(named.indexOf('name: Nav examen'));
		// Every saved-only field the loader ignores is still there, verbatim.
		for (const line of rich.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))) {
			expect(named).toContain(line);
		}
	});

	it('agrees byte for byte with a full rebuild carrying the same name', () => {
		// What stops a rename followed by a Store from flip-flopping the file.
		const rebuilt = stringifyRoutesDoc(
			buildRoutesDoc([{ name: 'Sortie', waypoints, legs, info }], { aircraft: 'f-gorq' }, {
				vfr: true,
				semicircular: false,
				transitionAltitudeFt: null,
				windForecast: true,
				temperatureTas: false,
			}, 'Nav examen'),
		);
		expect(withPlanName(rich, 'Nav examen')).toBe(rebuilt);
	});

	it('hands back text it cannot read, untouched', () => {
		// A row the Plans view cannot parse is a row it does not offer to rename;
		// this is the belt to that suspender.
		expect(withPlanName('nonsense: [', 'X')).toBe('nonsense: [');
		expect(withPlanName('- a\n- b\n', 'X')).toBe('- a\n- b\n');
	});
});

describe('loadRoutes', () => {
	const resolve = (tok: string): WaypointAnchor | null => {
		const db: Record<string, WaypointAnchor> = {
			LFPL: { lat: 48.6747, lon: 2.1071, kind: 'airport', refId: 'LFPL', ident: 'LFPL', label: 'Lognes' },
			MLN: { lat: 48.6, lon: 2.6, kind: 'navaid', refId: 'mln', ident: 'MLN', freq: '113.600' },
		};
		return db[tok.toUpperCase()] ?? null;
	};

	it('resolves anchored idents, keeps free points, drops the unresolvable', () => {
		const parsed: { routes: LoadedRoute[] } = {
			routes: [
				{
					name: 'R',
					waypoints: [
						{ ident: 'LFPL', altitude: 1500, auto: false, notes: 'x' },
						{ lat: 48.5901, lon: 2.4567, name: "L'obélisque", altitude: 2500, auto: true },
						{ ident: 'MLN' },
						{ ident: 'NOPE' },
					],
				},
			],
		};
		const { dropped, truncated } = loadRoutes(parsed, resolve);
		expect(dropped).toEqual(['NOPE']);
		expect(truncated).toBe(false);
		expect(routes.list).toHaveLength(1);
		const w = routes.list[0].waypoints;
		expect(w).toHaveLength(3);
		expect(w[0]).toMatchObject({ ident: 'LFPL', kind: 'airport', alt: 1500, altAuto: false, notes: 'x', label: 'Lognes' });
		expect(w[1]).toMatchObject({ kind: 'free', lat: 48.5901, lon: 2.4567, label: "L'obélisque", alt: 2500, altAuto: true });
		expect(w[2]).toMatchObject({ ident: 'MLN', kind: 'navaid', freq: '113.600' });
	});

	it('reconstructs a name-only waypoint between two anchors', () => {
		// The leg (course/distance) for LFPL -> obélisque lives on LFPL.
		const parsed: { routes: LoadedRoute[] } = {
			routes: [
				{
					name: 'R',
					waypoints: [
						{ ident: 'LFPL', course: 98, distance: 10 },
						{ name: "L'obélisque" },
						{ ident: 'MLN' },
					],
				},
			],
		};
		const { dropped, reconstructed } = loadRoutes(parsed, resolve, 2026.0);
		expect(dropped).toEqual([]);
		expect(reconstructed).toContain("L'obélisque");
		const w = routes.list[0].waypoints;
		expect(w).toHaveLength(3);
		expect(w[1]).toMatchObject({ kind: 'free', estimated: true, label: "L'obélisque" });
		expect(Number.isFinite(w[1].lat)).toBe(true);
		expect(Number.isFinite(w[1].lon)).toBe(true);
	});

	it('drops a name-only waypoint with no usable neighbour', () => {
		const parsed: { routes: LoadedRoute[] } = {
			routes: [{ name: 'R', waypoints: [{ name: 'orphan' }, { ident: 'NOPE' }] }],
		};
		const { dropped, reconstructed } = loadRoutes(parsed, resolve, 2026.0);
		expect(reconstructed).toEqual([]);
		expect(dropped).toContain('orphan');
		expect(routes.list[0].waypoints).toHaveLength(0);
	});

	it('treats a coordinate-looking free name as no label', () => {
		loadRoutes({ routes: [{ name: null, waypoints: [{ lat: 48.59, lon: 2.45, name: '48.590, 2.450' }] }] }, resolve);
		expect(routes.list[0].waypoints[0].label).toBeUndefined();
	});

	it('caps at MAX_ROUTES and reports truncation', () => {
		const many: LoadedRoute[] = Array.from({ length: MAX_ROUTES + 2 }, (_, i) => ({
			name: `r${i}`,
			waypoints: [{ ident: 'LFPL' }],
		}));
		const { truncated } = loadRoutes({ routes: many }, resolve);
		expect(truncated).toBe(true);
		expect(routes.list).toHaveLength(MAX_ROUTES);
	});

	it('carries the alternate role through to the loaded routes', () => {
		const parsed: { routes: LoadedRoute[] } = {
			routes: [
				{ name: 'trip', waypoints: [{ ident: 'LFPL' }] },
				{ name: 'alt', waypoints: [{ ident: 'MLN' }], alternate: true },
			],
		};
		loadRoutes(parsed, resolve);
		expect(routes.list[0].alternate).toBeUndefined();
		expect(routes.list[1].alternate).toBe(true);
	});
});

describe('role: alternate round-trip', () => {
	const wp: SaveWaypoint = { kind: 'airport', ident: 'LFPL', lat: 48.67, lon: 2.11, alt: 1500, altAuto: true };

	it('emits role only on alternates and reads it back', () => {
		const text = stringifyRoutesDoc(
			buildRoutesDoc([
				{ name: 'trip', waypoints: [wp] },
				{ name: 'alt', waypoints: [wp], alternate: true },
			]),
		);
		expect(text).toMatch(/role: alternate/);
		const { routes: rs } = parseRoutesDoc(text);
		expect(rs[0].alternate).toBeUndefined();
		expect(rs[1].alternate).toBe(true);
	});

	it('a file without roles loads every route as a trip', () => {
		const { routes: rs } = parseRoutesDoc('version: 1\nroutes:\n- waypoints:\n  - ident: LFPL');
		expect(rs[0].alternate).toBeUndefined();
	});
});

describe('flight_prep round-trip', () => {
	const wp: SaveWaypoint = { kind: 'airport', ident: 'LFPL', lat: 48.67, lon: 2.11, alt: 1500, altAuto: true };

	it('round-trips the inputs, omitting the block when untouched', () => {
		const fp = {
			aircraft: 'F-GORQ',
			fuelTrips: [
				{ taxiMin: 5, procedureMin: 10, alternateProcedureMin: 10, marginMin: 0, finalReserveMin: 30 },
				{ taxiMin: 0, procedureMin: 10, alternateProcedureMin: 10, marginMin: 0, finalReserveMin: 30 },
			],
			massBalance: {
				loads: { 'Front seats': 80, 'Rear seats': 10, Baggage: 0 },
				fuelMode: 'full',
			},
			aerodromes: [
				{
					icao: 'LFPL',
					qnhHpa: 1019,
					takeoff: { temperatureC: 15, headwindKt: 0, tailwindKt: 0, wet: false, runwayEnd: '26' },
					landing: { temperatureC: 11, headwindKt: 5, tailwindKt: 0, wet: true, runwayEnd: '08' },
				},
			],
		};
		const text = stringifyRoutesDoc(buildRoutesDoc([{ name: 'T', waypoints: [wp] }], fp));
		expect(text).toMatch(/^flight_prep:$/m);
		expect(text).toMatch(/aircraft: F-GORQ/);
		const parsed = parseRoutesDoc(text).flightPrep!;
		expect(parsed.aircraft).toBe('F-GORQ');
		expect(parsed.fuelTrips).toHaveLength(2);
		expect(parsed.fuelTrips![0]).toEqual({
			taxiMin: 5, procedureMin: 10, alternateProcedureMin: 10, marginMin: 0, finalReserveMin: 30,
		});
		expect(parsed.massBalance!.loads).toEqual({ 'Front seats': 80, 'Rear seats': 10, Baggage: 0 });
		expect(parsed.massBalance!.fuelMode).toBe('full');
		const ad = parsed.aerodromes![0];
		expect(ad.icao).toBe('LFPL');
		expect(ad.qnhHpa).toBe(1019);
		expect(ad.takeoff!.temperatureC).toBe(15);
		expect(ad.takeoff!.runwayEnd).toBe('26');
		expect(ad.landing!.headwindKt).toBe(5);
		expect(ad.landing!.wet).toBe(true);
		expect(ad.landing!.runwayEnd).toBe('08');
		// No flight prep -> no block in the document (the header mentions the
		// key in prose, so match the YAML key form only).
		const bare = stringifyRoutesDoc(buildRoutesDoc([{ name: 'T', waypoints: [wp] }]));
		expect(bare).not.toMatch(/^flight_prep:$/m);
	});

	it('an explicit calm (wind 0) persists; an absent wind stays unset', () => {
		const fp = {
			aerodromes: [
				{
					icao: 'LFPL',
					takeoff: { headwindKt: 0, tailwindKt: 0 },
					landing: { temperatureC: 11 },
				},
			],
		};
		const text = stringifyRoutesDoc(buildRoutesDoc([{ name: 'T', waypoints: [wp] }], fp));
		expect(text).toMatch(/headwind: 0/);
		const ad = parseRoutesDoc(text).flightPrep!.aerodromes![0];
		// A typed 0 round-trips as a deliberate calm (overrides the METAR wind).
		expect(ad.takeoff!.headwindKt).toBe(0);
		expect(ad.takeoff!.tailwindKt).toBe(0);
		// An unset wind is an absent key, so it loads as undefined (follows METAR).
		expect(ad.landing?.headwindKt).toBeUndefined();
	});

	it('auto final reserves save as absent keys; an old fuel.night key is ignored', () => {
		const fp = {
			fuelTrips: [{ taxiMin: 5, procedureMin: 10, alternateProcedureMin: 10, marginMin: 0 }],
		};
		const text = stringifyRoutesDoc(buildRoutesDoc([{ name: 'T', waypoints: [wp] }], fp));
		expect(text).not.toMatch(/final_reserve/);
		expect(text).not.toMatch(/night/);
		expect(parseRoutesDoc(text).flightPrep!.fuelTrips![0].finalReserveMin).toBeUndefined();
		// The retired manual fuel.night flag is an unknown key now, skipped
		// like any other; the trips still parse.
		const legacy =
			'version: 1\nroutes:\n- waypoints:\n  - ident: LFPL\n' +
			'flight_prep:\n  fuel:\n    night: true\n    trips:\n    - { final_reserve: 45 }\n';
		const parsed = parseRoutesDoc(legacy).flightPrep!;
		expect(parsed.fuelTrips![0].finalReserveMin).toBe(45);
		expect('fuelNight' in parsed).toBe(false);
	});

	it('an all-automatic trip states no minute at all', () => {
		// Every one of the five is an override, so a trip the pilot never touched
		// carries nothing: the reader applies fuel.ts's own defaults, which is
		// what the page showed as its placeholders.
		const text = stringifyRoutesDoc(
			buildRoutesDoc([{ name: 'T', waypoints: [wp] }], { fuelTrips: [{}] }),
		);
		for (const key of ['taxi', 'procedure', 'alternate_procedure', 'margin', 'final_reserve']) {
			expect(text).not.toMatch(new RegExp(key));
		}
		const back = parseRoutesDoc(text).flightPrep!.fuelTrips![0];
		expect(back).toEqual({
			taxiMin: undefined,
			procedureMin: undefined,
			alternateProcedureMin: undefined,
			marginMin: undefined,
			finalReserveMin: undefined,
		});
	});

	it('keeps a stated zero and reads an unstated stop as no value', () => {
		// A ground stop the pilot typed as 00:00 is a statement; a slot nobody
		// set is not, and the two must not collapse into each other.
		const fp = { dossier: { stopsMin: [null, 0, 15] } };
		const text = stringifyRoutesDoc(buildRoutesDoc([{ name: 'T', waypoints: [wp] }], fp));
		expect(parseRoutesDoc(text).flightPrep!.dossier!.stopsMin).toEqual([null, 0, 15]);
		// Junk in a hand-written file reads as unset, never as a zero stop.
		const junk =
			'version: 1\nroutes:\n- waypoints:\n  - ident: LFPL\n' +
			'flight_prep:\n  dossier:\n    stops: [nope, -5, 20]\n';
		expect(parseRoutesDoc(junk).flightPrep!.dossier!.stopsMin).toEqual([null, null, 20]);
	});

	it('round-trips the dossier block, dates and clocks staying strings', () => {
		const fp = {
			dossier: {
				flightDate: '2026-04-23',
				departureTime: '07:30',
				stopsMin: [0, 15],
				pilotName: 'D. du Colombier',
				sepValidUntil: '2026-12-31',
				medicalValidUntil: '2028-06-25',
				potential: '28:08',
				qnhHpa: 1019,
				checks: ['doc_registration', 'wx_temsi'],
			},
		};
		const text = stringifyRoutesDoc(buildRoutesDoc([{ name: 'T', waypoints: [wp] }], fp));
		expect(text).toMatch(/^ {2}dossier:$/m);
		const d = parseRoutesDoc(text).flightPrep!.dossier!;
		expect(d.flightDate).toBe('2026-04-23');
		expect(d.departureTime).toBe('07:30');
		expect(d.stopsMin).toEqual([0, 15]);
		expect(d.pilotName).toBe('D. du Colombier');
		expect(d.sepValidUntil).toBe('2026-12-31');
		expect(d.medicalValidUntil).toBe('2028-06-25');
		expect(d.potential).toBe('28:08');
		expect(d.qnhHpa).toBe(1019);
		expect(d.checks).toEqual(['doc_registration', 'wx_temsi']);
	});

	it('degrades a malformed dossier field by field', () => {
		const doc =
			'version: 1\nroutes:\n- waypoints:\n  - ident: LFPL\n' +
			'flight_prep:\n  dossier:\n    flight_date: 23/04/2026\n    departure_time: 7:30\n' +
			'    stops: nope\n    pilot: {name: 4}\n    checks: [1, "", wx_temsi]\n';
		const d = parseRoutesDoc(doc).flightPrep!.dossier!;
		expect(d.flightDate).toBeUndefined();
		expect(d.departureTime).toBe('07:30'); // lax H:MM re-padded
		expect(d.stopsMin).toBeUndefined();
		expect(d.pilotName).toBeUndefined();
		expect(d.checks).toEqual(['wx_temsi']);
	});

	it('coerces a bare numeric runway end back to a padded string', () => {
		const doc =
			'version: 1\nroutes:\n- waypoints:\n  - ident: LFPL\n' +
			'flight_prep:\n  performance:\n    aerodromes:\n    - icao: LFPL\n      takeoff: { runway: 08 }\n      landing: { runway: 26 }\n';
		const fp = parseRoutesDoc(doc).flightPrep!;
		expect(fp.aerodromes![0].takeoff!.runwayEnd).toBe('08');
		expect(fp.aerodromes![0].landing!.runwayEnd).toBe('26');
	});

	it('degrades a malformed flight_prep without losing the routes', () => {
		const doc =
			'version: 1\nroutes:\n- waypoints:\n  - ident: LFPL\n' +
			'flight_prep:\n  fuel: nope\n  mass_balance: [1, 2]\n  performance:\n    aerodromes:\n    - { qnh: 1019 }\n    - { icao: LFPK }\n';
		const parsed = parseRoutesDoc(doc);
		expect(parsed.routes).toHaveLength(1);
		const fp = parsed.flightPrep!;
		expect(fp.fuelTrips).toBeUndefined();
		expect(fp.massBalance).toBeUndefined();
		// The ICAO-less aerodrome row is skipped; the valid one survives.
		expect(fp.aerodromes!.map((a) => a.icao)).toEqual(['LFPK']);
	});

	it('a file without flight_prep parses with it undefined', () => {
		expect(parseRoutesDoc('version: 1\nroutes: []').flightPrep).toBeUndefined();
	});
});
