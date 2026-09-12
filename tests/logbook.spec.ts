/* Pins the EASA logbook export (src/lib/nav/logbook.ts): the per-flight
 * splitter over the motion fold's instant arrays (block cuts at the parking,
 * stop-and-go contiguity, the open flight) and the AMC1 FCL.050-shaped CSV
 * (header, UTC clocks, h:mm durations, RFC 4180 quoting, empty cells for
 * the pilot-declared columns). Contract: docs/logbook.md. */

import { describe, expect, it } from 'vitest';
import { extendMotion, newMotionFold } from '$lib/nav/navlogLive';
import {
	buildLogbookCsv,
	detectTouchAndGoes,
	parseLogbookCsv,
	nightMinutes,
	splitFlights,
	summarizeFlights,
	type FlightSlice,
	type LogbookRow,
} from '$lib/nav/logbook';
import type { TrackPoint } from '$lib/nav/trace';

/** 10:00Z midsummer: broad daylight at the equator. */
const T0 = Date.UTC(2026, 6, 21, 10, 0);

function tp(lat: number, lon: number, timeMs: number, speedKt: number): TrackPoint {
	return { lat, lon, timeMs, altFt: null, speedKt, trackDeg: 90, accuracyM: null };
}

/** One fix a minute along the equator at the given speeds (the
 *  navlogLive.spec outing factory, on an absolute clock). */
function outing(speeds: number[], baseMs = T0): TrackPoint[] {
	let lon = 0;
	return speeds.map((kt, i) => {
		const p = tp(0, lon, baseMs + i * 60_000, kt);
		lon += kt / 3600; // kt/60 NM per minute -> degrees of equator lon
		return p;
	});
}

function split(points: TrackPoint[]): FlightSlice[] {
	return splitFlights(points, extendMotion(newMotionFold(), points));
}

function rowOf(slice: FlightSlice, over: Partial<LogbookRow> = {}): LogbookRow {
	return {
		slice,
		departurePlace: 'LFPL',
		arrivalPlace: 'LFFN',
		aircraftMake: 'ROBIN',
		aircraftModel: 'DR400/120',
		registration: 'F-GORQ',
		picName: 'SELF',
		landingsDay: slice.landingMs != null ? 1 : null,
		landingsNight: slice.landingMs != null ? 0 : null,
		nightMin: slice.blockOnMs != null ? 0 : null,
		remarks: 'LFPL - LFFN',
		...over,
	};
}

const HEADER =
	'date,departure_place,departure_time,arrival_place,arrival_time,aircraft_make,aircraft_model,aircraft_registration,sp_se,sp_me,mp_time,total_time,pic_name,landings_day,landings_night,night_time,ifr_time,pic_time,copilot_time,dual_time,instructor_time,fstd_date,fstd_type,fstd_time,remarks,takeoff_time,landing_time,airborne_time,distance_nm';

