<script lang="ts">
	/* The Overview page, a port of the workbook's "Dossier" front sheet and
	 * laid out like its print: the framed A) administrative box on top, then
	 * two columns; left the trips timeline (ETA / ground time / ETD
	 * in the sheet's row order), the sunrise/sunset strip (computed from the
	 * flight date), the alternates and the endurance-limit strip; right the
	 * weather, NOTAM and charts boxes. All wall-clock times are UTC with the
	 * browser's local time stacked underneath. The weather box STATES the wind
	 * each trip flies and the departure's QNH (weatherBox.ts), each set where it
	 * acts: the Route tab's wind switch, a performance column. Under the ETD,
	 * the take-off procedure each departure calls for,
	 * read from the performance page's own recipe (runwayPerf.ts), for a sheet
	 * that says which take-off it charts. */

	import {
		flightPrep,
		dossierFlightDate,
		dossierStopMin,
		isPastFlightDate,
		dossierCheck,
		setDossier,
		setDossierPilot,
		setDossierStop,
		setDossierCheck,
	} from '$lib/state/flightPrep.svelte';
	import { selectedAircraft } from '$lib/state/aircraft.svelte';
	import { isMultiEngine } from '$lib/aircraft/schema';
	import {
		dossierChain,
		computeDossierTimeline,
		fmtClock,
		parseClock,
		parseDuration,
		DOSSIER_CHECKS,
		type DossierCheckGroup,
	} from '$lib/aircraft/dossier';
	import { sunTimesUtc, type SunEvent } from '$lib/route/sun';
	import { windRuns } from '$lib/state/windAloft.svelte';
	import {
		fuelComputation,
		tripLoadsComputation,
		dossierComputation,
		perfInstants,
		perfMasses,
		fmtHHMM,
	} from './shared';
	import {
		autoQnh,
		ensurePerfForecasts,
		ensurePerfWeather,
		hasTypedWeather,
		perfColumn,
		perfNowMs,
		weatherEstimated,
		wxPick,
		type PerfColumn,
		type PerfCtx,
	} from './runwayPerf';
	import { tripWindBases } from './windBasis';
	import { departureQnhLines, overviewWindLines, type BoxLine, type DepartureQnh } from './weatherBox';
	import { perfFor } from '$lib/state/flightPrep.svelte';
	import { requestRouteWindSwitch } from '$lib/state/routeTabFocus.svelte';
	import { plansForecastFacts, plansForecastSource, plansMeanForecast } from '$lib/state/routeWind.svelte';
	import { routeSettings } from '$lib/state/route.svelte';
	import { effectiveTransitionAltFt } from '$lib/state/transitionAlt.svelte';
	import { procedureInk, procedureLines, procedureText, procedureTip } from './takeoffProcedureView';
	import { load1, tripTitle } from './tripText';
	import { onBoardCell } from './onBoardText';
	import { statesTakeoffConfig } from '$lib/aircraft/performance';
	import { takeoffWindow } from '$lib/aircraft/tripLoads';
	import { decimalYearFromDate } from '$lib/route/magnetic';
	import { notamState } from '$lib/state/notam.svelte';
	import { printValue } from '$lib/ui/printValue';
	import { normalizeClock24 } from '$lib/format/datetime';
	import { t } from '$lib/state/i18n.svelte';

	const aircraft = $derived(selectedAircraft());
	const fuel = $derived(fuelComputation());
	const loads = $derived(tripLoadsComputation(fuel));
	const dossier = $derived(dossierComputation(fuel, loads));
	const chain = $derived(dossierChain(dossier.trips));
	const flightDate = $derived(dossierFlightDate());
	const departureMin = $derived(parseClock(flightPrep.dossier.departureTime ?? ''));
	const timeline = $derived(
		departureMin != null && dossier.trips.length > 0
			? computeDossierTimeline(dossier.trips, {
					departureMin,
					fuelOnBoardMin: dossier.fuelOnBoardMin,
					finalReserveMin: dossier.finalReserveMin,
					fuelAtTakeoffMin: dossier.fuelAtTakeoffMin ?? undefined,
				})
			: null,
	);

	/** Dossier trip j's own loading (the trip loads, by its trip index). */
	function tripLoad(j: number) {
		const ti = dossier.trips[j]?.tripIndex;
		const k = ti === undefined || !loads ? -1 : loads.tripIndex.indexOf(ti);
		return k < 0 || !loads ? null : loads.loads.trips[k];
	}

	/* Only when a trip is short: which, and where it is set right. */
	const shortTrips = $derived(
		loads
			? loads.loads.shortTrips.map((st) =>
					loads.loads.trips.length > 1
						? t.flightprep.subjTrip({ n: st.chainIndex + 1, what: tripTitle(fuel, st.chainIndex) })
						: tripTitle(fuel, st.chainIndex),
				)
			: [],
	);
	const sun = $derived(chain.map((e) => sunTimesUtc(e.lat, e.lon, flightDate)));

	// The take-off procedure each departure calls for: the performance page's
	// own computation, so the two pages cannot disagree. Only for a sheet that
	// says which take-off it charts (the PA28s, F-BRUE), so the DR400s fetch
	// nothing more than before.
	const perf = $derived(aircraft?.performance ?? null);
	const showProcedure = $derived(statesTakeoffConfig(perf));
	// The performance page's own context, built the way it builds it: the
	// shared 60 s tick for the live ages, the WMM epoch read once per mount,
	// and each column at its own trip's mass (perfMasses, the page's own).
	const massAt = $derived(perfMasses(loads, aircraft));
	const instantAt = $derived(perfInstants(fuel));
	const nowMs = $derived(perfNowMs());
	const wmmYear = decimalYearFromDate(new Date());
	const perfCtx = $derived<PerfCtx>({ perf, massKg: null, nowMs, wmmYear });
	/** Chain column j's take-off, the departure of trip j (the last column is
	 *  an arrival); null for a free-point departure. */
	const takeoffs = $derived<(PerfColumn | null)[]>(
		showProcedure
			? dossier.trips.map((trip) =>
					trip.from.icao
						? perfColumn(trip.from.icao, 'takeoff', {
								...perfCtx,
								massKg: massAt(trip.from.icao, 'takeoff').massKg,
								atMs: instantAt(trip.from.icao, 'takeoff'),
							})
						: null,
				)
			: [],
	);

	// What each trip flies with (windBasis.ts), stated: the wind is set where
	// it acts, the Route tab's wind switch. Beside it, what the plan's
	// forecast says (the levels behind its mean, ISA, the freezing level),
	// the levels as flight levels above the transition altitude only under
	// the semicircular rule, as the nav log prints them.
	const windTrips = $derived(tripWindBases(fuel));
	const windRoutes = $derived(windTrips.map((x) => x.route));
	const windLines = $derived(
		overviewWindLines(windTrips, {
			mean: plansMeanForecast(windRoutes),
			facts: plansForecastFacts(windRoutes),
			source: plansForecastSource(windRoutes),
			taFt: routeSettings.semicircular ? effectiveTransitionAltFt() : Infinity,
		}),
	);

	// The departure's QNH as its take-off column reads it (typed there, else
	// runwayPerf.ts autoQnh at the ETD): the performance page's own value,
	// never a copy.
	const depIcao = $derived(dossier.trips[0]?.from.icao ?? null);
	const depQnh = $derived.by((): DepartureQnh | null => {
		const icao = depIcao;
		if (!icao) {
			return null;
		}
		const ctx: PerfCtx = { ...perfCtx, atMs: instantAt(icao, 'takeoff') };
		const typed = perfFor(icao).takeoff.qnhHpa;
		const auto = autoQnh(icao, ctx);
		return { icao, hpa: typed ?? auto.value, typed: typed != null, source: auto.source, pick: wxPick(icao, ctx) };
	});
	const qnhLines = $derived(departureQnhLines(depQnh, nowMs));

	// The same METAR the performance page computes from, fetched here too:
	// the Overview is the modal's first page, and a procedure or a QNH read
	// at ISA and calm before the performance page was ever opened would
	// disagree with it. The first departure always (its QNH), every
	// departure for a sheet that charts its take-off.
	$effect(() => {
		void notamState.tick;
		void windRuns.newRunSeq;
		const departures = showProcedure
			? dossier.trips.map((trip) => trip.from.icao).filter((i): i is string => i != null)
			: depIcao
				? [depIcao]
				: [];
		if (departures.length > 0) {
			ensurePerfWeather(departures);
			void ensurePerfForecasts(departures.map((icao) => ({ icao, atMs: instantAt(icao, 'takeoff') })));
		}
	});

	/** One line per fact: a closed field or a closed runway end first, then
	 *  what to fly, qualified as the performance page's weather strip
	 *  qualifies its figures (an estimate, typed values), then why, where it
	 *  changes the checklist. */
	function procedureTitle(col: PerfColumn): string {
		const lines: string[] = [];
		if (col.fieldClosed) {
			lines.push(t.detail.adClosedTip(col.fieldClosed));
		} else if (col.end && col.closed.has(col.end.id)) {
			lines.push(t.flightprep.runwayClosedTitle);
		}
		const answer = [t.flightprep.procCellTitle({ icao: col.icao, proc: procedureText(col.pick) })];
		if (weatherEstimated(col.icao, { ...perfCtx, atMs: instantAt(col.icao, 'takeoff') })) {
			answer.push(t.flightprep.wxEstimatedNote);
		}
		if (hasTypedWeather(col.icao, 'takeoff')) {
			answer.push(t.flightprep.wxTypedNote);
		}
		lines.push(answer.join(', '));
		const tip = procedureTip(col.pick, col.rows);
		if (tip) {
			lines.push(tip);
		}
		return lines.join('\n');
	}

	function procedureCellInk(col: PerfColumn): string {
		const shut = col.fieldClosed != null || (col.end != null && col.closed.has(col.end.id));
		return shut ? 'danger' : procedureInk(col.pick);
	}

	function text(e: Event): string {
		return (e.target as HTMLInputElement).value;
	}

	/** Commit a ground-stop duration (the ETD field's contract next door): empty
	 *  hands the stop back to automatic, valid text snaps to canonical HH:MM,
	 *  garbage reverts to the kept value. A stated 00:00 is the pilot's own and
	 *  stays. */
	function onStop(e: Event, i: number): void {
		const raw = text(e).trim();
		if (raw === '') {
			setDossierStop(i, null);
		} else {
			const min = parseDuration(raw);
			if (min != null) {
				setDossierStop(i, min);
			}
		}
		(e.target as HTMLInputElement).value = stopText(i);
	}

	/** The stop cell's text: empty while the stop is automatic, so its 00:00
	 *  placeholder shows what is in force (no ground time). */
	function stopText(i: number): string {
		const min = dossierStopMin(i);
		return min == null ? '' : fmtHHMM(min);
	}

	/** Commit the departure time (UTC, 24h); empty clears it, valid text snaps
	 *  to canonical HH:MM, garbage reverts to the kept value. */
	function onEtd(e: Event): void {
		const raw = text(e).trim();
		if (raw === '') {
			setDossier({ departureTime: null });
		} else {
			const norm = normalizeClock24(raw);
			if (norm) {
				setDossier({ departureTime: norm });
			}
		}
		(e.target as HTMLInputElement).value = flightPrep.dossier.departureTime ?? '';
	}

	/** Commit the potential duration; empty clears it, the field normalizes
	 *  back to HH:MM. */
	function onPotential(e: Event): void {
		const t = text(e).trim();
		if (t === '') {
			setDossier({ potentialMin: null });
		} else {
			const min = parseDuration(t);
			if (min != null) {
				setDossier({ potentialMin: min });
			}
		}
		const v = flightPrep.dossier.potentialMin;
		(e.target as HTMLInputElement).value = v != null ? fmtHHMM(v) : '';
	}

	/** Browser-local HH:MM of `min` minutes after 00:00 UTC on the flight date. */
	function localClock(min: number): string {
		// One-shot conversion through the host timezone; not reactive state.
		const d = new Date(Date.parse(flightDate + 'T00:00:00Z') + Math.round(min) * 60000);
		return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
	}

	/** ISO dates compare lexicographically. */
	function expired(d: string | null): boolean {
		return d != null && d < flightDate;
	}

	// A stored flight date already behind us (a dossier left from an earlier
	// flight): every timed read on these pages, the forecast winds, the sun,
	// the TEMSI / WINTEM window, would answer for a flight already flown.
	// The minute tick turns it at midnight UTC.
	const flightDatePast = $derived.by(() => {
		void notamState.tick;
		return isPastFlightDate(flightPrep.dossier.flightDate);
	});

	/** Past sunset at chain column `col` (alternates compare against their
	 *  trip's destination column, a close approximation). */
	function afterSunset(min: number, col: number): boolean {
		const s = sun[col]?.sunset;
		return s?.kind === 'time' && min > s.minutesUtc;
	}

	function sunText(e: SunEvent | null | undefined): string {
		if (!e) {
			return '—';
		}
		return e.kind === 'polar-day'
			? t.flightprep.polarDay
			: e.kind === 'polar-night'
				? t.flightprep.polarNight
				: fmtClock(e.minutesUtc);
	}

	function checksFor(group: DossierCheckGroup) {
		return DOSSIER_CHECKS.filter((c) => c.group === group);
	}
