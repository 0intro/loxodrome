<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	/* Runway performance: the POH reference table (table-kind aircraft) and a
	 * takeoff + landing grid, one column per aerodrome the flight touches
	 * (trip endpoints + alternates, plus manual adds). Inputs per column:
	 * QNH (defaulting to the dossier's Météo QNH, then standard), temperature
	 * (defaults to ISA at the pressure altitude), headwind / tailwind, wet,
	 * and the runway END (QFU), whose per-direction declared distances drive
	 * the verdicts: ground roll vs TORA and distance over 15 m vs TODA on
	 * takeoff, distance from 15 m vs LDA on landing, plus the flapless-landing
	 * feasibility. Extrapolated POH values tint orange like the workbook; so
	 * do declared distances assumed from the physical runway length (dataset
	 * publishes none) and the verdicts that consumed one. */

	import { routes } from '$lib/state/route.svelte';
	import { airportByIdent } from '$lib/state/data.svelte';
	import { selectedAircraft } from '$lib/state/aircraft.svelte';
	import {
		flightPrep,
		perfFor,
		setPerfQnh,
		setPerfBlock,
		resetPerfWeather,
		addManualAerodrome,
		removeManualAerodrome,
		type PerfBlockInputs,
	} from '$lib/state/flightPrep.svelte';
	import { orderedTrips } from '$lib/aircraft/trips';
	import { perfIcaos, runwayEnds, bestRunwayEnd, type RunwayEnd } from '$lib/aircraft/aerodromes';
	import { formatSurface, type Airport } from '$lib/data/airports';
	import type { ClosedFormConfig } from '$lib/aircraft/schema';
	import {
		pressureAltitudeFt,
		isaTemperatureC,
		computeTablePerformance,
		computeClosedFormPerformance,
		verdictConfig,
		takeoffVerdict,
		landingVerdict,
		type PerfPhase,
		type PerfConditions,
		type PerfResult,
		type PerfComputation,
		type RawDistances,
		type AssumedDistances,
		type DeclaredDistancesM,
		type TakeoffVerdict,
		type LandingVerdict,
	} from '$lib/aircraft/performance';
	import type { NomogramMetric } from '$lib/aircraft/performanceChart';
	import { display } from '$lib/state/display.svelte';
	import { notamState } from '$lib/state/notam.svelte';
	import {
		nearestWx,
		ensureNearestMetar,
		refreshWeather,
		usableNearest,
	} from '$lib/state/weather.svelte';
	import {
		metarAgeMin,
		qnhFromMetar,
		windComponents,
		formatWind,
		formatAge,
		formatDistanceNM,
		precipSuggestsWet,
		type NearestPick,
		type WindComponents,
	} from '$lib/weather/metar';
	import { decimalYearFromDate } from '$lib/route/magnetic';
	import { formatZulu } from '$lib/format/datetime';
	import PerfNomogram from './PerfNomogram.svelte';
	import { fuelComputation, mbComputation, performanceMassKg } from './shared';
	import { printValue } from '$lib/ui/printValue';

	const PHASES: PerfPhase[] = ['takeoff', 'landing'];

	// Unique id prefix: this page is mounted twice while pack-printing (the
	// modal + the print doc), so bare ids would collide.
	const uid = $props.id();

	const aircraft = $derived(selectedAircraft());
	const perf = $derived(aircraft?.performance ?? null);
	const fuel = $derived(fuelComputation());
	const mb = $derived(mbComputation(fuel));
	const massKg = $derived(performanceMassKg(mb, aircraft));
	const icaos = $derived(perfIcaos(orderedTrips(routes.list), flightPrep.perf.manualIcaos));

	// Any typed QNH / temperature / wind override anywhere (enables the
	// "Reset to live weather" button).
	const hasWeatherOverrides = $derived.by(() => {
		for (const a of Object.values(flightPrep.perf.byIcao)) {
			if (a.qnhHpa != null) {
				return true;
			}
			for (const phase of ['takeoff', 'landing'] as const) {
				const b = a[phase];
				if (b.tempC != null || b.headwindKt != null || b.tailwindKt != null) {
					return true;
				}
			}
		}
		return false;
	});

	let newIcao = $state('');
	// The unknown ident, not a rendered message: the error line re-renders
	// through t on a locale switch (docs/i18n.md rule 7).
	let addErrorIcao = $state<string | null>(null);

	function addAerodrome(): void {
		const icao = newIcao.trim().toUpperCase();
		addErrorIcao = null;
		if (!icao) {
			return;
		}
		if (!airportByIdent(icao)) {
			addErrorIcao = icao;
			return;
		}
		addManualAerodrome(icao);
		newIcao = '';
	}

	const NO_DD: DeclaredDistancesM = { toraM: null, todaM: null, asdaM: null, ldaM: null };

	interface CellRow {
		/** null for the table model (a single set), the flap config otherwise. */
		config: ClosedFormConfig | null;
		result: PerfResult;
	}

	/** Where a field's automatic (non-typed) value comes from: 'metar' (gray,
	 *  follows a usable METAR), 'estimate' (amber, live weather is on but there
	 *  is no usable METAR so the value is an estimate), 'neutral' (gray, live
	 *  weather off or a derived calm, not an error). */
	type FieldSource = 'metar' | 'estimate' | 'neutral';

	/** One performance weather input, rendered uniformly (see the weatherField
	 *  snippet): the typed override (null = automatic), the automatic value
	 *  shown as a gray/amber placeholder, its source, a provenance tooltip, the
	 *  numeric bounds, and the setter. */
	interface WeatherField {
		override: number | null;
		auto: number;
		source: FieldSource;
		title: string;
		/** Row + aerodrome: a row header does not name an input in a cell. */
		label: string;
		min: number | undefined;
		max: number | undefined;
		set: (v: number | null) => void;
	}

	interface Cell {
		icao: string;
		airport: Airport | null;
		manual: boolean;
		block: PerfBlockInputs;
		ends: RunwayEnd[];
		end: RunwayEnd | null;
		elevFt: number | null;
		paFt: number | null;
		grass: boolean;
		rows: CellRow[];
		dd: DeclaredDistancesM;
		takeoffV: TakeoffVerdict | null;
		landingV: LandingVerdict | null;
		/** The four weather inputs as a uniform view model. */
		qnh: WeatherField;
		temp: WeatherField;
		headwind: WeatherField;
		tailwind: WeatherField;
	}

	// Live weather: fetch the nearest METAR of every aerodrome on the grid
	// (auto on open; the records cache for 5 minutes, auto-refresh on the
	// minute tick while the page is open, and refresh on demand).
	$effect(() => {
		void notamState.tick;
		if (!display.liveWeather) {
			return;
		}
		for (const icao of icaos) {
			const a = airportByIdent(icao);
			if (a) {
				ensureNearestMetar(icao, a.lat, a.lon);
			}
		}
	});

	// Live ages and freshness gates re-evaluate on the shared 60 s tick.
	const nowMs = $derived.by(() => {
		void notamState.tick;
		return Date.now();
	});

	// WMM epoch for the true-to-magnetic wind conversion; one read per mount,
	// like the nav-log sheet.
	const wmmYear = decimalYearFromDate(new Date());

	/** The aerodrome's nearest METAR when it may supply defaults: live weather
	 *  on, an observation on hand, station close enough, observation fresh
	 *  enough (usableNearest). The fetch STATUS is deliberately not a gate:
	 *  a refresh in flight or one that failed keeps the observation it had,
	 *  and gating on it is what used to revert the whole grid to ISA for the
	 *  length of a refetch, print included. */
	function liveMetar(icao: string): NearestPick | null {
		return display.liveWeather ? usableNearest(nearestWx(icao), nowMs) : null;
	}

	/** Whether the pilot has typed over any of this aerodrome's weather inputs,
	 *  in either phase. Those cells no longer follow the observation, which the
	 *  provenance line has to say or the printed sheet contradicts itself (a
	 *  cell reading 1005 beside a line quoting Q1018). */
	function hasTypedWeather(icao: string): boolean {
		const a = perfFor(icao);
		if (a.qnhHpa != null) {
			return true;
		}
		return PHASES.some(
			(phase) =>
				a[phase].tempC != null || a[phase].headwindKt != null || a[phase].tailwindKt != null,
		);
	}

	function metarQnh(icao: string): number | null {
		const pick = liveMetar(icao);
		return pick ? qnhFromMetar(pick.metar) : null;
	}

	/** METAR wind projected on a runway end (null when variable / missing
	 *  or no usable station). */
	function metarWind(icao: string, end: RunwayEnd | null): WindComponents | null {
		const pick = liveMetar(icao);
		const airport = airportByIdent(icao);
		if (!pick || !airport || !end) {
			return null;
		}
		return windComponents(pick.metar, end.id, airport.lat, airport.lon, wmmYear);
	}

	/** 'from LFPN METAR, 11 NM away, 25 min ago' (distance omitted for the
	 *  aerodrome's own station). */
	function provenance(icao: string, pick: NearestPick): string {
		const dist =
			pick.metar.icaoId === icao ? '' : t.flightprep.distAway(formatDistanceNM(pick.distanceM));
		return t.flightprep.fromMetar({
			id: pick.metar.icaoId,
			dist,
			age: formatAge(metarAgeMin(pick.metar, nowMs), t.weather.metar),
		});
	}

	/** A field's automatic value is gray when a usable METAR backs it, amber
	 *  when live weather is on but none is available (an estimate), and neutral
	 *  gray when live weather is off (no live data expected). */
	function fieldSource(hasMetar: boolean): FieldSource {
		return hasMetar ? 'metar' : display.liveWeather ? 'estimate' : 'neutral';
	}

	/** QNH chain: the per-aerodrome value > the nearest fresh METAR > the
	 *  dossier's Météo default > standard (null: pressure altitude =
	 *  elevation). */
	function effectiveQnh(icao: string, inputs: { qnhHpa: number | null }): number | null {
		return inputs.qnhHpa ?? metarQnh(icao) ?? flightPrep.dossier.qnhHpa;
	}

	/** The wind pair a phase computes with: the typed components when either
	 *  one is set (explicit, METAR ignored for the whole phase), else the
	 *  METAR projection on the effective runway end, else calm. */
	function effectiveWind(
		icao: string,
		block: PerfBlockInputs,
		end: RunwayEnd | null,
	): { headwindKt: number; tailwindKt: number } {
		if (block.headwindKt != null || block.tailwindKt != null) {
			return { headwindKt: block.headwindKt ?? 0, tailwindKt: block.tailwindKt ?? 0 };
		}
		return metarWind(icao, end) ?? { headwindKt: 0, tailwindKt: 0 };
	}

	/** One aerodrome's line of the weather strip, on screen and on paper: the
	 *  observation its automatic values came from, or why it has none. The
	 *  OBSERVATION is tested first and the fetch status is only an annotation
	 *  (the usableNearest rule), because a failed refresh leaves the values it
	 *  had: a line reading "weather unavailable" over a grid still computing
	 *  from that observation would be the lie. The raw METAR rides as the hover
	 *  title. */
	function wxLine(icao: string): {
		text: string;
		title: string | undefined;
		stale: boolean;
	} {
		const rec = nearestWx(icao);
		const typed = hasTypedWeather(icao) ? [t.flightprep.wxTypedNote] : [];
		if (!rec || (rec.status === 'loading' && !rec.metar)) {
			return { text: t.flightprep.wxFetching(icao), title: undefined, stale: false };
		}
		if (!rec.metar || rec.distanceM == null) {
			const why =
				rec.status === 'error' ? t.flightprep.wxUnavailable(icao) : t.flightprep.wxNoStation(icao);
			return {
				text: [why, t.flightprep.wxEstimatedNote, ...typed].join(', '),
				title: undefined,
				stale: true,
			};
		}
		const m = rec.metar;
		const head =
			m.icaoId === icao
				? `${icao} METAR`
				: t.flightprep.wxNearestHead({ icao, id: m.icaoId, dist: formatDistanceNM(rec.distanceM) });
		const parts = [
			head,
			`(${formatZulu(new Date(m.obsTime * 1000))}, ${formatAge(metarAgeMin(m, nowMs), t.weather.metar)})`,
		];
		const wind = formatWind(m, t.weather.metar);
		if (wind) {
			parts.push(wind);
		}
		const qnh = qnhFromMetar(m);
		if (qnh != null) {
			parts.push(`Q${qnh}`);
		}
		if (m.temp != null) {
			parts.push(`${m.temp} °C`);
		}
		if (precipSuggestsWet(m.wxString)) {
			parts.push(t.flightprep.precipReported);
		}
		const stale = usableNearest(rec, nowMs) == null;
		if (stale) {
			parts.push(t.flightprep.tooOldNote, t.flightprep.wxEstimatedNote);
		}
		if (rec.status === 'error') {
			parts.push(t.flightprep.wxRefreshFailedNote);
		}
		parts.push(...typed);
		return { text: parts.join(', '), title: m.rawOb, stale };
	}

	/** The conditions of one aerodrome's phase block for a specific runway end,
	 *  the single recipe the grid AND the nomogram path share; null until mass +
	 *  elevation resolve. */
	function conditionsForEnd(
		icao: string,
		phase: PerfPhase,
		end: RunwayEnd | null,
	): PerfConditions | null {
		const airport = airportByIdent(icao);
		const inputs = perfFor(icao);
		const block = inputs[phase];
		const elevFt = airport?.elevFt ?? null;
		const paFt = elevFt == null ? null : pressureAltitudeFt(elevFt, effectiveQnh(icao, inputs));
		const isaC = paFt == null ? null : isaTemperatureC(paFt);
		if (paFt == null || massKg == null) {
			return null;
		}
		const wind = effectiveWind(icao, block, end);
		return {
			massKg,
			pressureAltFt: paFt,
			temperatureC: block.tempC ?? liveMetar(icao)?.metar.temp ?? isaC ?? 15,
			headwindKt: wind.headwindKt - wind.tailwindKt,
			surface: { grass: end?.grass ?? false, wet: block.wet },
		};
	}

	/** The verdict config's factored distances (after wind + surface, before the
	 *  +30% margin), the figures the runway verdict reads; null when not
	 *  computable (no sheet, no conditions, or pressure altitude above the
	 *  table). */
	function factoredFor(phase: PerfPhase, c: PerfConditions | null): RawDistances | null {
		if (!perf || !c) {
			return null;
		}
		let result: PerfResult | null;
		if (perf.kind === 'table') {
			result = computeTablePerformance(perf, phase, c);
		} else {
			const def = verdictConfig(perf, phase);
			result = def ? computeClosedFormPerformance(perf, def, c) : null;
		}
		return result && result.ok
			? {
					groundRollM: result.value.groundRoll.factoredM,
					distance15mM: result.value.distance15m.factoredM,
				}
			: null;
	}

	/** Whether a runway end is long enough for the phase (the verdict is not
	 *  limiting); false when it cannot be computed. */
	function endLongEnough(icao: string, phase: PerfPhase, end: RunwayEnd): boolean {
		const f = factoredFor(phase, conditionsForEnd(icao, phase, end));
		if (!f) {
			return false;
		}
		const limiting =
			phase === 'takeoff'
				? takeoffVerdict(f, end.distances).limiting
				: landingVerdict(f.distance15mM, end.distances, perf?.flaplessLandingFactor ?? null)
						.ldaLimiting;
		return limiting === false;
	}

	/** Signed headwind along a runway end from the live METAR, kt (negative =
	 *  tailwind); 0 when no usable METAR. Ranks the into-wind choice off the
	 *  real wind direction (per end), so a typed wind override (one component on
	 *  the chosen runway, no direction) only changes that runway's numbers,
	 *  never which runway is auto-selected. */
	function endHeadwind(icao: string, end: RunwayEnd): number {
		const mw = metarWind(icao, end);
		return mw ? mw.headwindKt - mw.tailwindKt : 0;
	}

	/** The runway end a cell uses: the pilot's explicit pick, else the default
	 *  into-wind choice (long-enough paved most into wind, see bestRunwayEnd).
	 *  Shared by the grid and the nomogram so both always agree. */
	function resolveEnd(icao: string, phase: PerfPhase): RunwayEnd | null {
		const airport = airportByIdent(icao);
		const ends = airport ? runwayEnds(airport) : [];
		const block = perfFor(icao)[phase];
		const chosen = ends.find((e) => e.id === block.runwayEnd);
		if (chosen) {
			return chosen;
		}
		return bestRunwayEnd(
			ends.map((end) => ({
				end,
				grass: end.grass,
				headwindKt: endHeadwind(icao, end),
				longEnough: endLongEnough(icao, phase, end),
			})),
		);
	}

	/** Conditions for the cell's resolved runway end (the nomogram path). */
	function cellConditions(icao: string, phase: PerfPhase): PerfConditions | null {
		return conditionsForEnd(icao, phase, resolveEnd(icao, phase));
	}

	function buildCell(icao: string, phase: PerfPhase): Cell {
		const airport = airportByIdent(icao);
		const inputs = perfFor(icao);
		const block = inputs[phase];
		const ends = airport ? runwayEnds(airport) : [];
		const end = resolveEnd(icao, phase);
		const elevFt = airport?.elevFt ?? null;
		const paFt = elevFt == null ? null : pressureAltitudeFt(elevFt, effectiveQnh(icao, inputs));
		const isaC = paFt == null ? null : isaTemperatureC(paFt);
		const grass = end?.grass ?? false;
		const dd = end?.distances ?? NO_DD;
		const rows: CellRow[] = [];
		let verdictResult: PerfResult | null = null;
		const conditions = perf ? conditionsForEnd(icao, phase, end) : null;
		if (perf && conditions) {
			if (perf.kind === 'table') {
				const result = computeTablePerformance(perf, phase, conditions);
				rows.push({ config: null, result });
				verdictResult = result;
			} else {
				const def = verdictConfig(perf, phase);
				for (const config of perf.configs.filter((c) => c.phase === phase)) {
					const result = computeClosedFormPerformance(perf, config, conditions);
					rows.push({ config, result });
					if (config === def) {
						verdictResult = result;
					}
				}
			}
		}
		const factored =
			verdictResult && verdictResult.ok
				? {
						groundRollM: verdictResult.value.groundRoll.factoredM,
						distance15mM: verdictResult.value.distance15m.factoredM,
					}
				: null;
		const live = liveMetar(icao);
		const mq = live ? qnhFromMetar(live.metar) : null;
		const mt = live?.metar.temp ?? null;
		const mw = metarWind(icao, end);
		const hint = t.flightprep.typeToOverrideHint;

		const qnhAuto = Math.round(mq ?? flightPrep.dossier.qnhHpa ?? 1013);
		const qnh: WeatherField = {
			override: inputs.qnhHpa,
			auto: qnhAuto,
			source: fieldSource(mq != null),
			title:
				(mq != null && live
					? t.flightprep.qnhMetarTip({ qnh: mq, prov: provenance(icao, live) })
					: flightPrep.dossier.qnhHpa != null
						? t.flightprep.qnhDossierTip(qnhAuto)
						: t.flightprep.qnhStandardTip(qnhAuto)) + hint,
			label: t.flightprep.ariaPerfCell({ row: 'QNH (hPa)', icao }),
			min: 900,
			max: 1100,
			set: (v) => setPerfQnh(icao, v),
		};

		const tempAuto = Math.round(mt ?? isaC ?? 15);
		const temp: WeatherField = {
			override: block.tempC,
			auto: tempAuto,
			source: fieldSource(mt != null),
			title:
				(mt != null && live
					? t.flightprep.tempMetarTip({ temp: mt, prov: provenance(icao, live) })
					: t.flightprep.tempIsaTip(tempAuto)) + hint,
			label: t.flightprep.ariaPerfCell({ row: t.flightprep.temperatureC, icao }),
			min: undefined,
			max: undefined,
			set: (v) => setPerfBlock(icao, phase, { tempC: v }),
		};

		// Typing either wind component makes the pair explicit (METAR ignored for
		// the phase), so the other component's automatic value is a derived calm,
		// shown neutral rather than as a missing-METAR estimate.
		const headExplicit = block.tailwindKt != null;
		const tailExplicit = block.headwindKt != null;
		const headwind: WeatherField = {
			override: block.headwindKt,
			auto: headExplicit ? 0 : (mw?.headwindKt ?? 0),
			source: headExplicit ? 'neutral' : fieldSource(mw != null),
			title:
				(headExplicit
					? t.flightprep.headwindZeroTip
					: mw && live
						? t.flightprep.headwindMetarTip({ kt: mw.headwindKt, prov: provenance(icao, live) })
						: t.flightprep.headwindCalmTip) + hint,
			label: t.flightprep.ariaPerfCell({ row: t.flightprep.headwindKt, icao }),
			min: 0,
			max: undefined,
			set: (v) => setPerfBlock(icao, phase, { headwindKt: v }),
		};
		const tailwind: WeatherField = {
			override: block.tailwindKt,
			auto: tailExplicit ? 0 : (mw?.tailwindKt ?? 0),
			source: tailExplicit ? 'neutral' : fieldSource(mw != null),
			title:
				(tailExplicit
					? t.flightprep.tailwindZeroTip
					: mw && live
						? t.flightprep.tailwindMetarTip({ kt: mw.tailwindKt, prov: provenance(icao, live) })
						: t.flightprep.tailwindCalmTip) + hint,
			label: t.flightprep.ariaPerfCell({ row: t.flightprep.tailwindKt, icao }),
			min: 0,
			max: undefined,
			set: (v) => setPerfBlock(icao, phase, { tailwindKt: v }),
		};

		return {
			icao,
			airport,
			manual: flightPrep.perf.manualIcaos.includes(icao),
			block,
			ends,
			end,
			elevFt,
			paFt,
			grass,
			rows,
			dd,
			takeoffV: phase === 'takeoff' && factored ? takeoffVerdict(factored, dd) : null,
			landingV:
				phase === 'landing' && factored
					? landingVerdict(factored.distance15mM, dd, perf?.flaplessLandingFactor ?? null)
					: null,
			qnh,
			temp,
			headwind,
			tailwind,
		};
	}

	/** The configs giving the distance row groups; [null] for the table kind. */
	function rowConfigs(phase: PerfPhase): (ClosedFormConfig | null)[] {
		if (!perf) {
			return [];
		}
		return perf.kind === 'table' ? [null] : perf.configs.filter((c) => c.phase === phase);
	}

	function numOrNull(e: Event): number | null {
		const v = Number.parseFloat((e.target as HTMLInputElement).value);
		return Number.isFinite(v) ? v : null;
	}

	/** The ok-branch value, or null; keeps the template free of narrowing. */
	function okValue(row: CellRow | undefined): PerfComputation | null {
		return row && row.result.ok ? row.result.value : null;
	}

	function flagged(result: PerfResult): boolean {
		return (
			result.ok &&
			(result.value.flags.massExtrapolated ||
				result.value.flags.altitudeExtrapolatedBelow ||
				result.value.flags.temperatureExtrapolated)
		);
	}

	function flagTitle(result: PerfResult): string | undefined {
		if (!result.ok) {
			return undefined;
		}
		const f = result.value.flags;
		const parts = [
			f.massExtrapolated ? t.flightprep.flagMass : null,
			f.altitudeExtrapolatedBelow ? t.flightprep.flagAltitude : null,
			f.temperatureExtrapolated ? t.flightprep.flagTemp : null,
		].filter(Boolean);
		return parts.length ? t.flightprep.extrapolatedTip(parts.join(', ')) : undefined;
	}

	function rowLabel(metric: 'roll' | 'd15', config: ClosedFormConfig | null): string {
		const base = metric === 'roll' ? t.flightprep.groundRoll : t.flightprep.over15m;
		return config ? `${base}${t.aircraft.flapsSuffix(config.flapsDeg)}` : base;
	}

	/** Factors as percentages: x1.3 reads "+30%". */
	const marginPct = $derived(perf ? Math.round((perf.marginFactor - 1) * 100) : 0);
	const grassPct = $derived(perf ? Math.round((perf.grassFactor - 1) * 100) : 0);
	const wetPct = $derived(perf ? Math.round((perf.wetFactor - 1) * 100) : 0);
	const flaplessPct = $derived(
		perf?.flaplessLandingFactor ? Math.round((perf.flaplessLandingFactor - 1) * 100) : null,
	);

	function fmtDist(m: number): string {
		return String(Math.round(m));
	}

	function fmtDd(m: number | null): string {
		return m == null ? '—' : String(Math.round(m));
	}

	/** Whether a declared-distance cell shows a value assumed from the
	 *  physical runway length (the dataset publishes none); tinted with the
	 *  extrapolation orange, anti-conservative for LDA / TORA. */
	function ddAssumed(cell: Cell, key: keyof AssumedDistances): boolean {
		return cell.dd.assumed?.[key] ?? false;
	}

	/** Whether the phase's runway verdict consumed an assumed distance
	 *  (takeoff reads TORA + TODA, landing the LDA). */
	function verdictAssumed(cell: Cell, phase: PerfPhase): boolean {
		const a = cell.dd.assumed;
		if (!a) {
			return false;
		}
		return phase === 'takeoff' ? a.tora || a.toda : a.lda;
	}

	/** Hover detail for a runway end: surface + length (the option text shows
	 *  only the QFU). The surface word goes through the catalog with the
	 *  AirportDetail widened-lookup pattern (open dataset field, canonical
	 *  English label as the fallback). */
	function endTitle(end: RunwayEnd): string {
		const s = formatSurface(end.surface);
		const parts = [
			(t.data.surfaces as Record<string, string>)[s.toLowerCase()] || s || end.surface || null,
		];
		if (end.lengthM != null) {
			parts.push(`${Math.round(end.lengthM)} m`);
		}
		return parts.filter(Boolean).join(', ');
	}

	/** The runway select's tooltip: the end's surface + length, plus a note when
	 *  the choice is the automatic into-wind default (no explicit pick yet). */
	function rwyTitle(cell: Cell): string | undefined {
		if (!cell.end) {
			return undefined;
		}
		const base = endTitle(cell.end);
		if (cell.block.runwayEnd != null) {
			return base || undefined;
		}
		const auto = t.flightprep.rwyAutoTip;
		return base ? `${base} (${auto})` : auto;
	}

	/** Absolute table temperature at a row (the sheet prints -5 / 15 / 35). */
	function tableTempC(altFt: number, isaOffsetC: number): number {
		return 15 - (2 * altFt) / 1000 + isaOffsetC;
	}

	const tablePerf = $derived(perf?.kind === 'table' ? perf : null);
	const closedPerf = $derived(perf?.kind === 'closed-form' ? perf : null);

	// Nomogram selections: config (chart), metric, and whose conditions draw
	// the reading path. Defaults: the takeoff verdict config, over 15 m, the
	// first aerodrome; effective values fall back when the selection vanishes.
	let chartConfigIdx = $state(-1);
	let chartMetric = $state<NomogramMetric>('distance15m');
	let chartIcao = $state('');
	const chartConfig = $derived.by(() => {
		if (!closedPerf) {
			return null;
		}
		return (
			closedPerf.configs[chartConfigIdx] ??
			verdictConfig(closedPerf, 'takeoff') ??
			closedPerf.configs[0] ??
			null
		);
	});
	const chartPathIcao = $derived(icaos.includes(chartIcao) ? chartIcao : (icaos[0] ?? null));
	const chartConditions = $derived(
		chartConfig && chartPathIcao ? cellConditions(chartPathIcao, chartConfig.phase) : null,
	);

	function configLabel(c: ClosedFormConfig): string {
		return t.aircraft.phaseFlaps({
			phase: c.phase === 'takeoff' ? t.flightprep.takeoff : t.flightprep.landing,
			flaps: c.flapsDeg,
		});
	}

	/** The closed-form notes in the sheet's multiplier shape: the verdict
	 *  config's over-15 m per-knot rates evaluated at the sheet's anchor
	 *  winds, plus its tailwind as a percent per 2 kt. */
	function closedWindNote(
		phase: PerfPhase,
	): { factors: [number, number][]; tailPctPer2Kt: number } | null {
		if (!closedPerf) {
			return null;
		}
		const cfg = verdictConfig(closedPerf, phase);
		if (!cfg) {
			return null;
		}
		const m = cfg.distance15m;
		return {
			factors: [10, 20, 30].map((kt) => [kt, Math.max(0, 1 - m.headwindPerKt * kt)]),
			tailPctPer2Kt: Math.round(m.tailwindPerKt * 2000) / 10,
		};
	}

	const closedNoteTakeoff = $derived(closedWindNote('takeoff'));
	const closedNoteLanding = $derived(closedWindNote('landing'));