describe('splitFlights', () => {
	it('cuts two flights at the parking between them', () => {
		// Taxi, fly, land, taxi in, PARK (three stopped minutes), taxi out,
		// fly again, land, taxi in.
		const pts = outing([5, 100, 100, 100, 5, 5, 5, 0, 0, 0, 5, 100, 100, 100, 5, 5, 5, 5]);
		const f = split(pts);
		expect(f.length).toBe(2);
		expect(f[0].blockOffMs).toBe(T0);
		expect(f[0].takeoffMs).toBe(T0 + 1 * 60_000);
		expect(f[0].landingMs).toBe(T0 + 4 * 60_000);
		// Block-on = the last moving fix before the longest stationary run.
		expect(f[0].blockOnMs).toBe(T0 + 6 * 60_000);
		// Block-off of the next = the first moving fix after it.
		expect(f[1].blockOffMs).toBe(T0 + 10 * 60_000);
		expect(f[1].takeoffMs).toBe(T0 + 11 * 60_000);
		expect(f[1].landingMs).toBe(T0 + 14 * 60_000);
		expect(f[1].blockOnMs).toBe(T0 + 17 * 60_000);
		// Along-track distances of the two block spans (equator: kt/60 per
		// one-minute hop).
		expect(f[0].distanceNM).toBeCloseTo(5.25, 1);
		expect(f[1].distanceNM).toBeCloseTo(5.33, 1);
	});

	it('keeps a stop-and-go contiguous at the landing instant', () => {
		// The navlogLive stop-and-go trace: never under MOVE_KT between the
		// two flights, so there is no stationary spell to cut at.
		const pts = outing([5, 100, 100, 100, 5, 5, 5, 100, 100, 100, 100, 5, 5, 5, 5]);
		const f = split(pts);
		expect(f.length).toBe(2);
		expect(f[0].landingMs).toBe(T0 + 4 * 60_000);
		expect(f[0].blockOnMs).toBe(T0 + 4 * 60_000);
		expect(f[1].blockOffMs).toBe(T0 + 4 * 60_000);
		expect(f[1].blockOnMs).toBe(T0 + 14 * 60_000);
	});

	it('leaves a flight without a committed landing open', () => {
		const pts = outing([5, 100, 100, 100, 100]);
		const f = split(pts);
		expect(f.length).toBe(1);
		expect(f[0].blockOffMs).toBe(T0);
		expect(f[0].takeoffMs).toBe(T0 + 1 * 60_000);
		expect(f[0].landingMs).toBeNull();
		expect(f[0].blockOnMs).toBeNull();
		expect(f[0].distanceNM).toBeCloseTo(305 / 60, 1);
	});

	it('is empty without a committed takeoff', () => {
		expect(split(outing([5, 5, 5]))).toEqual([]);
		expect(splitFlights([], newMotionFold())).toEqual([]);
	});
});

describe('buildLogbookCsv', () => {
	/** A hand-built landed flight: block 10:00Z to 11:35:24Z (95.4 min, the
	 *  h:mm rounding case), takeoff 10:05Z, landing 11:30Z. */
	const landed: FlightSlice = {
		blockOffMs: T0,
		takeoffMs: T0 + 5 * 60_000,
		landingMs: T0 + 90 * 60_000,
		blockOnMs: T0 + 95.4 * 60_000,
		distanceNM: 42.35,
	};

	it('emits the exact AMC-shaped header', () => {
		const lines = buildLogbookCsv([]).split('\r\n');
		expect(lines[0]).toBe(HEADER);
		expect(lines[1]).toBe('');
	});

	it('fills a landed flight and leaves the pilot columns empty', () => {
		const csv = buildLogbookCsv([rowOf(landed, { nightMin: 12 })]);
		const lines = csv.split('\r\n');
		expect(lines.length).toBe(3); // header, row, trailing empty
		const cells = lines[1].split(',');
		expect(cells[0]).toBe('2026-07-21'); // date of block off
		expect(cells[1]).toBe('LFPL');
		expect(cells[2]).toBe('10:00');
		expect(cells[3]).toBe('LFFN');
		expect(cells[4]).toBe('11:35'); // block on
		expect(cells[5]).toBe('ROBIN');
		expect(cells[6]).toBe('DR400/120');
		expect(cells[7]).toBe('F-GORQ');
		expect(cells.slice(8, 11)).toEqual(['', '', '']); // sp_se, sp_me, mp
		expect(cells[11]).toBe('1:35'); // total: 95.4 min rounds to 95
		expect(cells[12]).toBe('SELF');
		expect(cells[13]).toBe('1'); // landings_day
		expect(cells[14]).toBe('0'); // landings_night
		expect(cells[15]).toBe('0:12'); // night_time
		expect(cells.slice(16, 24)).toEqual(['', '', '', '', '', '', '', '']); // ifr, functions, fstd
		expect(cells[24]).toBe('LFPL - LFFN');
		expect(cells[25]).toBe('10:05');
		expect(cells[26]).toBe('11:30');
		expect(cells[27]).toBe('1:25'); // airborne
		expect(cells[28]).toBe('42.4');
	});

	it('prints the landings counts, touch-and-goes included', () => {
		// A committed night landing plus two day touch-and-goes.
		const cells = buildLogbookCsv([rowOf(landed, { landingsDay: 2, landingsNight: 1 })])
			.split('\r\n')[1]
			.split(',');
		expect(cells[13]).toBe('2');
		expect(cells[14]).toBe('1');
	});

	it('leaves the arrival half of an open flight empty', () => {
		const open: FlightSlice = {
			blockOffMs: T0,
			takeoffMs: T0 + 5 * 60_000,
			landingMs: null,
			blockOnMs: null,
			distanceNM: 10,
		};
		const cells = buildLogbookCsv([rowOf(open)]).split('\r\n')[1].split(',');
		expect(cells[4]).toBe(''); // arrival_time
		expect(cells[11]).toBe(''); // total_time
		expect(cells[13]).toBe(''); // landings_day
		expect(cells[14]).toBe(''); // landings_night
		expect(cells[15]).toBe(''); // night_time
		expect(cells[26]).toBe(''); // landing_time
		expect(cells[27]).toBe(''); // airborne_time
	});

	it('quotes RFC 4180 fields holding commas and quotes', () => {
		const csv = buildLogbookCsv([
			rowOf(landed, { remarks: 'LFPL "north", then LFFN' }),
		]);
		expect(csv).toContain('"LFPL ""north"", then LFFN"');
	});

	it('dates the row on the UTC day the block opens, across midnight', () => {
		const night: FlightSlice = {
			blockOffMs: Date.UTC(2026, 0, 15, 23, 50),
			takeoffMs: Date.UTC(2026, 0, 15, 23, 55),
			landingMs: Date.UTC(2026, 0, 16, 0, 15),
			blockOnMs: Date.UTC(2026, 0, 16, 0, 20),
			distanceNM: 20,
		};
		const cells = buildLogbookCsv([rowOf(night)]).split('\r\n')[1].split(',');
		expect(cells[0]).toBe('2026-01-15');
		expect(cells[4]).toBe('00:20'); // block on, the next UTC day
		expect(cells[11]).toBe('0:30');
	});
});

