<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	/* Runway performance: the POH reference table (table-kind aircraft) and a
	 * takeoff + landing grid, one column per aerodrome the flight touches
	 * (trip endpoints + alternates, plus manual adds). Inputs per column:
	 * QNH (defaulting to the dossier's Météo QNH, then standard), temperature
	 * (defaults to ISA at the pressure altitude), headwind / tailwind, wet,
	 * and the runway END (QFU), whose per-direction declared distances each
	 * flap block is judged against, yes or no, WITH the safety margin
	 * (aircraft/performance.ts takeoffVerdict / landingVerdict), plus the
	 * take-off procedure the runway calls for and the flapless-landing
	 * feasibility. The required distances (with the margin) are the bold rows,
	 * the flight manual's own figures muted above them. Extrapolated POH values
	 * tint orange like the workbook; so do declared distances assumed from the
	 * physical runway length (dataset publishes none) and the verdicts that
	 * consumed one. */

	import { routes } from '$lib/state/route.svelte';
	import { airportByIdent } from '$lib/state/data.svelte';
	import { selectedAircraft } from '$lib/state/aircraft.svelte';
	import {
		flightPrep,
		perfFor,
		setDossier,
		setPerfBlock,
		resetPerfWeather,
		addManualAerodrome,
		removeManualAerodrome,
		type PerfBlockInputs,
	} from '$lib/state/flightPrep.svelte';
	import { orderedTrips } from '$lib/aircraft/trips';
	import { perfIcaos, pickedRunwayEnd, type RunwayEnd } from '$lib/aircraft/aerodromes';
	import { declaredDistanceMark } from '$lib/state/runwayOverride.svelte';
	import { formatSurface } from '$lib/data/runwaySurface';
	import type { ClosedFormConfig, PerfTable } from '$lib/aircraft/schema';
	import type { ClimbVerdict } from '$lib/aircraft/oneEngine';
	import {
		referenceConfig,
		shortFieldFlapsDeg,
		statesTakeoffConfig,
		type AssumedDistances,
		type DistanceCheck,
		type DistanceVerdict,
		type GridAxes,
		type InterpolationFlags,
		type PerfComputation,
		type PerfPhase,
		type PerfResult,
	} from '$lib/aircraft/performance';
	import type { NomogramMetric } from '$lib/aircraft/performanceChart';
	import { flightPrepModal, setNomogramMetric } from '$lib/state/flightPrepModal.svelte';
	import { display } from '$lib/state/display.svelte';
	import { notamState } from '$lib/state/notam.svelte';
	import { refreshWeather } from '$lib/state/weather.svelte';
	import {
		metarAgeMin,
		formatWind,
		formatAge,
		formatDistanceNM,
		precipSuggestsWet,
		type NearestPick,
	} from '$lib/weather/metar';
	import { decimalYearFromDate } from '$lib/route/magnetic';
	import { formatZulu, formatZuluNear } from '$lib/format/datetime';
	import PerfNomogram from './PerfNomogram.svelte';
	import { fuelComputation, perfInstants, perfMasses, tripLoadsComputation, type PerfMass } from './shared';
	import { tripTitle } from './tripText';
	import {
		columnConditions,
		ensurePerfForecasts,
		ensurePerfWeather,
		forecastWind,
		perfColumn,
		perfNowMs,
		runwaysOf,
		STANDARD_QNH_HPA,
		wxPick,
		wxStrip,
		type AutoSource,
		type PerfColumn,
		type PerfCtx,
		type PerfRow,
		type WxEstimateLine,
		type WxForecastLine,
		type WxMetarLine,
	} from './runwayPerf';
	import { windRuns } from '$lib/state/windAloft.svelte';
	import { NWP_DIR_NAMES } from '$lib/weather/openMeteo';
	import type { AerodromeForecast } from '$lib/state/aerodromeForecast.svelte';
	import { procedureInk, procedureText, procedureTip } from './takeoffProcedureView';
	import { printValue } from '$lib/ui/printValue';

	const PHASES: PerfPhase[] = ['takeoff', 'landing'];

	/* The POH fold (the reference tables, or the charts, with the correction
	   notes under them) starts open: the packs' mount (PrintDoc). The club
	   sheet always prints its tables and notes, and the packs, mounting the
	   page afresh, printed the fold's summary line alone, so the flight bag
	   carried no headwind, tailwind, grass, wet or flapless correction. On
	   screen it starts closed, and the per-page print follows it. */
	const { pohOpen = false }: { pohOpen?: boolean } = $props();

	// Unique id prefix: this page is mounted twice while pack-printing (the
	// modal + the print doc), so bare ids would collide.
	const uid = $props.id();

	const aircraft = $derived(selectedAircraft());
	const perf = $derived(aircraft?.performance ?? null);
	const fuel = $derived(fuelComputation());
	const loads = $derived(tripLoadsComputation(fuel));
	/** Each column's mass: the takeoff mass of the trip that takes off, lands
	 *  or diverts there (shared.ts perfMasses, the Overview's too). */
	const massAt = $derived(perfMasses(loads, aircraft));
	/** Each column's instant, the Overview's own timeline (shared.ts
	 *  perfInstants): what picks its METAR or its forecast. */
	const instantAt = $derived(perfInstants(fuel));
	const icaos = $derived(perfIcaos(orderedTrips(routes.list), flightPrep.perf.manualIcaos));

	// Any typed QNH / temperature / wind override anywhere (enables the
	// "Reset to live weather" button).
	const hasWeatherOverrides = $derived.by(() => {
		for (const a of Object.values(flightPrep.perf.byIcao)) {
			for (const phase of ['takeoff', 'landing'] as const) {
				const b = a[phase];
				if (b.qnhHpa != null || b.tempC != null || b.headwindKt != null || b.tailwindKt != null) {
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

	/** Where a field's automatic (non-typed) value comes from: 'live' (gray,
	 *  follows a usable METAR or the forecast at the phase's instant),
	 *  'estimate' (amber, live weather is on but neither speaks for the column,
	 *  so the value is an estimate), 'neutral' (gray, live weather off or a
	 *  derived calm, not an error). */
	type FieldSource = 'live' | 'estimate' | 'neutral';

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

	/** One grid column: the shared computation (runwayPerf.ts) and what the
	 *  page adds to show it. */
	interface Cell extends PerfColumn {
		/** The mass this column is computed at, and whose it is. */
		mass: PerfMass;
		manual: boolean;
		block: PerfBlockInputs;
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
		ensurePerfWeather(icaos);
	});

	// Live ages and freshness gates re-evaluate on the shared 60 s tick.
	const nowMs = $derived(perfNowMs());

	// WMM epoch for the true-to-magnetic wind conversion; one read per mount,
	// like the nav-log sheet.
	const wmmYear = decimalYearFromDate(new Date());

	// What the shared runway recipe reads besides app state.
	const ctx = $derived<PerfCtx>({ perf, oei: aircraft?.oneEngineInoperative ?? null, massKg: null, nowMs, wmmYear });

	/** One column's context: its mass and its instant. */
	function columnCtx(icao: string, phase: PerfPhase, massKg: number | null = null): PerfCtx {
		return { ...ctx, massKg, atMs: instantAt(icao, phase) };
	}

	// The forecast at every timed column's instant, for the columns the METAR
	// does not speak for (runwayPerf.ts wxPick): asked as the plan's times
	// change, a new run lands and on the minute tick, like the METARs.
	$effect(() => {
		void notamState.tick;
		void windRuns.newRunSeq;
		void ensurePerfForecasts(
			icaos.flatMap((icao) => PHASES.map((phase) => ({ icao, atMs: instantAt(icao, phase) }))),
		);
	});

	/** 'AROME 2026-10-08 06:00Z': the runs a forecast came from, else the
	 *  model, or the model and Open-Meteo when it answered. */
	function forecastSource(fc: AerodromeForecast): string {
		const runs = Object.entries(fc.runs ?? {})
			.sort(([a], [b]) => Object.keys(NWP_DIR_NAMES).indexOf(a) - Object.keys(NWP_DIR_NAMES).indexOf(b))
			.map(([dir, ms]) => `${NWP_DIR_NAMES[dir] ?? dir} ${formatZulu(new Date(ms))}`);
		const model = t.weather.windModels[fc.model];
		return fc.source === 'nwp' ? (runs.length > 0 ? runs.join(', ') : model) : t.navlog.viaOpenMeteo(model);
	}

	/** 'from the forecast for 2026-10-07 14:05Z (AROME 06:00Z)': a cell's
	 *  tip, the instant read and where the forecast came from. */
	function forecastProvenance(fc: AerodromeForecast): string {
		return t.flightprep.fromForecast({ valid: formatZulu(new Date(fc.atMs)), source: forecastSource(fc) });
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
	 *  gray when live weather is off (no live data expected), or when it is the
	 *  0 a typed wind on the other row implies (no estimate in it). */
	function fieldSource(source: AutoSource): FieldSource {
		if (source === 'metar' || source === 'forecast') {
			return 'live';
		}
		return source !== 'cancelled' && display.liveWeather ? 'estimate' : 'neutral';
	}

	/** The weather strip, on screen and on paper: what the columns read,
	 *  grouped by kind (runwayPerf.ts wxStrip), so an observation never sits
	 *  among the forecasts. A METAR no column reads is not listed. The
	 *  OBSERVATION decides and the fetch status is only an annotation (the
	 *  usableNearest rule): a failed refresh leaves the values it had, and a
	 *  line reading "weather unavailable" over a grid still computing from
	 *  that observation would be the lie. */
	const strip = $derived(wxStrip(icaos, (icao, phase) => columnCtx(icao, phase)));

	/** The forecast group's runs, named once in its heading when every line
	 *  shares them; null when they differ, each line then naming its own. */
	const stripSource = $derived.by(() => {
		const sources = strip.forecast.map((line) => forecastSource(line.fc));
		return sources.every((s) => s === sources[0]) ? (sources[0] ?? null) : null;
	});

	/** The day of the forecast group's first line, which its heading names
	 *  and its lines' times then omit. */
	const stripDayMs = $derived(strip.forecast[0]?.fc.atMs ?? nowMs);
	const stripDay = $derived(new Date(stripDayMs).toISOString().slice(0, 10));

	/** One row of the strip as shown. */
	interface StripRow {
		key: string;
		text: string;
		title?: string | undefined;
		stale: boolean;
	}

	/** The strip's groups as shown, each a heading over its rows: the METARs,
	 *  the forecast, and the estimates in their amber. The columns still
	 *  waiting for an answer read the estimates for now and come after,
	 *  without a heading or the amber (waitingRows). */
	const stripGroups = $derived.by(() => {
		const groups: { key: string; head: string; stale: boolean; rows: StripRow[] }[] = [];
		if (strip.metar.length > 0) {
			groups.push({
				key: 'metar',
				head: t.flightprep.wxMetarHead,
				stale: false,
				rows: strip.metar.map((line) => ({
					key: line.icao,
					text: metarLineText(line),
					title: line.pick.metar.rawOb,
					stale: false,
				})),
			});
		}
		if (strip.forecast.length > 0) {
			groups.push({
				key: 'forecast',
				head: t.flightprep.wxForecastHead({ day: stripDay, source: stripSource }),
				stale: false,
				rows: strip.forecast.map((line) => ({
					key: `${line.icao}@${line.fc.atMs}`,
					text: forecastLineText(line),
					stale: false,
				})),
			});
		}
		const settled = strip.estimate.filter((line) => !lineWaits(line));
		if (settled.length > 0) {
			groups.push({
				key: 'estimate',
				head: t.flightprep.wxEstimatedHead,
				stale: true,
				rows: settled.map((line) => ({ key: line.icao, text: estimateLineText(line), stale: true })),
			});
		}
		return groups;
	});
	const waitingRows = $derived<StripRow[]>(
		strip.estimate.filter(lineWaits).map((line) => ({ key: line.icao, text: estimateLineText(line), stale: false })),
	);

	/** 'LFLU landing 09:41Z': the aerodrome, the phase where only one of its
	 *  columns reads the line, and the instant a forecast is read at. */
	function lineHead(line: { icao: string; phase: PerfPhase | null }, at: string | null = null): string {
		return t.flightprep.wxLineHead({ icao: line.icao, phase: line.phase, at });
	}

	/** The values a line quotes, the ones its columns hold. */
	function lineValues(wind: string | null, qnhHpa: number | null, tempC: number | null): string {
		return [wind, qnhHpa != null ? `Q${qnhHpa}` : null, tempC != null ? `${tempC} °C` : null]
			.filter(Boolean)
			.join(', ');
	}

	/** One line: its head, then its values, then its notes. */
	function lineText(head: string, values: string, notes: (string | null)[]): string {
		return [values ? t.flightprep.wxLine({ head, values }) : head, ...notes.filter(Boolean)].join(', ');
	}

	/** 'LFPL, LFPO 11 NM away, 2026-10-08 18:00Z (26 min ago): 320° 7 kt,
	 *  Q1024, 13 °C' (no station part for the aerodrome's own). */
	function metarLineText(line: WxMetarLine): string {
		const m = line.pick.metar;
		const obsMs = m.obsTime * 1000;
		const head = [
			lineHead(line),
			m.icaoId === line.icao
				? null
				: t.flightprep.wxStationAway({ id: m.icaoId, dist: formatDistanceNM(line.pick.distanceM) }),
			`${formatZulu(new Date(obsMs))} (${formatAge(metarAgeMin(m, nowMs), t.weather.metar)})`,
		]
			.filter(Boolean)
			.join(', ');
		return lineText(head, lineValues(formatWind(m, t.weather.metar), line.qnhHpa, line.tempC), [
			precipSuggestsWet(m.wxString) ? t.flightprep.precipReported : null,
			// The first instant's day said when it is not the observation's,
			// the second's only when it is not the first's.
			line.noForecastAt.length > 0
				? t.flightprep.wxNoForecastAt(
						line.noForecastAt.map((at, i) => formatZuluNear(at, i === 0 ? obsMs : line.noForecastAt[0])),
					)
				: null,
			line.refreshFailed ? t.flightprep.wxRefreshFailedNote : null,
			line.typed ? t.flightprep.wxTypedNote : null,
		]);
	}

	/** 'LFLU landing 09:41Z: 013° 17 kt, Q1023, 13 °C', its runs after it
	 *  where the heading names none. */
	function forecastLineText(line: WxForecastLine): string {
		const values = lineValues(formatWind(forecastWind(line.fc), t.weather.metar), line.qnhHpa, line.tempC);
		return lineText(
			lineHead(line, formatZuluNear(line.fc.atMs, stripDayMs)),
			stripSource === null ? `${values} (${forecastSource(line.fc)})` : values,
			[line.typed ? t.flightprep.wxTypedNote : null],
		);
	}

	/** Still waiting for the METAR or the forecast: the columns read the
	 *  estimates for now, which the line says without the estimate's ink. */
	function lineWaits(line: WxEstimateLine): boolean {
		return line.metar.kind === 'fetching' || line.forecast === 'pending';
	}

	/** 'LFXX, no METAR station within 50 NM, no forecast': why neither speaks. */
	function estimateLineText(line: WxEstimateLine): string {
		const head = lineHead(line);
		const g = line.metar;
		const why =
			g.kind === 'fetching'
				? t.flightprep.wxFetching(head)
				: g.kind === 'unavailable'
					? t.flightprep.wxUnavailable(head)
					: g.kind === 'no-station'
						? t.flightprep.wxNoStation(head)
						: t.flightprep.wxMetarTooOld({
								head,
								id: g.pick.metar.icaoId,
								at: formatZulu(new Date(g.pick.metar.obsTime * 1000)),
								age: formatAge(metarAgeMin(g.pick.metar, nowMs), t.weather.metar),
							});
		return lineText(why, '', [
			line.forecast === 'pending'
				? t.flightprep.wxForecastPending
				: line.forecast === 'none'
					? t.flightprep.wxNoForecast
					: null,
			line.typed ? t.flightprep.wxTypedNote : null,
		]);
	}

	function buildCell(icao: string, phase: PerfPhase): Cell {
		const mass = massAt(icao, phase);
		const c = columnCtx(icao, phase, mass.massKg);
		const col = perfColumn(icao, phase, c);
		const inputs = perfFor(icao);
		const block = inputs[phase];
		// The column's one source (runwayPerf.ts wxPick), which its tips name.
		const src = wxPick(icao, c);
		const live = src?.kind === 'metar' ? src.pick : null;
		const fcProv = src?.kind === 'forecast' ? forecastProvenance(src.fc) : null;
		const hint = t.flightprep.typeToOverrideHint;
		// What each empty field holds is the computation's own value
		// (runwayPerf.ts autoQnh / autoTempC / autoWind), never re-derived
		// here: a copy is how typing the value a field showed came to change
		// the distances.
		const { qnhHpa: aq, tempC: at, headwindKt: ah, tailwindKt: atl } = col.autos;

		const qnh: WeatherField = {
			override: block.qnhHpa,
			auto: aq.value,
			source: fieldSource(aq.source),
			title:
				(aq.source === 'metar' && live
					? t.flightprep.qnhMetarTip({ qnh: aq.value, prov: provenance(icao, live) })
					: aq.source === 'forecast' && fcProv
						? t.flightprep.qnhMetarTip({ qnh: aq.value, prov: fcProv })
						: aq.source === 'dossier'
						? t.flightprep.qnhDossierTip(aq.value)
						: t.flightprep.qnhStandardTip(aq.value)) + hint,
			label: t.flightprep.ariaPerfCell({ row: 'QNH (hPa)', icao }),
			min: 900,
			max: 1100,
			set: (v) => setPerfBlock(icao, phase, { qnhHpa: v }),
		};

		const temp: WeatherField = {
			override: block.tempC,
			auto: at.value,
			source: fieldSource(at.source),
			title:
				(at.source === 'metar' && live
					? t.flightprep.tempMetarTip({ temp: at.value, prov: provenance(icao, live) })
					: at.source === 'forecast' && fcProv
						? t.flightprep.tempMetarTip({ temp: at.value, prov: fcProv })
						: t.flightprep.tempIsaTip(at.value)) + hint,
			label: t.flightprep.ariaPerfCell({ row: t.flightprep.temperatureC, icao }),
			min: undefined,
			max: undefined,
			set: (v) => setPerfBlock(icao, phase, { tempC: v }),
		};

		// A component reads 0 when the other row holds a typed wind (along one
		// runway the wind is a headwind or a tailwind, never both); a typed 0
		// cancels nothing, so typing the 0 a row shows leaves the other alone.
		const headwind: WeatherField = {
			override: block.headwindKt,
			auto: ah.value,
			source: fieldSource(ah.source),
			title:
				(ah.source === 'cancelled'
					? t.flightprep.headwindZeroTip
					: ah.source === 'metar' && live
						? t.flightprep.headwindMetarTip({ kt: ah.value, prov: provenance(icao, live) })
						: ah.source === 'forecast' && fcProv
							? t.flightprep.headwindMetarTip({ kt: ah.value, prov: fcProv })
							: t.flightprep.headwindCalmTip) + hint,
			label: t.flightprep.ariaPerfCell({ row: t.flightprep.headwindKt, icao }),
			min: 0,
			max: undefined,
			set: (v) => setPerfBlock(icao, phase, { headwindKt: v }),
		};
		const tailwind: WeatherField = {
			override: block.tailwindKt,
			auto: atl.value,
			source: fieldSource(atl.source),
			title:
				(atl.source === 'cancelled'
					? t.flightprep.tailwindZeroTip
					: atl.source === 'metar' && live
						? t.flightprep.tailwindMetarTip({ kt: atl.value, prov: provenance(icao, live) })
						: atl.source === 'forecast' && fcProv
							? t.flightprep.tailwindMetarTip({ kt: atl.value, prov: fcProv })
							: t.flightprep.tailwindCalmTip) + hint,
			label: t.flightprep.ariaPerfCell({ row: t.flightprep.tailwindKt, icao }),
			min: 0,
			max: undefined,
			set: (v) => setPerfBlock(icao, phase, { tailwindKt: v }),
		};

		return {
			...col,
			mass,
			manual: flightPrep.perf.manualIcaos.includes(icao),
			block,
			qnh,
			temp,
			headwind,
			tailwind,
		};
	}

	/** Whose mass a column is computed at, in words: the trip and how it uses
	 *  the aerodrome, or why the plan's heaviest or the manual's stands in. */
	function massTip(m: PerfMass, icao: string, phase: PerfPhase): string {
		if (m.source === 'poh' || m.trip === null) {
			return t.flightprep.massRowTipMax;
		}
		if (m.source === 'heaviest') {
			return phase === 'takeoff'
				? t.flightprep.massTipHeaviestTakeoff(m.trip + 1)
				: t.flightprep.massTipHeaviestLanding(m.trip + 1);
		}
		let tip = t.flightprep.massTipTrip({ n: m.trip + 1, route: tripTitle(fuel, m.trip) });
		if (phase === 'takeoff' && m.trips.length > 1) {
			tip += t.flightprep.massTipHeaviestFrom(icao);
		}
		if (m.via === 'alternate') {
			tip += t.flightprep.massTipAlternate;
		}
		if (phase === 'landing') {
			tip += t.flightprep.massTipLanding;
		}
		return tip;
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
	function okValue(row: PerfRow | undefined): PerfComputation | null {
		return row && row.result.ok ? row.result.value : null;
	}

	function flaggedFlags(f: InterpolationFlags): boolean {
		return f.massExtrapolated || f.altitudeExtrapolatedBelow || f.temperatureExtrapolated;
	}

	function flagged(result: PerfResult): boolean {
		return result.ok && flaggedFlags(result.value.flags);
	}

	function flagTitleFlags(f: InterpolationFlags): string | undefined {
		const parts = [
			f.massExtrapolated ? t.flightprep.flagMass : null,
			f.altitudeExtrapolatedBelow ? t.flightprep.flagAltitude : null,
			f.temperatureExtrapolated ? t.flightprep.flagTemp : null,
		].filter(Boolean);
		return parts.length ? t.flightprep.extrapolatedTip(parts.join(', ')) : undefined;
	}

	function flagTitle(result: PerfResult): string | undefined {
		return result.ok ? flagTitleFlags(result.value.flags) : undefined;
	}

	/** The flap setting a row's figures hold for: its config's, or the one a
	 *  table sheet states it was charted at (F-BRUE's 25 / 40). */
	function rowFlaps(config: ClosedFormConfig | null, phase: PerfPhase): number | null {
		if (config) {
			return config.flapsDeg;
		}
		if (perf?.kind !== 'table') {
			return null;
		}
		return (phase === 'takeoff' ? perf.takeoffFlapsDeg : perf.landingFlapsDeg) ?? null;
	}

	function rowLabel(metric: 'roll' | 'd15', config: ClosedFormConfig | null, phase: PerfPhase): string {
		const base = metric === 'roll' ? t.flightprep.groundRoll : t.flightprep.over15m;
		const flaps = rowFlaps(config, phase);
		return flaps == null ? base : `${base}${t.aircraft.flapsSuffix(flaps)}`;
	}

	/** "Distances déclarées suffisantes ?", naming the flaps where the phase
	 *  has several blocks. */
	function verdictLabel(config: ClosedFormConfig | null, phase: PerfPhase, blocks: number): string {
		const flaps = rowFlaps(config, phase);
		return blocks > 1 && flaps != null
			? t.flightprep.declaredSufficientFlaps(flaps)
			: t.flightprep.declaredSufficient;
	}

	function verdictClass(v: DistanceVerdict | null): string {
		return v?.sufficient === true ? 'ok' : v?.sufficient === false ? 'danger' : '';
	}

	/** Oui / NON, the no-go in capitals like the flapless row's. */
	function verdictText(v: DistanceVerdict | null): string {
		if (v?.sufficient == null) {
			return '—';
		}
		return v.sufficient ? t.flightprep.yes : t.flightprep.noCaps;
	}

	function checkText(c: DistanceCheck): string {
		const p = { d: Math.round(c.distanceM), avail: Math.round(c.availableM), pct: marginPct };
		switch (c.id) {
			case 'd15-tora':
				return t.flightprep.checkD15Tora(p);
			case 'd15-toda':
				return t.flightprep.checkD15Toda(p);
			case 'd15-asda':
				return t.flightprep.checkD15Asda(p);
			case 'asd-asda':
				return t.flightprep.checkAsdAsda(p);
			case 'roll-tora':
				return t.flightprep.checkRollTora(p);
			case 'd15-lda':
				return t.flightprep.checkD15Lda(p);
		}
	}

	/** Which checks failed, with their figures, then the assumed-distance
	 *  caveat. */
	function verdictTitle(v: DistanceVerdict | null, assumed: boolean): string | undefined {
		const parts = (v?.checks ?? []).filter((c) => !c.ok).map(checkText);
		if (assumed) {
			parts.push(t.flightprep.assumedVerdictTip);
		}
		return parts.length > 0 ? parts.join('. ') : undefined;
	}

	/** The soft-field note's flaps and the take-off runways it concerns: an
	 *  unpaved runway, where the manual's soft-field take-off may call for the
	 *  short-field flaps whatever the length. Null without a short-field
	 *  procedure or an unpaved runway. */
	function softFieldNote(cells: readonly Cell[]): { flaps: number; icaos: string } | null {
		const flaps = shortFieldFlapsDeg(perf);
		if (flaps == null) {
			return null;
		}
		const icaos = cells.filter((c) => c.end?.grass).map((c) => c.icao);
		return icaos.length > 0 ? { flaps, icaos: icaos.join(', ') } : null;
	}

	/** A twin's one-engine climb at 1500 ft, the A.340 leg every phase
	 *  checks: its gradient shown, its rate and speed in the title. */
	function oeiAt1500(v: ClimbVerdict | null) {
		return v?.checks.find((c) => c.heightFt === 1500) ?? null;
	}

	/** The failing A.340 legs, one line each, for the verdict's title. */
	function oeiTitle(v: ClimbVerdict | null, phase: PerfPhase): string {
		const head =
			phase === 'takeoff' ? t.flightprep.oeiSufficientTakeoffTip : t.flightprep.oeiSufficientLandingTip;
		const failing = (v?.checks ?? [])
			.filter((c) => !c.ok)
			.map((c) =>
				c.heightFt === 400
					? t.flightprep.oeiCheck400(Math.round(c.climb.rateFtMin))
					: t.flightprep.oeiCheck1500(c.climb.gradientPct.toFixed(2)),
			);
		return [head, ...failing].join('\n');
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
	 *  (takeoff reads TORA + TODA, and the ASDA where it judged it; landing
	 *  the LDA). */
	function verdictAssumed(cell: Cell, phase: PerfPhase, verdict: DistanceVerdict | null): boolean {
		const a = cell.dd.assumed;
		if (!a) {
			return false;
		}
		if (phase === 'landing') {
			return a.lda;
		}
		return a.tora || a.toda || (a.asda && (verdict?.checks.some((c) => c.id === 'd15-asda' || c.id === 'asd-asda') ?? false));
	}

	/** Hover detail for a runway end: surface + length (the option text shows
	 *  only the QFU). The surface word goes through the catalog with the
	 *  AirportDetail widened-lookup pattern (open dataset field, canonical
	 *  English label as the fallback). */
	/** Where the figure in a distance cell comes from. 'notam' = a NOTAM
	 *  restated it, 'contested' = a NOTAM contradicts the published one and
	 *  this could not read the new value, 'assumed' = the dataset publishes
	 *  none and the physical length stood in. */
	function ddState(cell: Cell, key: 'tora' | 'toda' | 'asda' | 'lda'): {
		kind: 'notam' | 'contested' | 'assumed';
		title: string;
	} | null {
		const id = cell.end?.id;
		const own = id ? runwaysOf(cell.icao) : null;
		// declaredDistanceMark normalises the end itself, so the raw id is fine.
		const mark = own && id ? declaredDistanceMark(own.res, [id], key) : null;
		if (mark) {
			return mark.kind === 'contested'
				? { kind: 'contested', title: t.flightprep.ddContestedTip(mark.notam.notam.id) }
				: { kind: 'notam', title: t.flightprep.ddFromNotam(mark.notam.notam.id) };
		}
		return ddAssumed(cell, key) ? { kind: 'assumed', title: t.flightprep.assumedDistanceTip } : null;
	}

	/** The ASDA cell's tip: its NOTAM or assumption, else where an ASDA read
	 *  off the TORA comes from (a safe reading, never tinted). */
	function asdaTitle(cell: Cell, st: ReturnType<typeof ddState>): string | undefined {
		return st?.title ?? (cell.dd.asdaFromTora ? t.flightprep.asdaFromToraTip : undefined);
	}

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

	/** Is the cell's end the pilot's own pick? False for the automatic
	 *  into-wind default, and for a pick no longer published (a dataset
	 *  release dropping the runway it was made at), which falls back to it. */
	function pickHolds(cell: Cell): boolean {
		return cell.block.runwayEnd != null && pickedRunwayEnd(cell.ends, cell.block.runwayEnd) != null;
	}

	/** The runway select's tooltip: the end's surface + length, plus a note when
	 *  the choice is the automatic into-wind default: no explicit pick yet, or
	 *  one no longer published, which says so (a withdrawn glider strip's pick
	 *  fell back to the paved runway, perhaps its opposite end, silently). */
	function rwyTitle(cell: Cell): string | undefined {
		if (!cell.end) {
			return undefined;
		}
		if (cell.closed.has(cell.end.id)) {
			// The closure leads: it is the reason not to use this runway at
			// all, whatever the numbers below it say.
			return `${t.flightprep.runwayClosedTitle}. ${endTitle(cell.end)}`;
		}
		const base = endTitle(cell.end);
		if (pickHolds(cell)) {
			return base || undefined;
		}
		const auto = cell.block.runwayEnd != null ? t.flightprep.rwyPickLostTip : t.flightprep.rwyAutoTip;
		return base ? `${base} (${auto})` : auto;
	}

	/** A row's absolute temperature: an ISA-offset table's at that altitude
	 *  (the sheet prints -5 / 15 / 35), an OAT table's as printed. */
	function tableTempC(tbl: PerfTable | GridAxes, altFt: number, tempC: number): number {
		return tbl.axis === 'oat' ? tempC : 15 - (2 * altFt) / 1000 + tempC;
	}

	const tablePerf = $derived(perf?.kind === 'table' ? perf : null);
	const closedPerf = $derived(perf?.kind === 'closed-form' ? perf : null);

	// Nomogram selections: config (chart), metric, and whose conditions draw
	// the reading path. Defaults: the normal take-off config (referenceConfig),
	// over 15 m, the first aerodrome; effective values fall back when the
	// selection vanishes.
	// The metric is a remembered preference (state/flightPrepModal), the same
	// on screen and on paper; the config and the aerodrome index this plane
	// and this plan, so they stay here.
	let chartConfigIdx = $state(-1);
	const chartMetric = $derived<NomogramMetric>(flightPrepModal.nomogramMetric);
	let chartIcao = $state('');
	const chartConfig = $derived.by(() => {
		if (!closedPerf) {
			return null;
		}
		return (
			closedPerf.configs[chartConfigIdx] ??
			referenceConfig(closedPerf, 'takeoff') ??
			closedPerf.configs[0] ??
			null
		);
	});
	const chartPathIcao = $derived(icaos.includes(chartIcao) ? chartIcao : (icaos[0] ?? null));
	const chartConditions = $derived(
		chartConfig && chartPathIcao
			? columnConditions(
					chartPathIcao,
					chartConfig.phase,
					columnCtx(chartPathIcao, chartConfig.phase, massAt(chartPathIcao, chartConfig.phase).massKg),
				)
			: null,
	);

	function configLabel(c: ClosedFormConfig): string {
		return t.aircraft.phaseFlaps({
			phase: c.phase === 'takeoff' ? t.flightprep.takeoff : t.flightprep.landing,
			flaps: c.flapsDeg,
		});
	}

	/** The closed-form notes in the sheet's multiplier shape: the reference
	 *  config's (the normal take-off, the default landing) over-15 m per-knot
	 *  rates evaluated at the sheet's anchor winds, plus its tailwind as a
	 *  percent per 2 kt. */
	function closedWindNote(
		phase: PerfPhase,
	): { factors: [number, number][]; tailPctPer2Kt: number } | null {
		if (!closedPerf) {
			return null;
		}
		const cfg = referenceConfig(closedPerf, phase);
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

{#snippet stripRow(r: StripRow)}
	<div class="wx-row" class:stale={r.stale} title={r.title}>{r.text}</div>
{/snippet}

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
		lang="en"
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
			<details class="poh" open={pohOpen}>
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
						<!-- Its own scroller on a narrow screen (the page's
						     .grid-wrap, visible on paper): a table wider than a
						     phone must pan alone, never the whole workbook. -->
						<div class="grid-wrap">
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
								{#each tbl.rows as row (row.altFt + '|' + row.tempC)}
									<tr>
										<td>{row.tempC === tbl.temperaturesC[0] ? row.altFt : ''}</td>
										<td>{tableTempC(tbl, row.altFt, row.tempC)}{tbl.axis === 'isa-offset' && row.tempC === 0 ? ' (ISA)' : ''}</td>
										<td>{row.massMax[0]}</td>
										<td>{row.massMax[1]}</td>
										<td>{row.massMin[0]}</td>
										<td>{row.massMin[1]}</td>
									</tr>
								{/each}
							</tbody>
						</table>
						</div>
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
				<!-- A twin's two one-figure tables, each at its own masses (the
				     accelerate-stop distance and the one-engine climb), with the
				     accelerate-stop's wind note: their own sheet on paper. -->
				{#if tablePerf.accelerateStop || aircraft.oneEngineInoperative?.climb}
					<div class="poh-twin">
						<div class="poh-tables">
							{#each [{ tbl: tablePerf.accelerateStop, caption: t.flightprep.pohAccelerateStop }, { tbl: aircraft.oneEngineInoperative?.climb, caption: t.flightprep.pohOeiClimb }] as m (m.caption)}
								{#if m.tbl}
									{@const tbl = m.tbl}
									<div class="grid-wrap">
									<table class="perf-table poh-table">
										<caption>{m.caption}</caption>
										<thead>
											<tr>
												<th>{t.flightprep.altFt}</th>
												<th>T (°C)</th>
												<th>{tbl.massMaxKg} kg</th>
												<th>{tbl.massMinKg} kg</th>
											</tr>
										</thead>
										<tbody>
											{#each tbl.rows as row (row.altFt + '|' + row.tempC)}
												<tr>
													<td>{row.tempC === tbl.temperaturesC[0] ? row.altFt : ''}</td>
													<td>{tableTempC(tbl, row.altFt, row.tempC)}{tbl.axis === 'isa-offset' && row.tempC === 0 ? ' (ISA)' : ''}</td>
													<td>{row.massMax}</td>
													<td>{row.massMin}</td>
												</tr>
											{/each}
										</tbody>
									</table>
									</div>
								{/if}
							{/each}
						</div>
						{#if tablePerf.accelerateStop?.headwind}
							<div class="legend muted">
								<div class="legend-col">
									{@render windNote(
										t.flightprep.headwindInfluenceAsd,
										t.flightprep.anchorsInterpTip,
										tablePerf.accelerateStop.headwind.slice(1),
									)}
								</div>
							</div>
						{/if}
					</div>
				{/if}
			</details>
		{:else if closedPerf && chartConfig}
			<details class="poh charts" open={pohOpen}>
				<summary>
					{t.flightprep.pohCharts({ type: aircraft.identity.type, lb: closedPerf.massReferenceLb })}
				</summary>
				<div class="chart-controls no-print">
					<div class="chips" role="group" aria-label={t.flightprep.chartAria}>
						<!-- By position, as the pick is: two configs may share a phase and
						     flaps, and the label is translated. -->
						{#each closedPerf.configs as c, i (i)}
							<button class="chip" class:on={c === chartConfig} onclick={() => (chartConfigIdx = i)}>
								{configLabel(c)}
							</button>
						{/each}
					</div>
					<div class="chips" role="group" aria-label={t.flightprep.metricAria}>
						<button
							class="chip"
							class:on={chartMetric === 'distance15m'}
							onclick={() => setNomogramMetric('distance15m')}
						>
							{t.flightprep.over15m}
						</button>
						<button
							class="chip"
							class:on={chartMetric === 'groundRoll'}
							onclick={() => setNomogramMetric('groundRoll')}
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
			<!-- Live-weather strip: where the columns' defaults come from, one
			     group per kind (the METARs, the forecast, the estimates), so an
			     observation never reads among the forecasts. QNH / temperature /
			     wind below follow these values until typed over; a METAR line's
			     raw report is its hover title. It PRINTS, the buttons beside it
			     do not: a sheet whose numbers may be an observation, a forecast
			     or ISA has to say which one, and the printed meteo annex stamps
			     its own source the same way. -->
			<div class="wx-strip">
				<div class="wx-rows">
					<p class="wx-print-head">{t.flightprep.wxUsedHeading}</p>
					{#if display.liveWeather}
						<!-- A heading travels with its first row, so on paper it
						     never ends a column alone: break-inside on the pair,
						     which Gecko honours in columns, where it ignores
						     break-after. -->
						{#each stripGroups as g (g.key)}
							<div class="wx-group-start">
								<p class="wx-group-head" class:stale={g.stale}>{g.head}</p>
								{@render stripRow(g.rows[0])}
							</div>
							{#each g.rows.slice(1) as r (r.key)}
								{@render stripRow(r)}
							{/each}
						{/each}
						{#each waitingRows as r (r.key)}
							{@render stripRow(r)}
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
			<!-- The QNH a column falls back to where nothing is observed (and
			     the transition level's): set here, where it acts, the standard
			     in grey until one is typed. -->
			<label class="qnh-default no-print" title={t.flightprep.qnhDefaultTip}>
				<span>{t.flightprep.qnhDefaultLabel}</span>
				<input
					type="number"
					lang="en"
					min="900"
					max="1100"
					step="1"
					value={flightPrep.dossier.qnhHpa ?? ''}
					placeholder={String(STANDARD_QNH_HPA)}
					oninput={(e) => {
						const v = Number.parseFloat((e.target as HTMLInputElement).value);
						setDossier({ qnhHpa: Number.isFinite(v) && v > 0 ? v : null });
					}}
				/>
				<span class="unit">hPa</span>
			</label>
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
										<th
											id="{uid}-col-{phase}-{cell.icao}"
											class:ad-shut={cell.fieldClosed != null}
											title={cell.fieldClosed
												? t.detail.adClosedTip(cell.fieldClosed)
												: undefined}
										>
											{cell.icao}
											{#if cell.fieldClosed != null}
												<span class="ad-shut-tag">{t.detail.adClosedTag}</span>
											{/if}
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
								<!-- The sheet's Masse row, one value per column: the
								     mass that column is computed at, its trip's. -->
								<tr>
									<th class="rowhead">{t.flightprep.massKg}</th>
									{#each cells as cell (cell.icao)}
										<td title={massTip(cell.mass, cell.icao, phase)}>
											{cell.mass.massKg != null ? Math.round(cell.mass.massKg) : '—'}
										</td>
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
													value={cell.end?.key ?? ''}
													use:printValue={cell.end?.key ?? ''}
													aria-label={t.flightprep.ariaPerfCell({
														row: t.flightprep.runwayQfu,
														icao: cell.icao,
													})}
													title={rwyTitle(cell)}
													class:closed={cell.end != null && cell.closed.has(cell.end.id)}
													class:lost={cell.block.runwayEnd != null && !pickHolds(cell)}
													onchange={(e) =>
														setPerfBlock(cell.icao, phase, {
															runwayEnd: (e.target as HTMLSelectElement).value || null,
														})}
												>
													<!-- Keyed and picked by the end's key: a designator
													     can repeat at one aerodrome (LIAF 17/35 and
													     17/35GLD), and keyed by the designator the list
													     threw and a pick of the second resolved to the
													     first. NOTAM closures still match the designator. -->
													{#each cell.ends as end (end.key)}
														<option value={end.key}
															>{cell.closed.has(end.id)
																? t.flightprep.runwayClosedOption(end.label)
																: end.label}</option
														>
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
											{@const st = ddState(cell, 'tora')}
											<td
												class:warn={st != null && st.kind !== 'notam'}
												class:from-notam={st?.kind === 'notam'}
												title={st?.title}
											>
												{fmtDd(cell.dd.toraM)}{#if st?.kind === 'contested'}<span
														class="dd-disputed">{t.flightprep.ddContestedShort}</span
													>{/if}
											</td>
										{/each}
									</tr>
									<tr>
										<th class="rowhead" title={t.flightprep.todaTip}>TODA (m)</th>
										{#each cells as cell (cell.icao)}
											{@const st = ddState(cell, 'toda')}
											<td
												class:warn={st != null && st.kind !== 'notam'}
												class:from-notam={st?.kind === 'notam'}
												title={st?.title}
											>
												{fmtDd(cell.dd.todaM)}{#if st?.kind === 'contested'}<span
														class="dd-disputed">{t.flightprep.ddContestedShort}</span
													>{/if}
											</td>
										{/each}
									</tr>
									<tr>
										<th class="rowhead" title={t.flightprep.asdaTip}>ASDA (m)</th>
										{#each cells as cell (cell.icao)}
											{@const st = ddState(cell, 'asda')}
											<td
												class:warn={st != null && st.kind !== 'notam'}
												class:from-notam={st?.kind === 'notam'}
												title={asdaTitle(cell, st)}
											>
												{fmtDd(cell.dd.asdaM)}{#if st?.kind === 'contested'}<span
														class="dd-disputed">{t.flightprep.ddContestedShort}</span
													>{/if}
											</td>
										{/each}
									</tr>
								{:else}
									<tr>
										<th class="rowhead" title={t.flightprep.ldaTip}>LDA (m)</th>
										{#each cells as cell (cell.icao)}
											{@const st = ddState(cell, 'lda')}
											<td
												class:warn={st != null && st.kind !== 'notam'}
												class:from-notam={st?.kind === 'notam'}
												title={st?.title}
											>
												{fmtDd(cell.dd.ldaM)}{#if st?.kind === 'contested'}<span
														class="dd-disputed">{t.flightprep.ddContestedShort}</span
													>{/if}
											</td>
										{/each}
									</tr>
								{/if}
								<!-- The grass factor applies unless the runway is KNOWN to be
								     paved; a mixed or unreadable surface says so in the
								     extrapolation orange, the factor resting on an assumption. -->
								<tr>
									<th class="rowhead" title={t.flightprep.unpavedTip}>{t.flightprep.grass}</th>
									{#each cells as cell (cell.icao)}
										{@const sc = cell.end?.surfaceClass}
										<td
											class:warn={sc === 'mixed' || sc === 'unknown'}
											title={sc === 'mixed'
												? t.flightprep.grassMixedTip
												: sc === 'unknown'
													? t.flightprep.grassUnknownTip
													: undefined}
										>
											{sc === 'mixed'
												? t.flightprep.grassMixed
												: sc === 'unknown'
													? t.flightprep.grassAssumed
													: cell.grass
														? t.flightprep.yesLower
														: t.flightprep.noLower}
										</td>
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
								     same-phase configs sharing a flaps setting. Each flap block
								     is judged on its own: the flight manual's figure (muted), the
								     distance REQUIRED with the safety margin (bold, what the
								     verdict reads), then the block's verdict. -->
								{#each configs as config, ci (`${config?.flapsDeg ?? 'table'}#${ci}`)}
									<!-- The first computed row opens the results block: a strong
									     rule separates it from the conditions above. -->
									<tr class="manual" class:section={ci === 0}>
										<th class="rowhead" title={t.flightprep.manualRowTip}>{rowLabel('d15', config, phase)}</th>
										{#each cells as cell (cell.icao)}
											{@const row = cell.rows[ci]}
											{@const v = okValue(row)}
											{#if !row}
												<td>—</td>
											{:else if v}
												<td class:warn={flagged(row.result)} title={flagTitle(row.result)}>
													{fmtDist(v.distance15m.correctedM)}
												</td>
											{:else if !row.result.ok}
												<td class="danger" title={t.flightprep.paAboveTip}>
													PA &gt; {row.result.maxAltFt} ft
												</td>
											{/if}
										{/each}
									</tr>
									<tr class="required">
										<th class="rowhead" title={t.flightprep.marginRowTip(perf.marginFactor)}>
											{t.flightprep.requiredD15Row(marginPct)}
										</th>
										{#each cells as cell (cell.icao)}
											{@const row = cell.rows[ci]}
											{@const v = okValue(row)}
											<td class:warn={row != null && flagged(row.result)} title={row ? flagTitle(row.result) : undefined}>
												{v ? fmtDist(v.distance15m.requiredM) : ''}
											</td>
										{/each}
									</tr>
									<tr class="manual">
										<th class="rowhead" title={t.flightprep.manualRowTip}>{rowLabel('roll', config, phase)}</th>
										{#each cells as cell (cell.icao)}
											{@const row = cell.rows[ci]}
											{@const v = okValue(row)}
											{#if !row}
												<td>—</td>
											{:else if v}
												<td class:warn={flagged(row.result)} title={flagTitle(row.result)}>
													{fmtDist(v.groundRoll.correctedM)}
												</td>
											{:else if !row.result.ok}
												<td class="danger">PA &gt; {row.result.maxAltFt} ft</td>
											{/if}
										{/each}
									</tr>
									<tr class="required">
										<th class="rowhead" title={t.flightprep.marginRowTip(perf.marginFactor)}>
											{t.flightprep.requiredRollRow(marginPct)}
										</th>
										{#each cells as cell (cell.icao)}
											{@const row = cell.rows[ci]}
											{@const v = okValue(row)}
											<td class:warn={row != null && flagged(row.result)} title={row ? flagTitle(row.result) : undefined}>
												{v ? fmtDist(v.groundRoll.requiredM) : ''}
											</td>
										{/each}
									</tr>
									<!-- A twin's accelerate-stop distance, one per sheet, which
									     every take-off block's verdict reads within the ASDA. -->
									{#if phase === 'takeoff' && perf.accelerateStop}
										<tr class="manual">
											<th class="rowhead" title={t.flightprep.asdRowTip}>{t.flightprep.accelerateStop}</th>
											{#each cells as cell (cell.icao)}
												{@const a = cell.asd}
												{#if a?.ok}
													<td class:warn={flaggedFlags(a.flags)} title={flagTitleFlags(a.flags)}>
														{fmtDist(a.figure.correctedM)}
													</td>
												{:else if a}
													<td class="danger" title={t.flightprep.paAboveTip}>PA &gt; {a.maxAltFt} ft</td>
												{:else}
													<td>—</td>
												{/if}
											{/each}
										</tr>
										<tr class="required">
											<th class="rowhead" title={t.flightprep.marginRowTip(perf.marginFactor)}>
												{t.flightprep.requiredAsdRow(marginPct)}
											</th>
											{#each cells as cell (cell.icao)}
												{@const a = cell.asd}
												<td class:warn={a?.ok === true && flaggedFlags(a.flags)} title={a?.ok ? flagTitleFlags(a.flags) : undefined}>
													{a?.ok ? fmtDist(a.figure.requiredM) : ''}
												</td>
											{/each}
										</tr>
									{/if}
									<!-- The block's verdict: Oui / NON, the failing checks in its
									     title. One that consumed an assumed declared distance keeps
									     its answer but tints orange (.warn wins over .ok / .danger
									     by stylesheet order, on purpose). -->
									<tr class="verdict">
										<th
											class="rowhead"
											title={phase === 'takeoff'
												? t.flightprep.declaredSufficientTakeoffTip(marginPct)
												: t.flightprep.declaredSufficientLandingTip(marginPct)}
										>
											{verdictLabel(config, phase, configs.length)}
										</th>
										{#each cells as cell (cell.icao)}
											{@const verdict = cell.rows[ci]?.verdict ?? null}
											{@const assumed = verdict?.sufficient != null && verdictAssumed(cell, phase, verdict)}
											<td class={verdictClass(verdict)} class:warn={assumed} title={verdictTitle(verdict, assumed)}>
												{verdictText(verdict)}
											</td>
										{/each}
									</tr>
								{/each}
								<!-- What to fly: the normal take-off whenever its distances
								     suffice, else the short-field one, which changes the
								     checklist and the speeds; shown when the sheet says which
								     take-off it charts. -->
								{#if phase === 'takeoff' && statesTakeoffConfig(perf)}
									<tr class="verdict procedure">
										<th class="rowhead" title={t.flightprep.takeoffProcedureTip}>{t.flightprep.takeoffProcedure}</th>
										{#each cells as cell (cell.icao)}
											<td class={procedureInk(cell.pick)} title={procedureTip(cell.pick, cell.rows)}>
												{procedureText(cell.pick)}
											</td>
										{/each}
									</tr>
								{/if}
								<!-- A twin's one-engine climb (CAT.POL.A.340): the gradient at
								     1500 ft, then the verdict; its NON is the caution ink, the
								     engine failure then planned as in a single (A.300(b)), not a
								     no-go. -->
								{#if aircraft.oneEngineInoperative?.climb}
									<tr class="manual section">
										<th class="rowhead" title={t.flightprep.oeiClimbRowTip}>{t.flightprep.oeiClimbRow}</th>
										{#each cells as cell (cell.icao)}
											{@const c = oeiAt1500(cell.oei)}
											<td
												class:warn={c != null && flaggedFlags(c.climb.flags)}
												title={c
													? t.flightprep.oeiClimbCellTip({
															rate: Math.round(c.climb.rateFtMin),
															tas: Math.round(c.climb.tasKt),
															pct: c.climb.gradientPct.toFixed(2),
														})
													: undefined}
											>
												{c ? c.climb.gradientPct.toFixed(2) : '—'}
											</td>
										{/each}
									</tr>
									<tr class="verdict">
										<th
											class="rowhead"
											title={phase === 'takeoff'
												? t.flightprep.oeiSufficientTakeoffTip
												: t.flightprep.oeiSufficientLandingTip}
										>
											{t.flightprep.oeiSufficient}
										</th>
										{#each cells as cell (cell.icao)}
											{@const v = cell.oei}
											<td
												class={v?.sufficient === true ? 'ok' : v?.sufficient === false ? 'caution' : ''}
												title={v ? oeiTitle(v, phase) : undefined}
											>
												{v?.sufficient == null ? '—' : v.sufficient ? t.flightprep.yes : t.flightprep.noCaps}
											</td>
										{/each}
									</tr>
								{/if}
								{#if phase === 'landing' && perf.flaplessLandingFactor}
									<tr class="verdict">
										<th
											class="rowhead"
											title={t.flightprep.flaplessFeasibleTip(perf.flaplessLandingFactor)}
										>
											{t.flightprep.flaplessFeasible}
										</th>
										{#each cells as cell (cell.icao)}
											{@const f = cell.flapless}
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
					<!-- Inside the phase section: the print rule sets every other
					     child of the page full-width. -->
					{#if phase === 'takeoff'}
						{@const soft = softFieldNote(cells)}
						{#if soft}
							<p class="soft-note">{t.flightprep.softFieldNote(soft)}</p>
						{/if}
						{#if aircraft.oneEngineInoperative}
							<p class="soft-note">
								{t.flightprep.twinSpeeds({
									vmc: aircraft.oneEngineInoperative.vmcKt,
									vyse: aircraft.oneEngineInoperative.vyseKt,
								})}
							</p>
						{/if}
					{/if}
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

	/* A twin's accelerate-stop and climb tables, under the notes. */
	.poh-twin {
		margin-top: 12px;
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
		--rowhead-w: 200px;
		--col-min: 96px;

		table-layout: fixed;
		width: 100%;
		max-width: calc(var(--rowhead-w) + var(--cols, 4) * 170px);
	}

	.perf-table.grid thead .rowhead {
		width: var(--rowhead-w);
	}

	:global(:root.mobile-ui) .perf-table.grid {
		--rowhead-w: 120px;
	}

	/* Screen only: a column never shrinks past reading. Below its minimum
	   the grid keeps the width and pans in its wrapper under its row heads,
	   where the columns used to split whatever the page left (five fields
	   on a phone: 29 px each, an input showing one digit). Paper keeps its
	   own rules: both phases side by side, the columns shrinking to fit. */
	@media screen {
		/* Separate borders, drawn right and below each cell (the trips
		   table's model): a collapsed border stays where the table drew it,
		   so a pinned row head lost its rule and the frame, and slivers of
		   the panned inputs showed past its edge. The frame's left side is
		   the row heads' own, so it pins with them. */
		.perf-table.grid {
			min-width: calc(var(--rowhead-w) + var(--cols, 4) * var(--col-min));
			border-collapse: separate;
			border-spacing: 0;
			border-left: 0;
		}

		.perf-table.grid th,
		.perf-table.grid td {
			border-width: 0 1px 1px 0;
		}

		.perf-table.grid tr > :last-child {
			border-right-width: 0;
		}

		.perf-table.grid tbody tr:last-child > * {
			border-bottom-width: 0;
		}

		.perf-table.grid thead th {
			border-bottom-width: 2px;
		}

		.perf-table.grid tr.section > * {
			border-top-width: 2px;
		}

		.perf-table.grid .rowhead {
			position: sticky;
			left: 0;
			z-index: 1;
			border-left: 2px solid var(--border-strong);
			border-right-width: 2px;
		}
	}

	.perf-table.grid .rowhead {
		white-space: normal;
	}

	.perf-table.grid .num,
	.perf-table.grid .rwy {
		width: 100%;
		box-sizing: border-box;
	}

	/* The flight manual's figure, muted: the decisive figure is the required
	   one under it. The extrapolation orange and the pressure-altitude red
	   keep their inks (a scoped rule would outrank the shared .warn and
	   .danger, so it leaves them alone). */
	tr.manual td:not(.warn, .danger),
	tr.manual .rowhead {
		color: var(--text-muted);
	}

	tr.section th,
	tr.section td {
		border-top: 2px solid var(--border-strong);
	}

	/* The distance REQUIRED, with the safety margin: what the verdict reads. */
	tr.required td {
		font-weight: 600;
	}

	tr.verdict td {
		font-weight: 700;
	}

	/* "Terrain court (volets 25°)" wraps inside its column rather than
	   painting over the next (cells are nowrap under a fixed layout). */
	tr.procedure td {
		white-space: normal;
	}

	.soft-note {
		margin: 6px 0 0;
		font-size: 12px;
		color: var(--text-muted);
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

	/* A group's heading: what its lines are, the METARs, the forecast and
	   its runs, or the estimates. It opens a box with its first row; a group
	   after another stands apart. */
	.wx-group-start {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.wx-row + .wx-group-start {
		margin-top: 4px;
	}

	.wx-group-head {
		margin: 0;
		font-weight: 600;
		color: var(--text);
	}

	.wx-row.stale,
	.wx-group-head.stale {
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

	.qnh-default {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 6px 0 0;
		font-size: 12px;
	}

	.qnh-default input {
		width: 72px;
		padding: 3px 6px;
		font: inherit;
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	.qnh-default input::placeholder {
		color: var(--text-muted);
		opacity: 1;
	}

	.qnh-default .unit {
		font-size: 11px;
		color: var(--text-muted);
	}

	/* A closed runway keeps its numbers, in the colour that says do not use
	   it: the pilot asked for this end, so the cell answers, marked. */
	.rwy.closed {
		color: var(--danger);
		font-weight: 600;
	}

	/* A pick no longer published, the automatic choice in its place: the
	   extrapolation orange, as for a figure the table could not give. */
	.rwy.lost {
		color: var(--workbook-orange);
		font-weight: 600;
	}

	.rwy {
		font: inherit;
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 1px 2px;
	}

	/* A column whose FIELD is shut. The figures below stay exactly what the
	   aerodrome would give; what changes is that the header says you may not
	   land there today. */

	/* A figure a NOTAM restated: read, and marked so the pilot knows the
	   number is not the one the AIP prints. */
	.from-notam {
		font-weight: 600;
		color: var(--nav-orange);
	}

	/* A figure the AIP prints and a NOTAM contradicts, where the new value
	   could not be read: the shown number may be too LONG, which is the one
	   direction that matters here. */
	.dd-disputed {
		margin-left: 4px;
		font-size: var(--fs-2xs);
		font-weight: 600;
		color: var(--danger);
	}

	.ad-shut-tag {
		display: block;
		margin-top: 1px;
		padding: 0 3px;
		border-radius: var(--radius-sm);
		background: var(--danger);
		color: var(--surface);
		font-size: var(--fs-2xs);
		font-weight: 600;
		white-space: nowrap;
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

		/* A group's heading stays with its first line, never alone at the
		   foot of a column. */
		.wx-group-start {
			display: block;
			break-inside: avoid;
		}

		/* An estimated line takes the page's own no-live amber, the ink the
		   estimated cells below it carry (theme.css keeps it distinct from the
		   workbook orange, which means an extrapolated POH value). */
		.wx-row.stale,
		.wx-group-head.stale {
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

		/* A twin's fold holds two sheets: the take-off and landing tables
		   with their notes as for a single, then its accelerate-stop and
		   one-engine climb tables on a sheet of their own (padding, not
		   margin, after the forced break: see below). */
		.poh[open]:has(.poh-twin) {
			break-inside: auto;
		}

		.poh-twin {
			break-before: page;
			break-inside: avoid;
			margin-top: 0;
			padding-top: 12mm;
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

		/* On paper the fold is a heading, not a control: no disclosure
		   triangle before it (the packs always print it open). */
		.poh > summary {
			list-style: none;
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