</script>

{#snippet windNote(label: string, hint: string, factors: ReadonlyArray<readonly [number, number]>)}
	<div class="wind-note" title={hint}>
		<span>{label}</span>
		<span class="wind-lines">
			{#each factors as [kt, f] (kt)}
				<span>{t.flightprep.windMultiplyBy({ kt, factor: f.toFixed(2) })}</span>
			{/each}
		</span>
	</div>
{/snippet}

<!-- One performance weather input: an empty box whose gray (amber when no live
     METAR) placeholder shows the automatic value, filling solid only when typed;
     clearing reverts to the automatic value. The print-value span carries the
     effective number into print, where the empty input (and its placeholder)
     would otherwise show blank. -->
{#snippet weatherField(f: WeatherField)}
	<input
		class="num"
		class:no-live={f.source === 'estimate'}
		type="number"
		min={f.min}
		max={f.max}
		step="1"
		value={f.override ?? ''}
		placeholder={String(f.auto)}
		aria-label={f.label}
		title={f.title}
		oninput={(e) => f.set(numOrNull(e))}
	/><span class="print-value" class:no-live={f.override == null && f.source === 'estimate'}
		>{f.override ?? f.auto}</span
	>
{/snippet}

<div class="page fp-page">
	{#if !aircraft}
		<p class="muted">{t.flightprep.selectForPerf}</p>
	{:else if !perf}
		<p class="muted">
			{t.flightprep.noPerfSheet(aircraft.identity.registration ?? aircraft.identity.type)}
		</p>
	{:else}
		{#if tablePerf}
			<details class="poh">
				<summary>
					{t.flightprep.pohDistances({
						type: aircraft.identity.type,
						max: tablePerf.massMaxKg,
						min: tablePerf.massMinKg,
					})}
				</summary>
				<div class="poh-tables">
					{#each PHASES as phase (phase)}
						{@const tbl = tablePerf[phase]}
						<table class="perf-table poh-table">
							<caption>{phase === 'takeoff' ? t.flightprep.takeoff : t.flightprep.landing} (m)</caption>
							<thead>
								<tr>
									<th>{t.flightprep.altFt}</th>
									<th>T (°C)</th>
									<th>{t.flightprep.rollMass(tablePerf.massMaxKg)}</th>
									<th>15 m {tablePerf.massMaxKg}</th>
									<th>{t.flightprep.rollMass(tablePerf.massMinKg)}</th>
									<th>15 m {tablePerf.massMinKg}</th>
								</tr>
							</thead>
							<tbody>
								{#each tbl.rows as row (row.altFt + '|' + row.isaOffsetC)}
									<tr>
										<td>{row.isaOffsetC === tbl.isaOffsetsC[0] ? row.altFt : ''}</td>
										<td>{tableTempC(row.altFt, row.isaOffsetC)}{row.isaOffsetC === 0 ? ' (ISA)' : ''}</td>
										<td>{row.massMax[0]}</td>
										<td>{row.massMax[1]}</td>
										<td>{row.massMin[0]}</td>
										<td>{row.massMin[1]}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					{/each}
				</div>
				<!-- The workbook's notes under the POH tables: per-phase
				     headwind multipliers one line per anchor, the takeoff side
				     then carrying the tailwind / grass / wet corrections and
				     the landing side the flapless one. -->
				<div class="legend muted">
					<div class="legend-col">
						{@render windNote(
							t.flightprep.headwindInfluenceTakeoff,
							t.flightprep.anchorsInterpTip,
							tablePerf.wind.takeoffHeadwind.slice(1),
						)}
						<p>{t.flightprep.tailwindInfluence(tablePerf.wind.tailwindPctPer2Kt)}</p>
						<p title={t.flightprep.unpavedTip}>{t.flightprep.grassCorrection(grassPct)}</p>
						<p>{t.flightprep.wetCorrection(wetPct)}</p>
					</div>
					<div class="legend-col">
						{@render windNote(
							t.flightprep.headwindInfluenceLanding,
							t.flightprep.anchorsInterpTip,
							tablePerf.wind.landingHeadwind.slice(1),
						)}
						{#if flaplessPct != null}
							<p>{t.flightprep.flaplessCorrection(flaplessPct)}</p>
						{/if}
					</div>
				</div>
			</details>
		{:else if closedPerf && chartConfig}
			<details class="poh charts">
				<summary>
					{t.flightprep.pohCharts({ type: aircraft.identity.type, lb: closedPerf.massReferenceLb })}
				</summary>
				<div class="chart-controls no-print">
					<div class="chips" role="group" aria-label={t.flightprep.chartAria}>
						{#each closedPerf.configs as c, i (configLabel(c))}
							<button class="chip" class:on={c === chartConfig} onclick={() => (chartConfigIdx = i)}>
								{configLabel(c)}
							</button>
						{/each}
					</div>
					<div class="chips" role="group" aria-label={t.flightprep.metricAria}>
						<button
							class="chip"
							class:on={chartMetric === 'distance15m'}
							onclick={() => (chartMetric = 'distance15m')}
						>
							{t.flightprep.over15m}
						</button>
						<button
							class="chip"
							class:on={chartMetric === 'groundRoll'}
							onclick={() => (chartMetric = 'groundRoll')}
						>
							{t.flightprep.groundRoll}
						</button>
					</div>
					{#if icaos.length > 1}
						<div class="chips" role="group" aria-label={t.flightprep.pathAerodromeAria}>
							{#each icaos as icao (icao)}
								<button class="chip" class:on={icao === chartPathIcao} onclick={() => (chartIcao = icao)}>
									{icao}
								</button>
							{/each}
						</div>
					{/if}
				</div>
				<PerfNomogram
					perf={closedPerf}
					config={chartConfig}
					metric={chartMetric}
					conditions={chartConditions}
				/>
				<!-- The sheet's notes shape, from the fits: the verdict
				     config's continuous per-knot rates shown as the anchor
				     multipliers and a percent per 2 kt. -->
				<div class="legend muted">
					<div class="legend-col">
						{#if closedNoteTakeoff}
							{@render windNote(
								t.flightprep.headwindInfluenceTakeoff,
								t.flightprep.fittedRateTakeoffTip,
								closedNoteTakeoff.factors,
							)}
							<p>{t.flightprep.tailwindInfluence(closedNoteTakeoff.tailPctPer2Kt)}</p>
						{/if}
						<p title={t.flightprep.unpavedTip}>{t.flightprep.grassCorrection(grassPct)}</p>
						<p>{t.flightprep.wetCorrection(wetPct)}</p>
					</div>
					<div class="legend-col">
						{#if closedNoteLanding}
							{@render windNote(
								t.flightprep.headwindInfluenceLanding,
								t.flightprep.fittedRateLandingTip,
								closedNoteLanding.factors,
							)}
							<p>{t.flightprep.tailwindInfluence(closedNoteLanding.tailPctPer2Kt)}</p>
						{/if}
						{#if flaplessPct != null}
							<p>{t.flightprep.flaplessCorrection(flaplessPct)}</p>
						{/if}
					</div>
				</div>
			</details>
		{/if}

		{#if icaos.length === 0}
			<p class="muted">{t.flightprep.planRoutesGrid}</p>
		{/if}

		{#if icaos.length > 0}
			<!-- Live-weather strip: where each aerodrome's defaults come from.
			     QNH / temperature / wind below follow these values until typed
			     over; the raw METAR is the hover title. It PRINTS, the buttons
			     beside it do not: a sheet whose numbers may be an observation or
			     may be ISA has to say which one, and the printed meteo annex
			     stamps its own source the same way. -->
			<div class="wx-strip">
				<div class="wx-rows">
					<p class="wx-print-head">{t.flightprep.wxUsedHeading}</p>
					{#if display.liveWeather}
						{#each icaos as icao (icao)}
							{@const line = wxLine(icao)}
							<div class="wx-row" class:stale={line.stale} title={line.title}>{line.text}</div>
						{/each}
					{:else}
						<div class="wx-row stale">{t.flightprep.wxLiveOffNote}</div>
					{/if}
				</div>
				{#if display.liveWeather}
					<div class="wx-actions no-print">
						<button
							class="btn"
							onclick={resetPerfWeather}
							disabled={!hasWeatherOverrides}
							title={t.flightprep.resetLiveWxTip}
						>
							{t.flightprep.resetLiveWx}
						</button>
						<button class="btn" onclick={refreshWeather} title={t.flightprep.refreshAllTip}>
							{t.weather.refresh}
						</button>
					</div>
				{/if}
			</div>
			{#if display.liveWeather}
				<p class="wx-legend no-print">{t.flightprep.wxLegend}</p>
			{/if}
		{/if}

		{#each PHASES as phase (phase)}
			{@const cells = icaos.map((i) => buildCell(i, phase))}
			{@const configs = rowConfigs(phase)}
			{#if cells.length > 0}
				<section class="phase">
					<h3>{phase === 'takeoff' ? t.flightprep.takeoffPerfHeading : t.flightprep.landingPerfHeading}</h3>
					<div class="grid-wrap">
						<table class="perf-table grid" style:--cols={cells.length}>
							<thead>
								<tr>
									<th class="rowhead"></th>
									{#each cells as cell (cell.icao)}
										<th id="{uid}-col-{phase}-{cell.icao}">
											{cell.icao}
											{#if cell.manual && phase === 'takeoff'}
												<button
													class="remove no-print"
													title={t.flightprep.removeAerodromeTip}
													aria-label={t.flightprep.removeIcaoAria(cell.icao)}
													onclick={() => removeManualAerodrome(cell.icao)}>×</button
												>
											{/if}
										</th>
									{/each}
								</tr>
							</thead>
							<tbody>
								<!-- The sheet's Masse row: one shared value, repeated
								     per column like the print. -->
								<tr>
									<th
										class="rowhead"
										title={mb ? t.flightprep.massRowTipMb : t.flightprep.massRowTipMax}
									>
										{t.flightprep.massKg}
									</th>
									{#each cells as cell (cell.icao)}
										<td>{massKg != null ? Math.round(massKg) : '—'}</td>
									{/each}
								</tr>
								<tr>
									<th class="rowhead">{t.flightprep.elevationFt}</th>
									{#each cells as cell (cell.icao)}
										<td>{cell.elevFt ?? '—'}</td>
									{/each}
								</tr>
								<tr>
									<th class="rowhead">QNH (hPa)</th>
									{#each cells as cell (cell.icao)}
										<td>{@render weatherField(cell.qnh)}</td>
									{/each}
								</tr>
								<tr>
									<th class="rowhead">{t.flightprep.pressureAltFt}</th>
									{#each cells as cell (cell.icao)}
										<td>{cell.paFt != null ? Math.round(cell.paFt) : '—'}</td>
									{/each}
								</tr>
								<tr>
									<th class="rowhead">{t.flightprep.temperatureC}</th>
									{#each cells as cell (cell.icao)}
										<td>{@render weatherField(cell.temp)}</td>
									{/each}
								</tr>
								<tr>
									<th class="rowhead" title={t.flightprep.headwindRowTip}>{t.flightprep.headwindKt}</th>
									{#each cells as cell (cell.icao)}
										<td>{@render weatherField(cell.headwind)}</td>
									{/each}
								</tr>
								<tr>
									<th class="rowhead" title={t.flightprep.tailwindRowTip}>{t.flightprep.tailwindKt}</th>
									{#each cells as cell (cell.icao)}
										<td>{@render weatherField(cell.tailwind)}</td>
									{/each}
								</tr>
								<tr>
									<th class="rowhead">{t.flightprep.runwayQfu}</th>
									{#each cells as cell (cell.icao)}
										<td>
											{#if cell.ends.length > 0}
												<select
													class="rwy"
													value={cell.end?.id ?? ''}
													use:printValue={cell.end?.id ?? ''}
													aria-label={t.flightprep.ariaPerfCell({
														row: t.flightprep.runwayQfu,
														icao: cell.icao,
													})}
													title={rwyTitle(cell)}
													onchange={(e) =>
														setPerfBlock(cell.icao, phase, {
															runwayEnd: (e.target as HTMLSelectElement).value || null,
														})}
												>
													{#each cell.ends as end (end.id)}
														<option value={end.id}>{end.id}</option>
													{/each}
												</select>
											{:else}—{/if}
										</td>
									{/each}
								</tr>
								<!-- Distances assumed from the physical runway length (nothing
								     published) tint with the extrapolation orange. -->
								{#if phase === 'takeoff'}
									<tr>
										<th class="rowhead" title={t.flightprep.toraTip}>TORA (m)</th>
										{#each cells as cell (cell.icao)}
											<td
												class:warn={ddAssumed(cell, 'tora')}
												title={ddAssumed(cell, 'tora') ? t.flightprep.assumedDistanceTip : undefined}
											>
												{fmtDd(cell.dd.toraM)}
											</td>
										{/each}
									</tr>
									<tr>
										<th class="rowhead" title={t.flightprep.todaTip}>TODA (m)</th>
										{#each cells as cell (cell.icao)}
											<td
												class:warn={ddAssumed(cell, 'toda')}
												title={ddAssumed(cell, 'toda') ? t.flightprep.assumedDistanceTip : undefined}
											>
												{fmtDd(cell.dd.todaM)}
											</td>
										{/each}
									</tr>
								{:else}
									<tr>
										<th class="rowhead" title={t.flightprep.ldaTip}>LDA (m)</th>
										{#each cells as cell (cell.icao)}
											<td
												class:warn={ddAssumed(cell, 'lda')}
												title={ddAssumed(cell, 'lda') ? t.flightprep.assumedDistanceTip : undefined}
											>
												{fmtDd(cell.dd.ldaM)}
											</td>
										{/each}
									</tr>
								{/if}
								<tr>
									<th class="rowhead">{t.flightprep.grass}</th>
									{#each cells as cell (cell.icao)}
										<td>{cell.grass ? t.flightprep.yesLower : t.flightprep.noLower}</td>
									{/each}
								</tr>
								<tr>
									<th class="rowhead" id="{uid}-wet-{phase}">{t.flightprep.wet}</th>
									{#each cells as cell (cell.icao)}
										<td>
											<!-- Named by the existing headers (column ICAO + the
											     Wet row label): a bare checkbox in a td has no
											     accessible name of its own. -->
											<input
												type="checkbox"
												checked={cell.block.wet}
												use:printValue={cell.block.wet}
												aria-labelledby="{uid}-col-{phase}-{cell.icao} {uid}-wet-{phase}"
												onchange={(e) =>
													setPerfBlock(cell.icao, phase, {
														wet: (e.target as HTMLInputElement).checked,
													})}
											/>
										</td>
									{/each}
								</tr>

								<!-- Key composed with the position: nothing forbids two
								     same-phase configs sharing a flaps setting. -->
								{#each configs as config, ci (`${config?.flapsDeg ?? 'table'}#${ci}`)}
									<!-- The first computed row opens the results block: a strong
									     rule separates it from the conditions above. -->
									<tr class="dist" class:section={ci === 0}>
										<th class="rowhead">{rowLabel('d15', config)}</th>
										{#each cells as cell (cell.icao)}
											{@const row = cell.rows[ci]}
											{@const v = okValue(row)}
											{#if !row}
												<td>—</td>
											{:else if v}
												<td class:warn={flagged(row.result)} title={flagTitle(row.result)}>
													{fmtDist(v.distance15m.factoredM)}
												</td>
											{:else if !row.result.ok}
												<td class="danger" title={t.flightprep.paAboveTip}>
													PA &gt; {row.result.maxAltFt} ft
												</td>
											{/if}
										{/each}
									</tr>
									<tr class="margin">
										<th class="rowhead" title={t.flightprep.marginRowTip(perf.marginFactor)}>+{marginPct}%</th>
										{#each cells as cell (cell.icao)}
											{@const v = okValue(cell.rows[ci])}
											<td>{v ? fmtDist(v.distance15m.withMarginM) : ''}</td>
										{/each}
									</tr>
									<tr class="dist">
										<th class="rowhead">{rowLabel('roll', config)}</th>
										{#each cells as cell (cell.icao)}
											{@const row = cell.rows[ci]}
											{@const v = okValue(row)}
											{#if !row}
												<td>—</td>
											{:else if v}
												<td class:warn={flagged(row.result)} title={flagTitle(row.result)}>
													{fmtDist(v.groundRoll.factoredM)}
												</td>
											{:else if !row.result.ok}
												<td class="danger">PA &gt; {row.result.maxAltFt} ft</td>
											{/if}
										{/each}
									</tr>
									<tr class="margin">
										<th class="rowhead" title={t.flightprep.marginRowTip(perf.marginFactor)}>+{marginPct}%</th>
										{#each cells as cell (cell.icao)}
											{@const v = okValue(cell.rows[ci])}
											<td>{v ? fmtDist(v.groundRoll.withMarginM) : ''}</td>
										{/each}
									</tr>
								{/each}

								<!-- A verdict that consumed an assumed declared distance keeps
								     its yes/no but tints orange (.warn wins over .ok / .danger
								     by stylesheet order, on purpose). -->
								<tr class="verdict">
									<th class="rowhead">{t.flightprep.runwayLimiting}</th>
									{#each cells as cell (cell.icao)}
										{@const limiting =
											phase === 'takeoff' ? cell.takeoffV?.limiting : cell.landingV?.ldaLimiting}
										{@const assumed = limiting != null && verdictAssumed(cell, phase)}
										<td
											class={limiting === true ? 'danger' : limiting === false ? 'ok' : ''}
											class:warn={assumed}
											title={assumed ? t.flightprep.assumedVerdictTip : undefined}
										>
											{limiting == null ? '—' : limiting ? t.flightprep.yesCaps : t.flightprep.no}
										</td>
									{/each}
								</tr>
								{#if phase === 'landing' && perf.flaplessLandingFactor}
									<tr class="verdict">
										<th
											class="rowhead"
											title={t.flightprep.flaplessFeasibleTip(perf.flaplessLandingFactor)}
										>
											{t.flightprep.flaplessFeasible}
										</th>
										{#each cells as cell (cell.icao)}
											{@const f = cell.landingV?.flaplessFeasible}
											{@const assumed = f != null && ddAssumed(cell, 'lda')}
											<td
												class={f === false ? 'danger' : f === true ? 'ok' : ''}
												class:warn={assumed}
												title={assumed ? t.flightprep.assumedVerdictTip : undefined}
											>
												{f == null ? '—' : f ? t.flightprep.yes : t.flightprep.noCaps}
											</td>
										{/each}
									</tr>
								{/if}
							</tbody>
						</table>
					</div>
				</section>
			{/if}
		{/each}

		<div class="add no-print">
			<input
				class="icao"
				type="text"
				autocapitalize="characters"
				spellcheck="false"
				enterkeyhint="done"
				placeholder="ICAO"
				maxlength="4"
				bind:value={newIcao}
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						addAerodrome();
					}
				}}
			/>
			<button class="btn" onclick={addAerodrome}>{t.flightprep.addAerodrome}</button>
			{#if addErrorIcao}
				<span class="danger">{t.flightprep.unknownIdent(addErrorIcao)}</span>
			{/if}
		</div>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 12px;

		/* The shared workbook .num (styles/workbook.css) at this page's
		   column width; .muted and the verdict inks ride the same file. */
		--num-w: 76px;
	}

	/* The workbook's two notes blocks (takeoff side, landing side), printed
	   under the POH tables inside the fold. */
	.legend {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 4px 32px;
		max-width: 880px;
		margin-top: 10px;
		font-size: 12px;
		line-height: 1.55;
	}

	/* Against the surface box, not the window: see DossierPage's .cols. */
	@container (width <= 720px) {
		.legend {
			grid-template-columns: 1fr;
		}
	}

	.legend p {
		margin: 0;
	}

	.wind-note {
		display: grid;
		grid-template-columns: auto auto;
		justify-content: start;
		gap: 0 20px;
	}

	.wind-lines {
		display: flex;
		flex-direction: column;
	}

	.poh summary {
		cursor: pointer;
		font-size: 13px;
		font-weight: 600;
	}

	.poh-tables {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
		margin-top: 8px;
	}

	.chart-controls {
		display: flex;
		gap: 14px;
		flex-wrap: wrap;
		margin: 8px 0 2px;
	}

	.chips {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}

	.chip {
		font-size: 11px;
		padding: 2px 8px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text-muted);
		cursor: pointer;
	}

	.chip.on {
		border-color: var(--accent);
		color: var(--accent);
		font-weight: 600;
	}

	.poh-table caption {
		font-size: 12px;
		font-weight: 600;
		text-align: left;
		padding-bottom: 4px;
	}

	.phase h3 {
		margin: 0 0 6px;
		font-size: 13px;
	}

	.grid-wrap {
		overflow-x: auto;
	}

	/* Document-style table: strong outer frame + strong legend rules, light
	   inner grid, tabular figures (see FuelPlanPage). */
	.perf-table {
		border-collapse: collapse;
		border: 2px solid var(--border-strong);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}

	.perf-table th,
	.perf-table td {
		border: 1px solid var(--border);
		padding: 2px 7px;
		text-align: right;
		white-space: nowrap;
	}

	.perf-table thead th {
		background: var(--surface-2);
		font-weight: 600;
		border-bottom: 2px solid var(--border-strong);
	}

	.perf-table .rowhead {
		text-align: left;
		font-weight: 500;
		background: var(--surface-2);
		border-right: 2px solid var(--border-strong);
	}

	/* The aerodrome grids: fixed layout so every aerodrome column is the same
	   width (the row-head column is pinned; the rest split evenly, capped at
	   170px per aerodrome). Inputs and selects fill their column uniformly. */
	.perf-table.grid {
		table-layout: fixed;
		width: 100%;
		max-width: calc(200px + var(--cols, 4) * 170px);
	}

	.perf-table.grid thead .rowhead {
		width: 200px;
	}

	.perf-table.grid .rowhead {
		white-space: normal;
	}

	.perf-table.grid .num,
	.perf-table.grid .rwy {
		width: 100%;
		box-sizing: border-box;
	}

	tr.dist td {
		font-weight: 600;
	}

	tr.section th,
	tr.section td {
		border-top: 2px solid var(--border-strong);
	}

	tr.margin td,
	tr.margin .rowhead {
		color: var(--text-muted);
	}

	tr.verdict td {
		font-weight: 700;
	}

	/* Automatic (not typed) fields show an empty box whose placeholder is the
	   live-weather value, muted by the shared workbook rule; amber instead when
	   there is no usable METAR, so the value is only an estimate. Typed values
	   fill solid in --text. */
	.num.no-live::placeholder {
		color: var(--no-live-data);
	}


	/* The strip's printed heading; the screen has the legend below instead. */
	.wx-print-head {
		display: none;
	}

	/* The live-weather strip: one provenance line per aerodrome. */
	.wx-strip {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.wx-rows {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.wx-row.stale {
		color: var(--airspace-activity);
	}

	.wx-actions {
		display: flex;
		flex-direction: column;
		gap: 6px;
		flex: none;
	}

	.wx-legend {
		margin: 0;
		font-size: 11px;
		color: var(--text-muted);
	}

	.rwy {
		font: inherit;
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 1px 2px;
	}

	.remove {
		background: transparent;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 13px;
		padding: 0 2px;
	}

	.remove:hover {
		color: var(--danger);
	}

	.add {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.icao {
		width: 72px;
		text-transform: uppercase;
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 3px 6px;
		font: inherit;
	}

	/* The verdict inks (.ok / .danger / .warn, the extrapolation orange
	   flagging assumed declared distances too) ride the shared workbook
	   rules (styles/workbook.css), .warn last there so it still wins when
	   the classes combine on a verdict cell. */

	@media print {
		.grid-wrap {
			overflow: visible;
		}

		/* The provenance strip prints (its buttons carry their own no-print):
		   two columns of small lines above the grids, so the sheet says which
		   of its numbers came from an observation and which are estimates. */
		.wx-strip {
			font-size: 9px;
			break-inside: avoid;
		}

		.wx-rows {
			display: block;
			columns: 2;
			column-gap: 8mm;
		}

		.wx-print-head {
			display: block;
			margin: 0 0 2px;
			font-weight: 600;
			column-span: all;
		}

		/* An estimated line takes the page's own no-live amber, the ink the
		   estimated cells below it carry (theme.css keeps it distinct from the
		   workbook orange, which means an extrapolated POH value). */
		.wx-row.stale {
			color: var(--no-live-data);
		}

		.print-value.no-live {
			color: var(--no-live-data);
		}


		/* An open POH fold (reference tables or charts, with its notes) gets
		   its own landscape sheet, whole, ahead of the grid; the content is
		   sized below so the worst case (nomogram + notes) stays inside one
		   A4 landscape page. */
		.poh[open] {
			break-after: page;
			break-inside: avoid;
		}

		/* The sheet after that forced break starts at the paper edge (the
		   page margin is zeroed, the body padding wraps only the whole
		   flow): the grid sections opening it carry their own top PADDING,
		   both of them since they share the flex row. Padding, not margin:
		   margins at a page boundary are discarded by some engines (Gecko)
		   even after a forced break, padding never is. */
		.poh[open] ~ .phase {
			padding-top: 12mm;
		}

		/* With the strip printing it is the element opening that sheet, so the
		   12mm is its; the phases must then not add their own (higher
		   specificity, so the order of these two blocks does not matter). */
		.poh[open] ~ .wx-strip {
			padding-top: 12mm;
		}

		.poh[open] ~ .wx-strip ~ .phase {
			padding-top: 0;
		}

		.poh .legend {
			font-size: 10px;
			line-height: 1.4;
			margin-top: 6px;
		}

		/* Landscape sheet: takeoff and landing ALWAYS side by side, half the
		   width each; the fixed-layout grids shrink their columns to fit
		   (smaller type + padding buy the room). Everything else spans the
		   full width. */
		.page {
			flex-direction: row;
			flex-wrap: wrap;
			gap: 6mm 8mm;
			align-items: flex-start;
		}

		.page > :not(.phase) {
			flex: 1 1 100%;
		}

		.phase {
			flex: 1 1 0;
			min-width: 0;
			break-inside: avoid;
		}

		.perf-table {
			font-size: 10px;
		}

		.perf-table th,
		.perf-table td {
			padding: 2px 4px;
		}

		.perf-table.grid {
			max-width: none;
		}

		.perf-table.grid thead .rowhead {
			width: 110px;
		}
	}
</style>