/** One fix a SECOND at the given [seconds, kt, altFt] phases along the
 *  equator (the detector's thresholds live under a minute, unlike the
 *  per-minute outing factory above). */
function phased(phases: [number, number, number | null][]): TrackPoint[] {
	const pts: TrackPoint[] = [];
	let lon = 0;
	let t = 0;
	for (const [dur, kt, altFt] of phases) {
		for (let s = 0; s < dur; s++) {
			pts.push({ lat: 0, lon, timeMs: T0 + t * 1000, altFt, speedKt: kt, trackDeg: 90, accuracyM: null });
			lon += kt / (3600 * 3600);
			t++;
		}
	}
	return pts;
}

const FIELD_FT = 400;
const atField = (): number | null => FIELD_FT;
const msl = (p: TrackPoint): number | null => p.altFt;

/** Taxi, takeoff, cruise, one dip, cruise, committed landing, taxi in.
 *  The cruises outlast TOUCH_CYCLE_MS so the dip stands clear of the
 *  takeoff and of the committed landing's own approach window. */
function circuit(dip: [number, number, number | null]): TrackPoint[] {
	return phased([
		[20, 5, FIELD_FT],
		[8, 50, FIELD_FT],
		[150, 80, 1600],
		dip,
		[150, 80, 1600],
		[15, 15, FIELD_FT + 5],
		[60, 10, FIELD_FT],
		[10, 0, FIELD_FT],
	]);
}