</script>

{#snippet boxLines(lines: readonly BoxLine[])}
	{#each lines as line, i (i)}
		<span class="box-line {line.ink}"
			>{#if line.parts}{#each line.parts as part, j (j)}<span class="part {part.ink}">{part.text}</span
					>{/each}{:else}{line.text}{/if}</span
		>
	{/each}
{/snippet}

{#snippet checklist(group: DossierCheckGroup)}
	<ul class="checks">
		{#each checksFor(group) as c (c.id)}
			<li>
				<label>
					<input
						type="checkbox"
						checked={dossierCheck(c.id)}
						use:printValue={dossierCheck(c.id)}
						onchange={(e) => setDossierCheck(c.id, (e.target as HTMLInputElement).checked)}
					/>
					<span>{t.flightprep.checks[c.id]}</span>
				</label>
			</li>
		{/each}
	</ul>
{/snippet}

<div class="page fp-page">
	<div class="chain">
		{chain.length > 0 ? chain.map((e) => e.label).join(' → ') : t.flightprep.noRoutePlanned}
	</div>

	<section class="box">
		<h3>{t.flightprep.secAdmin}</h3>
		<div class="cols">
			<div class="block">
				<div class="fields">
					<label
						class="field"
						title={flightDatePast ? t.flightprep.flightDatePastTip : t.flightprep.flightDateTip}
					>
						<span>{t.flightprep.flightDate}</span>
						<input
							type="date"
							class:danger={flightDatePast}
							value={flightDate}
							use:printValue={flightDate}
							onchange={(e) => setDossier({ flightDate: text(e) || null })}
						/>
					</label>
					<label class="field">
						<span>{t.flightprep.pilot}</span>
						<input
							type="text"
							autocapitalize="words"
							spellcheck="false"
							value={flightPrep.dossier.pilot.name}
							use:printValue={flightPrep.dossier.pilot.name}
							onchange={(e) => setDossierPilot({ name: text(e) })}
						/>
					</label>
					<!-- A twin's row is the MEP class rating's, in the SEP row's
					     place (the sheet keeps one row): both dates are kept. -->
					{#if isMultiEngine(aircraft)}
						<label class="field">
							<span>{t.flightprep.mepValidity}</span>
							<input
								type="date"
								class:danger={expired(flightPrep.dossier.pilot.mepValidUntil)}
								title={expired(flightPrep.dossier.pilot.mepValidUntil)
									? t.flightprep.expiresBeforeTip
									: undefined}
								value={flightPrep.dossier.pilot.mepValidUntil ?? ''}
								use:printValue={flightPrep.dossier.pilot.mepValidUntil ?? ''}
								onchange={(e) => setDossierPilot({ mepValidUntil: text(e) || null })}
							/>
						</label>
					{:else}
						<label class="field">
							<span>{t.flightprep.sepValidity}</span>
							<input
								type="date"
								class:danger={expired(flightPrep.dossier.pilot.sepValidUntil)}
								title={expired(flightPrep.dossier.pilot.sepValidUntil)
									? t.flightprep.expiresBeforeTip
									: undefined}
								value={flightPrep.dossier.pilot.sepValidUntil ?? ''}
								use:printValue={flightPrep.dossier.pilot.sepValidUntil ?? ''}
								onchange={(e) => setDossierPilot({ sepValidUntil: text(e) || null })}
							/>
						</label>
					{/if}
					<label class="field">
						<span>{t.flightprep.medicalValidity}</span>
						<input
							type="date"
							class:danger={expired(flightPrep.dossier.pilot.medicalValidUntil)}
							title={expired(flightPrep.dossier.pilot.medicalValidUntil)
								? t.flightprep.expiresBeforeTip
								: undefined}
							value={flightPrep.dossier.pilot.medicalValidUntil ?? ''}
							use:printValue={flightPrep.dossier.pilot.medicalValidUntil ?? ''}
							onchange={(e) => setDossierPilot({ medicalValidUntil: text(e) || null })}
						/>
					</label>
				</div>
				{@render checklist('pilot')}
			</div>
			<div class="block">
				<div class="fields">
					{#if aircraft}
						<div class="field">
							<span>{t.flightprep.aircraft}</span>
							<!-- A generic sheet is no aircraft: it says so in this row, the
							     Type row naming the type (no line added: one sheet). -->
							<strong
								>{aircraft.identity.generic !== undefined
									? t.flightprep.genericAircraft
									: (aircraft.identity.registration ?? aircraft.identity.type)}</strong
							>
						</div>
						<div class="field">
							<span>{t.flightprep.type}</span>
							<strong>{aircraft.identity.type}</strong>
						</div>
					{:else}
						<p class="muted">{t.flightprep.selectAircraftNote}</p>
					{/if}
					<label class="field" title={t.flightprep.potentialTip}>
						<span>{t.flightprep.timeToCheck}</span>
						<input
							class="hhmm"
							type="text"
							inputmode="numeric"
							placeholder={t.flightprep.hhmmPlaceholder}
							value={flightPrep.dossier.potentialMin != null
								? fmtHHMM(flightPrep.dossier.potentialMin)
								: ''}
							use:printValue={flightPrep.dossier.potentialMin != null
								? fmtHHMM(flightPrep.dossier.potentialMin)
								: ''}
							onchange={onPotential}
						/>
					</label>
				</div>
				{@render checklist('documents')}
			</div>
		</div>
	</section>

	<div class="two-col">
		<div class="col">
			{#if dossier.trips.length === 0}
				<p class="muted">{t.flightprep.planRouteTimeline}</p>
			{:else}
				<table class="fp-table grid">
					<thead>
						<tr>
							<th class="rowhead">{t.flightprep.trips}</th>
							{#each chain as _e, j (j)}
								<th title={j === 0 ? t.flightprep.airportDeparture : t.flightprep.airportN(j + 1)}>{j === 0 ? t.flightprep.airportDeparture : t.flightprep.airportN(j + 1)}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						<tr class="idents">
							<th class="rowhead"></th>
							{#each chain as e, j (j)}
								<td>{e.label}</td>
							{/each}
						</tr>
						<tr>
							<th class="rowhead" title={t.flightprep.etaTip}>{t.flightprep.etaHeader}</th>
							{#each chain as _e, j (j)}
								<td
									class="lt"
									class:danger={timeline != null &&
										j >= 1 &&
										afterSunset(timeline.arrivalsMin[j - 1], j)}
								>
									{#if j >= 1 && timeline}
										{fmtClock(timeline.arrivalsMin[j - 1])}
										<span class="local">{localClock(timeline.arrivalsMin[j - 1])} LT</span>
									{:else}
										&nbsp;<span class="local">&nbsp;</span>
									{/if}
								</td>
							{/each}
						</tr>
						<tr class="ground">
							<th class="rowhead" title={t.flightprep.groundTimeTip}>
								{t.flightprep.groundTime}
							</th>
							{#each chain as _e, j (j)}
								<td>
									{#if j >= 1 && j < chain.length - 1}
										<!-- The stop at chain column j belongs to the trip
										     arriving there; key by its stable trip index
										     (stopsMin alignment), not the chain position: a
										     non-computable trip drops out of the chain. -->
										{@const ti = dossier.trips[j - 1].tripIndex}
										<input
											class="num"
											type="text"
											inputmode="numeric"
											placeholder="00:00"
											value={stopText(ti)}
											onchange={(e) => onStop(e, ti)}
										/><span class="print-value"
											>{fmtHHMM(dossierStopMin(ti) ?? 0)}</span
										>
									{/if}
								</td>
							{/each}
						</tr>
						<tr>
							<th class="rowhead" title={t.flightprep.etdTip}>{t.flightprep.etdHeader}</th>
							{#each chain as _e, j (j)}
								<td class="lt">
									{#if j === 0}
										<input
											class="time"
											type="text"
											inputmode="numeric"
											autocomplete="off"
											maxlength="5"
											aria-label={t.flightprep.etdHeader}
											value={flightPrep.dossier.departureTime ?? ''}
											use:printValue={flightPrep.dossier.departureTime ?? ''}
											onchange={onEtd}
										/>
										{#if departureMin != null}
											<span class="local">{localClock(departureMin)} LT</span>
										{:else}
											<span class="local">&nbsp;</span>
										{/if}
									{:else if j < chain.length - 1 && timeline}
										{fmtClock(timeline.departuresMin[j])}
										<span class="local">{localClock(timeline.departuresMin[j])} LT</span>
									{:else}
										&nbsp;<span class="local">&nbsp;</span>
									{/if}
								</td>
							{/each}
						</tr>
						{#if loads}
							<!-- The fuel each departure takes off with, the uplift under
							     it where what is on board is known (a refuelled stop, the
							     departure over its journey log); short in the danger ink,
							     the departure's reading as its title. -->
							<tr>
								<th class="rowhead wrapped">{t.flightprep.rowFuelAtTakeoff}</th>
								{#each chain as _e, j (j)}
									{@const tr = j < chain.length - 1 ? tripLoad(j) : null}
									{@const up =
										tr && tr.target !== null
											? (takeoffWindow(tr, loads.aircraft.fuel?.usableL ?? 0)?.planUpliftL ?? null)
											: null}
									<td
										class="lt"
										class:danger={tr?.sufficient === false}
										title={tr?.chainIndex === 0 ? onBoardCell(loads).title : undefined}
									>
										{#if tr}
											{tr.startL !== null ? load1(tr.startL) : '—'}
											<span class="local"
												>{#if up !== null && up > 0}{t.flightprep.upliftShort(String(up))}{:else}&nbsp;{/if}</span
											>
										{:else}
											&nbsp;<span class="local">&nbsp;</span>
										{/if}
									</td>
								{/each}
							</tr>
						{/if}
						{#if showProcedure}
							<!-- What each departure is flown with: the procedure in its
							     ink over its flaps, the words wrapping rather than
							     clipped (the left column, which the right one outgrows
							     on paper). No flaps line when there are none to show,
							     so a wrapped "none fits" grows no empty third line. -->
							<tr class="procedure">
								<th class="rowhead" title={t.flightprep.takeoffProcedureTip}>
									{t.flightprep.takeoffProcedure}
								</th>
								{#each chain as _e, j (j)}
									{@const col = j < chain.length - 1 ? (takeoffs[j] ?? null) : null}
									{#if col}
										{@const [word, flaps] = procedureLines(col.pick)}
										<td class="lt {procedureCellInk(col)}" title={procedureTitle(col)}>
											{word}{#if flaps}<span class="local">{flaps}</span>{/if}
										</td>
									{:else}
										<td class="lt">&nbsp;<span class="local">&nbsp;</span></td>
									{/if}
								{/each}
							</tr>
						{/if}
					</tbody>
				</table>

				<table class="fp-table grid">
					<tbody>
						<tr>
							<th class="rowhead" title={t.flightprep.sunriseTip}>
								{t.flightprep.sunrise}
							</th>
							{#each sun as s, j (j)}
								{@const e = s?.sunrise}
								<td class="lt">
									{sunText(e)}
									{#if e?.kind === 'time'}
										<span class="local">{localClock(e.minutesUtc)} LT</span>
									{/if}
								</td>
							{/each}
						</tr>
						<tr>
							<th class="rowhead" title={t.flightprep.sunsetTip}>
								{t.flightprep.sunset}
							</th>
							{#each sun as s, j (j)}
								{@const e = s?.sunset}
								<td class="lt">
									{sunText(e)}
									{#if e?.kind === 'time'}
										<span class="local">{localClock(e.minutesUtc)} LT</span>
									{/if}
								</td>
							{/each}
						</tr>
					</tbody>
				</table>

				<table class="fp-table grid">
					<thead>
						<tr>
							<th class="rowhead">{t.flightprep.alternates}</th>
							{#each chain as _e, j (j)}
								<th>{j >= 1 ? t.flightprep.alternateN(j + 1) : ''}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						<tr class="idents">
							<th class="rowhead"></th>
							{#each chain as _e, j (j)}
								<td>{j >= 1 ? (dossier.trips[j - 1].alternate?.label ?? t.flightprep.none) : ''}</td>
							{/each}
						</tr>
						<tr>
							<th class="rowhead" title={t.flightprep.altEtaTip}>
								{t.flightprep.etaHeader}
							</th>
							{#each chain as _e, j (j)}
								{@const altMin = j >= 1 && timeline ? timeline.alternateArrivalsMin[j - 1] : null}
								<td
									class="lt"
									class:danger={altMin != null && afterSunset(altMin, j)}
								>
									{#if altMin != null}
										{fmtClock(altMin)}
										<span class="local">{localClock(altMin)} LT</span>
									{:else}
										&nbsp;<span class="local">&nbsp;</span>
									{/if}
								</td>
							{/each}
						</tr>
					</tbody>
				</table>

				<!-- One limit per arrival, off that trip's own fuel at takeoff: in
				     the danger ink only when its ETA or its alternate's passes it
				     (the sunset tint stays on the ETA cells). -->
				<table class="fp-table grid">
					<tbody>
						<tr>
							<th class="rowhead wrapped" title={t.flightprep.enduranceLimitTip}>
								{t.flightprep.enduranceLimit}
							</th>
							{#each chain as _e, j (j)}
								{@const limit = j >= 1 && timeline ? (timeline.fuelLimitsMin[j - 1] ?? null) : null}
								{@const alt = j >= 1 && timeline ? timeline.alternateArrivalsMin[j - 1] : null}
								<td
									class="limitcell lt"
									class:danger={limit != null &&
										timeline != null &&
										(timeline.arrivalsMin[j - 1] > limit || (alt != null && alt > limit))}
								>
									{#if limit != null}
										{fmtClock(limit)}
										<span class="local">{localClock(limit)} LT</span>
									{:else}
										&nbsp;<span class="local">&nbsp;</span>
									{/if}
								</td>
							{/each}
						</tr>
					</tbody>
				</table>
				<p class="muted">
					{#if timeline?.fuelLimitMin != null || timeline?.fuelLimitsMin.some((l) => l != null)}
						{t.flightprep.reserveKept({
							min: dossier.finalReserveMin,
							dayNight: fuel.night ? t.flightprep.night : t.flightprep.day,
						})}
					{:else if !timeline}
						{t.flightprep.setEtd}
					{/if}
				</p>
				{#each shortTrips as who, i (i)}
					<p class="short">{t.flightprep.overviewShortTrip(who)}</p>
				{/each}
			{/if}
		</div>

		<div class="col">
			<section class="box">
				<!-- The briefing link rides the heading's row: this column is
				     the taller on paper, and a line of its own cost the sheet
				     16 px. -->
				<div class="box-head">
					<h3>{t.flightprep.secWeather}</h3>
					<p class="muted">
						{t.flightprep.wxBriefingOn}
						<!-- i18n-ignore: Aéroweb is a Météo-France product name, invariant -->
						<a href="https://aviation.meteo.fr/" target="_blank" rel="noopener noreferrer">Aéroweb</a>.
					</p>
				</div>
				<!-- What the plan flies with, stated: each value is set where it
				     acts (Change brings up the Route tab's wind switch), and paper
				     prints the same cells. -->
				<table class="fp-table wx-state">
					<thead>
						<tr>
							<th>{t.flightprep.wxWindHead}</th>
							<th>{t.flightprep.wxQnhHead}</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td>
								{@render boxLines(windLines)}
								<button class="link-btn no-print" title={t.flightprep.wxChangeWindTip} onclick={requestRouteWindSwitch}
									>{t.flightprep.wxChangeWind}</button
								>
							</td>
							<td>{@render boxLines(qnhLines)}</td>
						</tr>
					</tbody>
				</table>
				<div class="wx-cols">
					{@render checklist('weather')}
					<div>
						<h4>{t.flightprep.threeRs}</h4>
						{@render checklist('threeR')}
					</div>
				</div>
				<ul class="notes">
					<li>{t.flightprep.wxNote1}</li>
					<li>{t.flightprep.wxNote2}</li>
				</ul>
			</section>

			<section class="box">
				<h3>{t.flightprep.secNotam}</h3>
				<ul class="notes">
					<li>{t.flightprep.notamNote1}</li>
					<li>{t.flightprep.notamNote2}</li>
					<li>{t.flightprep.notamNote3}</li>
				</ul>
			</section>

			<section class="box">
				<h3>{t.flightprep.secCharts}</h3>
				{@render checklist('charts')}
			</section>
		</div>
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 12px;

		/* The shared workbook .num (styles/workbook.css) at this page's
		   column width. */
		--num-w: 64px;
	}

	.chain {
		font-size: 15px;
		font-weight: 700;
	}

	/* The printed sheet's framed sections. */
	.box {
		border: 2px solid var(--border-strong);
		padding: 8px 10px 10px;
	}

	.box h3 {
		margin: 0 0 8px;
		font-size: 12.5px;
	}

	.box h4 {
		margin: 0 0 4px;
		font-size: 12px;
	}

	/* A heading with a note on its row (box B's briefing link), the note
	   wrapping under it only where the box is too narrow for both, at the
	   heading's line height so the row is no taller than the heading. */
	.box-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0 12px;
		margin-bottom: 8px;
	}

	.box-head h3 {
		margin: 0;
	}

	.box-head .muted {
		line-height: inherit;
	}

	.cols {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px 24px;
	}

	.two-col {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
		align-items: start;
	}

	.col {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
	}

	/* Width-driven on purpose (NOT the mobile-ui class), and against the
	   SURFACE box rather than the window: flight preparation is as wide as
	   the stage leaves it, so a viewport query kept two columns in a box far
	   too narrow for them and the right one ran off the edge. The container
	   is FlightPrepModal's .body; printing has none, so the columns stay
	   side by side on paper. */
	@container (width <= 760px) {
		.cols,
		.two-col {
			grid-template-columns: 1fr;
		}
	}

	.fields {
		display: flex;
		flex-direction: column;
		gap: 4px;
		align-items: flex-start;
		margin-bottom: 8px;
	}

	.field {
		display: grid;
		grid-template-columns: 110px auto;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
	}

	.field > span:first-child {
		color: var(--text-muted);
	}

	.field input {
		background: var(--surface-2);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 3px 6px;
		font: inherit;
	}

	.field input.danger {
		border-color: var(--danger);
		color: var(--danger);
	}

	/* A duration reads as a clock, so it is centred like the ETD box rather
	   than hugging the left edge of a field sized for a name, and only as
	   wide as the hundreds of hours a potentiel runs to (xxx:xx). */
	.field input.hhmm {
		width: 6em;
		text-align: center;
	}

	/* Denser than the shared 13px .fp-page .muted; the .page hop outranks
	   it, so this page's notes stay 12.5px regardless of bundle order. */
	.page .muted {
		font-size: 12.5px;
		color: var(--text-muted);
		margin: 0;
	}

	.page a {
		color: var(--accent);
		text-decoration: none;
	}

	.page a:hover {
		text-decoration: underline;
	}

	.checks {
		list-style: none;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 2px 16px;
		margin: 0;
		padding: 0;
	}

	.checks label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		cursor: pointer;
	}

	.checks input,
	.wx-cols input {
		accent-color: var(--accent);
	}

	.notes {
		margin: 6px 0 0;
		padding-left: 18px;
		font-size: 12.5px;
		color: var(--text-muted);
	}

	/* On the shared workbook .fp-table (styles/workbook.css); this page's
	   cells also ellipsize, and its .grid tables share one fixed column
	   layout so the trips / sunset / alternates strips align like the
	   printed sheet. */
	.fp-table.grid {
		table-layout: fixed;
	}

	.fp-table th,
	.fp-table td {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.fp-table.grid th,
	.fp-table.grid td {
		padding: 3px 6px;
	}

	.fp-table.grid thead th {
		font-size: 11.5px;
	}

	.fp-table.grid .rowhead {
		width: 132px;
	}

	/* FR escape hatch (measured overflow, docs/i18n.md): "Coucher du soleil
	   (UTC)" ellipsizes in the shared 132px legend, so the French grid
	   legend widens; every .grid table shares it, keeping the strips
	   aligned. */
	:global([lang='fr']) .fp-table.grid .rowhead {
		width: 148px;
	}

	/* The fuel and endurance rows' labels wrap rather than clip: their cells
	   are two lines already (the figure, the local time or the uplift under
	   it), so a second label line costs the row nothing, where the grid's
	   118 px print legend cut "Endurance limit (…" and "Carburant au
	   décollage …". */
	.fp-table.grid th.rowhead.wrapped {
		white-space: normal;
		text-overflow: clip;
	}

	/* A time cell stacks the browser-local time under the UTC value. */
	td.lt .local {
		display: block;
		font-size: 11px;
	}

	tr.idents td {
		font-weight: 600;
		background: var(--surface-2);
	}

	.limitcell {
		font-weight: 700;
	}

	td.danger {
		color: var(--danger);
		font-weight: 700;
	}

	td.danger .local {
		color: var(--danger);
	}

	/* A short trip, said under the limits it breaks. */
	p.short {
		margin: 2px 0 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--danger);
	}

	/* The take-off procedure is a decision, never a clipped word: in a narrow
	   column (six trips leave about 58 px on paper) "Aucune ne convient" and
	   "Terrain court" wrap where every other cell ellipsizes, and so does the
	   row's own label on a narrow screen. */
	.fp-table.grid tr.procedure th,
	.fp-table.grid tr.procedure td {
		white-space: normal;
		overflow-wrap: anywhere;
		text-overflow: clip;
	}

	/* On the shared workbook .num (width from --num-w above); only this
	   page lets a crowded cell shrink it. */
	.num {
		max-width: 100%;
	}

	/* An input inherits none of its cell's alignment, and on paper the span
	   that replaces it takes the cell's own right, so the ground-time row
	   states centred for both: its clocks then read like the ETD's, on screen
	   and on the sheet alike. */
	.fp-table.grid tr.ground td,
	.fp-table.grid tr.ground .num {
		text-align: center;
	}

	.time {
		width: 5em;
		max-width: 100%;
		background: var(--surface-2);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 2px 4px;
		font: inherit;
		text-align: center;
	}

	.local {
		color: var(--text-muted);
		font-weight: 400;
	}

	/* The weather box's two cells STATE what the plan uses, a line per fact.
	   The .fp-table hop outranks the shared right-aligned workbook cell
	   (.fp-page .fp-table td, styles/workbook.css) whatever the bundle
	   order. The layout is FIXED and the lines wrap: the automatic layout
	   sized the table to its longest unbroken line, and a French missed-legs
	   line printed it 117 px past its box. Each line is worded to fit its
	   column on paper (the QNH's longest source, "par défaut, ni METAR ni
	   prévision", holds in its 40 %). */
	.fp-table.wx-state {
		width: 100%;
		table-layout: fixed;
	}

	.fp-table.wx-state th:first-child {
		width: 60%;
	}

	.fp-table.wx-state th,
	.fp-table.wx-state td {
		text-align: left;
		vertical-align: top;
		white-space: normal;
		text-overflow: clip;
	}

	.box-line {
		display: block;
	}

	.box-line.muted {
		font-size: 11px;
		color: var(--text-muted);
	}

	.box-line.manual,
	.part.manual {
		color: var(--workbook-orange);
	}

	.link-btn {
		padding: 0;
		margin-top: 2px;
		font: inherit;
		font-size: 11px;
		color: var(--accent);
		background: transparent;
		border: 0;
		text-decoration: underline;
		cursor: pointer;
	}


	.wx-cols {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px 16px;
		margin-top: 8px;
	}

	.wx-cols .checks {
		grid-template-columns: 1fr;
	}

	@media print {
		/* The sheet's height must not depend on the platform's own face.
		   Nothing else sets a line box, so every line was as tall as the
		   system-ui font asks: Adwaita Sans 1.21 em on a GNOME desktop,
		   Segoe UI 1.33 em on Windows. That was 29 px more on a sheet with
		   16 px to spare, and a Windows PC printed it on two sheets. Pinned
		   here, every face prints at one pitch, close to the home one; the
		   notes keep their own 1.5 (app.css .muted). Unitless, so each size
		   (the 13 px route line, the 9 px local times) scales its own. */
		.page {
			gap: 8px;
			line-height: 1.2;
		}

		.box,
		section,
		.fp-table {
			break-inside: avoid;
		}

		/* Headroom. A route line that wraps costs 16 px, Android's print
		   margins about 11: these trims keep at least 40 px free on A4
		   landscape in both engines, both languages and every face measured,
		   with box B's wind cell at its four lines (a six-trip plan, its
		   forecast missing legs, legs with their own wind). The right column
		   (B, C, D) is the tallest, so they take the most; the bottom padding
		   and the column gap went from 7 to 5 px for the 12 px the weather
		   lines needed. */
		.box {
			padding: 6px 10px 5px;
		}

		.box h3,
		.box-head {
			margin-bottom: 5px;
		}

		.box-head h3 {
			margin-bottom: 0;
		}

		.col {
			gap: 5px;
		}

		.wx-cols {
			margin-top: 5px;
		}

		.notes {
			margin-top: 4px;
		}

		.chain {
			font-size: 13px;
		}

		/* The .page hop outranks the shared workbook sizes (.fp-page
		   .fp-table / .muted, styles/workbook.css) and this page's own
		   12.5px .page .muted whatever the bundle order (within this
		   sheet the print block still comes last). */
		.page .fp-table,
		.page .field,
		.page .checks label,
		.page .notes,
		.page .muted {
			font-size: 10.5px;
		}

		.fp-table.grid thead th {
			font-size: 10px;
		}

		.fp-table.grid th,
		.fp-table.grid td {
			padding: 2px 4px;
		}

		.fp-table.grid .rowhead {
			width: 118px;
		}

		/* The grid's paper inset: the weather lines keep each fact on one
		   line in the widest face measured (Chromium's system-ui here is
		   Bitstream Vera, 5 % wider than Firefox's Adwaita Sans). */
		.fp-table.wx-state th,
		.fp-table.wx-state td {
			padding-inline: 4px;
		}

		td.lt .local {
			font-size: 9px;
		}

		.cols {
			grid-template-columns: 1fr 1fr;
		}

		/* On paper the two columns are a flex row, not a grid. Firefox moves
		   a grid row that cannot finish on its page to the next one whole,
		   so a few pixels over printed box A alone on the first sheet and
		   the rest on a second; in a flex row each column breaks on its own
		   and only the last box moves, which is what Chromium does with
		   either. The screen keeps its grid, whose @container collapse is
		   written for one; that query never matches on paper. */
		.two-col {
			display: flex;
			align-items: flex-start;
		}

		.two-col > .col {
			flex: 1 1 0;
		}
	}
</style>