describe('parseLogbookCsv', () => {
	const landed: FlightSlice = {
		blockOffMs: T0,
		takeoffMs: T0 + 5 * 60_000,
		landingMs: T0 + 90 * 60_000,
		blockOnMs: T0 + 95 * 60_000,
		distanceNM: 42.4,
	};

	it('round-trips the export, quoted remark included', () => {
		const csv = buildLogbookCsv([
			rowOf(landed, { nightMin: 12, remarks: 'LFPL - LFFN, via MLN' }),
		]);
		const parsed = parseLogbookCsv(csv);
		expect(parsed.skipped).toBe(0);
		expect(parsed.rows.length).toBe(1);
		const r = parsed.rows[0];
		expect(r.registration).toBe('F-GORQ');
		expect(r.remarks).toBe('LFPL - LFFN, via MLN');
		expect(r.flight).toEqual({
			blockOffMs: T0,
			takeoffMs: T0 + 5 * 60_000,
			landingMs: T0 + 90 * 60_000,
			blockOnMs: T0 + 95 * 60_000,
			distanceNM: 42.4,
			depPlace: 'LFPL',
			arrPlace: 'LFFN',
			landingsDay: 1,
			landingsNight: 0,
			nightMin: 12,
		});
	});

	it('reads back the pilot-DECLARED cells and writes them out unchanged', () => {
		// The columns this application never derives (AMC1 FCL.050 (a)(4),
		// (a)(5), (a)(3) and the PIC name). A trace cannot attest a legal
		// role, so importing a real logbook and exporting it back must not
		// blank what the pilot declared, nor restate THIS device's pilot as
		// the commander of a flight it only read about.
		const source = buildLogbookCsv([rowOf(landed, { picName: 'DUPONT' })])
			.split('\r\n')
			.map((line, i) => {
				if (i !== 1) {
					return line;
				}
				const c = line.split(',');
				const h = buildLogbookCsv([]).split('\r\n')[0].split(',');
				c[h.indexOf('sp_se')] = '1:30';
				c[h.indexOf('pic_time')] = '1:30';
				c[h.indexOf('dual_time')] = '0:20';
				c[h.indexOf('ifr_time')] = '0:15';
				c[h.indexOf('fstd_type')] = 'FNPT II';
				return c.join(',');
			})
			.join('\r\n');
		const parsed = parseLogbookCsv(source);
		expect(parsed.rows[0].declared).toEqual({
			sp_se: '1:30',
			pic_name: 'DUPONT',
			pic_time: '1:30',
			dual_time: '0:20',
			ifr_time: '0:15',
			fstd_type: 'FNPT II',
		});
		// Re-emitted verbatim, and the row's own PIC beats the caller's.
		const out = buildLogbookCsv([
			{ ...rowOf(landed, { picName: 'SOMEONE ELSE' }), declared: parsed.rows[0].declared },
		]);
		expect(out).toBe(source);
	});

	it('leaves a row that declares nothing with no declarations', () => {
		const parsed = parseLogbookCsv(buildLogbookCsv([rowOf(landed, { picName: '' })]));
		// Empty cells are absent, not empty strings: a trace-derived row
		// then falls back to the resolved pilot as it always has.
		expect(parsed.rows[0].declared).toEqual({});
	});

	it('rolls clocks past midnight', () => {
		const dusk = Date.UTC(2026, 6, 21, 23, 50);
		const hop: FlightSlice = {
			blockOffMs: dusk,
			takeoffMs: dusk + 5 * 60_000, // 23:55
			landingMs: dusk + 25 * 60_000, // 00:15 next day
			blockOnMs: dusk + 30 * 60_000, // 00:20 next day
			distanceNM: 10,
		};
		const r = parseLogbookCsv(buildLogbookCsv([rowOf(hop)])).rows[0];
		expect(r.flight.blockOffMs).toBe(dusk);
		expect(r.flight.landingMs).toBe(Date.UTC(2026, 6, 22, 0, 15));
		expect(r.flight.blockOnMs).toBe(Date.UTC(2026, 6, 22, 0, 20));
	});

	it('addresses columns by name and stands takeoff in for a bare row', () => {
		// A foreign AMC-shaped file: reordered columns, extras, no extras
		// columns of ours; takeoff falls back to block-off.
		const csv = 'departure_time,date,foo\n10:00,2026-07-21,x\n';
		const parsed = parseLogbookCsv(csv);
		expect(parsed.rows.length).toBe(1);
		expect(parsed.rows[0].flight.blockOffMs).toBe(T0);
		expect(parsed.rows[0].flight.takeoffMs).toBe(T0);
		expect(parsed.rows[0].flight.blockOnMs).toBeNull();
		expect(parsed.rows[0].registration).toBeNull();
	});

	it('skips malformed data lines and counts them', () => {
		const csv = 'date,departure_time\n2026-07-21,10:00\nnot-a-date,10:00\n2026-07-21,99:99\n';
		const parsed = parseLogbookCsv(csv);
		expect(parsed.rows.length).toBe(1);
		expect(parsed.skipped).toBe(2);
	});

	it('rejects a text that is no logbook CSV', () => {
		expect(() => parseLogbookCsv('hello,world\n1,2\n')).toThrow(/logbook CSV/);
		expect(() => parseLogbookCsv('')).toThrow(/logbook CSV/);
	});
});

describe('detectTouchAndGoes', () => {
	function detect(points: TrackPoint[], field = atField): ReturnType<typeof detectTouchAndGoes> {
		return detectTouchAndGoes(points, extendMotion(newMotionFold(), points), msl, field);
	}

	it('counts a low sustained dip as a touch-and-go, once', () => {
		const tgs = detect(circuit([10, 35, FIELD_FT + 20]));
		// One touch: the dip, never the final rollout (its run touches the
		// bracket end) nor the takeoff roll.
		expect(tgs.length).toBe(1);
		expect(tgs[0].ms).toBeGreaterThanOrEqual(T0 + 178_000);
		expect(tgs[0].ms).toBeLessThan(T0 + 188_000);
	});

	it('rejects a dip at altitude (slow flight, a steep turn)', () => {
		expect(detect(circuit([10, 35, 1600])).length).toBe(0);
	});

	it('rejects a dip too brief to be a ground roll', () => {
		expect(detect(circuit([3, 35, FIELD_FT + 20])).length).toBe(0);
	});

	it('rejects a dip with no known aerodrome under it', () => {
		expect(detect(circuit([10, 35, FIELD_FT + 20]), () => null).length).toBe(0);
	});

	it('rejects a dip with no usable altitude', () => {
		expect(detect(circuit([10, 35, null])).length).toBe(0);
	});

	it('collapses fragments of one approach to a single touch', () => {
		// The median crossing TOUCH_SLOW_KT on final can split one pass into
		// several interior runs seconds apart; wheels cannot come down twice
		// within TOUCH_CYCLE_MS.
		const tgs = detect(
			phased([
				[20, 5, FIELD_FT],
				[8, 50, FIELD_FT],
				[150, 80, 1600],
				[10, 35, FIELD_FT + 20],
				[30, 80, 1600],
				[10, 35, FIELD_FT + 20],
				[150, 80, 1600],
				[15, 15, FIELD_FT + 5],
				[60, 10, FIELD_FT],
				[10, 0, FIELD_FT],
			]),
		);
		expect(tgs.length).toBe(1);
	});

	it('drops a slow fragment riding the final approach', () => {
		// A sub-gate run 60 s ahead of the committed landing is that
		// landing's own approach, not a separate touch.
		const tgs = detect(
			phased([
				[20, 5, FIELD_FT],
				[8, 50, FIELD_FT],
				[150, 80, 1600],
				[10, 35, FIELD_FT + 20],
				[60, 80, 1600],
				[15, 15, FIELD_FT + 5],
				[60, 10, FIELD_FT],
				[10, 0, FIELD_FT],
			]),
		);
		expect(tgs.length).toBe(0);
	});

	it('detects the low slow pass a jittery dense trace never shows raw', () => {
		// 1 Hz GPS ground-roll jitter: raw speed cycles 50/60/85 kt, never
		// sustaining below TOUCH_SPEED_KT, while the +-5 s median (the
		// below-65 majority) holds under TOUCH_SLOW_KT for the whole pass.
		// On the field it is a touch; the same pass at altitude stays slow
		// flight.
		const jitterPass = (alt: number): [number, number, number | null][] => {
			const phases: [number, number, number | null][] = [
				[20, 5, FIELD_FT],
				[8, 50, FIELD_FT],
				[150, 80, 1600],
			];
			for (let i = 0; i < 7; i++) {
				phases.push([1, 50, alt], [1, 60, alt], [1, 85, alt]);
			}
			phases.push([150, 80, 1600], [15, 15, FIELD_FT + 5], [60, 10, FIELD_FT], [10, 0, FIELD_FT]);
			return phases;
		};
		expect(detect(phased(jitterPass(FIELD_FT + 20))).length).toBe(1);
		expect(detect(phased(jitterPass(1600))).length).toBe(0);
	});

	it('detects a touch a sparse trace leaves as a single slow fix', () => {
		// The aerogest 9-second traces: a real touch-and-go spans one or
		// two fixes, so the run's internal duration is near zero; the
		// midpoint estimate of the crossing instants still reads the full
		// sampling bracket. One fix at 35 kt on the field detects; the
		// same trace with the dip at altitude stays rejected.
		const step = 9;
		const sparse = (dipAlt: number): TrackPoint[] => {
			const phases: [number, number, number | null][] = [
				[3, 5, FIELD_FT],
				[2, 50, FIELD_FT],
				[5, 80, 1600],
				[1, 35, dipAlt],
				[15, 80, 1600],
				[2, 15, FIELD_FT + 5],
				[8, 10, FIELD_FT],
				[2, 0, FIELD_FT],
			];
			const pts: TrackPoint[] = [];
			let t = 0;
			let lon = 0;
			for (const [n, kt, altFt] of phases) {
				for (let i = 0; i < n; i++) {
					pts.push({
						lat: 0,
						lon,
						timeMs: T0 + t * step * 1000,
						altFt,
						speedKt: kt,
						trackDeg: 90,
						accuracyM: null,
					});
					lon += (kt * step) / (3600 * 3600);
					t++;
				}
			}
			return pts;
		};
		expect(detect(sparse(FIELD_FT + 20)).length).toBe(1);
		expect(detect(sparse(1600)).length).toBe(0);
	});
});

describe('summarizeFlights', () => {
	const deps = { altMslFt: msl, fieldElevFt: atField, placeIdentAt: () => 'LFPL' };

	it('resolves places and attributes the touch-and-go to its flight', () => {
		const pts = circuit([10, 35, FIELD_FT + 20]);
		const s = summarizeFlights(pts, extendMotion(newMotionFold(), pts), deps);
		expect(s.length).toBe(1);
		expect(s[0].depPlace).toBe('LFPL');
		expect(s[0].arrPlace).toBe('LFPL');
		// The committed landing plus the touch-and-go, both in daylight.
		expect(s[0].landingsDay).toBe(2);
		expect(s[0].landingsNight).toBe(0);
		expect(s[0].nightMin).toBe(0);
		expect(s[0].blockOnMs).not.toBeNull();
		// The touch-and-go then the landing, chronological, repeats kept.
		expect(s[0].touchPlaces).toEqual(['LFPL', 'LFPL']);
	});

	it('leaves an open flight null-sided', () => {
		const pts = phased([
			[20, 5, FIELD_FT],
			[8, 50, FIELD_FT],
			[40, 80, 1600],
		]);
		const s = summarizeFlights(pts, extendMotion(newMotionFold(), pts), deps);
		expect(s.length).toBe(1);
		expect(s[0].landingMs).toBeNull();
		expect(s[0].blockOnMs).toBeNull();
		expect(s[0].arrPlace).toBe('');
		expect(s[0].landingsDay).toBeNull();
		expect(s[0].landingsNight).toBeNull();
		expect(s[0].nightMin).toBeNull();
		expect(s[0].touchPlaces).toEqual([]);
	});

	it('closes the trailing flight when the recording ends slow on a field', () => {
		// Landed and taxiing, but the recording ends 35 s into the slow
		// stretch: the fold's minute-long sustain never confirms, and the
		// outing used to file an OPEN flight. At debrief the trace end is a
		// fact, so the still-open streak on the field IS the landing,
		// committed at the streak start like every other.
		const pts = phased([
			[20, 5, FIELD_FT],
			[8, 50, FIELD_FT],
			[150, 80, 1600],
			[15, 15, FIELD_FT + 5],
			[20, 10, FIELD_FT],
		]);
		const s = summarizeFlights(pts, extendMotion(newMotionFold(), pts), deps);
		expect(s.length).toBe(1);
		expect(s[0].landingMs).toBe(T0 + (20 + 8 + 150) * 1000);
		expect(s[0].blockOnMs).not.toBeNull();
		expect(s[0].landingsDay).toBe(1);
		expect(s[0].arrPlace).toBe('LFPL');
	});

	it('counts the closed landing once: its own rollout fragment is no touch-and-go', () => {
		// 1 Hz phone GPS jitters the rollout: ten sub-45 seconds on the
		// runway, one bad fix at 46 kt, then the slow taxi to the trace end.
		// Against the fold's OPEN bracket that fragment is an interior run
		// on the field and reads as a touch; the closed landing must reach
		// the detector so its approach-collapse guard drops it.
		const pts = phased([
			[20, 5, FIELD_FT],
			[8, 50, FIELD_FT],
			[150, 80, 1600],
			[10, 40, FIELD_FT + 5],
			[1, 46, FIELD_FT + 5],
			[20, 10, FIELD_FT],
		]);
		const s = summarizeFlights(pts, extendMotion(newMotionFold(), pts), deps);
		expect(s.length).toBe(1);
		expect(s[0].landingMs).toBe(T0 + (20 + 8 + 150 + 10 + 1) * 1000);
		expect(s[0].landingsDay).toBe(1);
		expect(s[0].touchPlaces).toEqual(['LFPL']);
	});

	it('keeps the flight open when the trace ends away from any field', () => {
		// The same shape slowed IN THE AIR (a recording dying on final at
		// 900 ft): no elevation match, no fabricated landing.
		const pts = phased([
			[20, 5, FIELD_FT],
			[8, 50, FIELD_FT],
			[150, 80, 1600],
			[35, 15, FIELD_FT + 900],
		]);
		const s = summarizeFlights(pts, extendMotion(newMotionFold(), pts), deps);
		expect(s[0].landingMs).toBeNull();
	});

	it('keeps the flight open when the streak carries no altitude at all', () => {
		const pts = phased([
			[20, 5, FIELD_FT],
			[8, 50, FIELD_FT],
			[150, 80, 1600],
			[35, 15, null],
		]);
		const s = summarizeFlights(pts, extendMotion(newMotionFold(), pts), deps);
		expect(s[0].landingMs).toBeNull();
	});

	it('reads the streak last known altitude past trailing ele holes', () => {
		// A tenth of the corpus points carry no <ele>; a landing whose FINAL
		// fix is one of the holes must not stay open for it.
		const pts = phased([
			[20, 5, FIELD_FT],
			[8, 50, FIELD_FT],
			[150, 80, 1600],
			[30, 15, FIELD_FT + 5],
			[5, 10, null],
		]);
		const s = summarizeFlights(pts, extendMotion(newMotionFold(), pts), deps);
		expect(s[0].landingMs).toBe(T0 + (20 + 8 + 150) * 1000);
	});
});

describe('nightMinutes', () => {
	it('integrates the block span per minute at the aeronautical-night rule', () => {
		// A 10 min stand at the equator, 22:00Z: hours past sunset, all night.
		const nightPts = outing(
			Array.from({ length: 11 }, () => 5),
			Date.UTC(2026, 6, 21, 22, 0),
		);
		expect(
			nightMinutes(nightPts, nightPts[0].timeMs, nightPts[10].timeMs),
		).toBe(10);
		// The same stand at 10:00Z is all day.
		const dayPts = outing(Array.from({ length: 11 }, () => 5));
		expect(nightMinutes(dayPts, dayPts[0].timeMs, dayPts[10].timeMs)).toBe(0);
	});
});
