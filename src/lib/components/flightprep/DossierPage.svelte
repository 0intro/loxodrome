<script lang="ts">
	/* The Overview page, a port of the workbook's "Dossier" front sheet and
	 * laid out like its print: the framed A) administrative box on top, then
	 * two columns; left the trips timeline (ETA / ground time / ETD
	 * in the sheet's row order), the sunrise/sunset strip (computed from the
	 * flight date), the alternates and the endurance-limit strip; right the
	 * weather, NOTAM and charts boxes. All wall-clock times are UTC with the
	 * browser's local time stacked underneath. The wind inputs are the Route
	 * tab's (shared state); the QNH input is the performance page's
	 * default. */

	import { routeSettings } from '$lib/state/route.svelte';
	import {
		flightPrep,
		dossierFlightDate,
		dossierStopMin,
		dossierCheck,
		setDossier,
		setDossierPilot,
		setDossierStop,
		setDossierCheck,
	} from '$lib/state/flightPrep.svelte';
	import { selectedAircraft } from '$lib/state/aircraft.svelte';
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
	import { fuelComputation, mbComputation, dossierComputation, fmtL, fmtHHMM } from './shared';
	import { printValue } from '$lib/ui/printValue';
	import { normalizeClock24 } from '$lib/format/datetime';
	import { t } from '$lib/state/i18n.svelte';

	const aircraft = $derived(selectedAircraft());
	const fuel = $derived(fuelComputation());
	const mb = $derived(mbComputation(fuel));
	const dossier = $derived(dossierComputation(fuel, mb));
	const chain = $derived(dossierChain(dossier.trips));
	const flightDate = $derived(dossierFlightDate());
	const departureMin = $derived(parseClock(flightPrep.dossier.departureTime ?? ''));
	const timeline = $derived(
		departureMin != null && dossier.trips.length > 0
			? computeDossierTimeline(dossier.trips, {
					departureMin,
					fuelOnBoardMin: dossier.fuelOnBoardMin,
					finalReserveMin: dossier.finalReserveMin,
				})
			: null,
	);
	const sun = $derived(chain.map((e) => sunTimesUtc(e.lat, e.lon, flightDate)));

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

	function numOrNull(e: Event): number | null {
		const v = Number.parseFloat((e.target as HTMLInputElement).value);
		return Number.isFinite(v) && v > 0 ? v : null;
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

	// Wind: the Route tab's handlers verbatim (shared routeSettings state).
	function onWindDir(e: Event): void {
		const s = text(e).trim();
		if (s === '') {
			routeSettings.windDirDeg = null;
			return;
		}
		const v = Number.parseFloat(s);
		routeSettings.windDirDeg = Number.isFinite(v) && v >= 0 && v <= 360 ? v : null;
	}

	function onWindSpeed(e: Event): void {
		const s = text(e).trim();
		if (s === '') {
			routeSettings.windSpeedKt = null;
			return;
		}
		const v = Number.parseFloat(s);
		routeSettings.windSpeedKt = Number.isFinite(v) && v >= 0 ? v : null;
	}
</script>

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
					<label class="field" title={t.flightprep.flightDateTip}>
						<span>{t.flightprep.flightDate}</span>
						<input
							type="date"
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
							<strong>{aircraft.identity.registration ?? aircraft.identity.type}</strong>
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
						<tr>
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

				<!-- Shares the grid geometry (colgroup = rowhead + chain columns)
				     so the value cell sits exactly under the last two
				     aerodrome columns, the label spanning the rest. -->
				<table class="fp-table grid">
					<colgroup>
						<col class="headcol" />
						{#each chain as _e, j (j)}
							<col />
						{/each}
					</colgroup>
					<tbody>
						<tr>
							<th
								class="rowhead"
								colspan={chain.length - 1}
								title={t.flightprep.enduranceLimitTip}
							>
								{t.flightprep.enduranceLimit}
							</th>
							<td
								class="limitcell lt"
								colspan={2}
								class:danger={timeline?.fuelLimitMin != null &&
									afterSunset(timeline.fuelLimitMin, chain.length - 1)}
							>
								{#if timeline?.fuelLimitMin != null}
									{fmtClock(timeline.fuelLimitMin)}
									<span class="local">{localClock(timeline.fuelLimitMin)} LT</span>
								{:else}
									&nbsp;<span class="local">&nbsp;</span>
								{/if}
							</td>
						</tr>
					</tbody>
				</table>
				<p class="muted">
					{#if timeline?.fuelLimitMin != null}
						{#if dossier.fuelFromMb && mb}
							{t.flightprep.onBoardMb(fmtL(mb.fuelL))}
						{:else}
							{t.flightprep.onPlanMinimum}
						{/if}
						{t.flightprep.reserveKept({
							min: dossier.finalReserveMin,
							dayNight: fuel.night ? t.flightprep.night : t.flightprep.day,
						})}
					{:else}
						{t.flightprep.setEtd}
					{/if}
				</p>
			{/if}
		</div>

		<div class="col">
			<section class="box">
				<h3>{t.flightprep.secWeather}</h3>
				<p class="muted">
					{t.flightprep.wxBriefingOn}
					<!-- i18n-ignore: Aéroweb is a Météo-France product name, invariant -->
					<a href="https://aviation.meteo.fr/" target="_blank" rel="noopener noreferrer">Aéroweb</a>.
				</p>
				<table class="fp-table wind">
					<thead>
						<tr>
							<th title={t.flightprep.windSharedTip}>
								{t.flightprep.windSpeedKt}
							</th>
							<th title={t.flightprep.windSharedTip}>
								{t.flightprep.windDirDeg}
							</th>
							<th title={t.flightprep.qnhDefaultTip}>
								QNH (hPa)
							</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td>
								<input
									class="num"
									type="number"
									min="0"
									step="1"
									aria-label={t.flightprep.windSpeedKt}
									value={routeSettings.windSpeedKt ?? ''}
									use:printValue={routeSettings.windSpeedKt ?? ''}
									oninput={onWindSpeed}
								/>
							</td>
							<td>
								<input
									class="num"
									type="number"
									min="0"
									max="360"
									step="5"
									aria-label={t.flightprep.windDirDeg}
									value={routeSettings.windDirDeg ?? ''}
									use:printValue={routeSettings.windDirDeg ?? ''}
									oninput={onWindDir}
								/>
							</td>
							<td>
								<!-- The standard is the value in force until one is typed, so
								     the box shows it as a placeholder like every other automatic
								     value (the spinner steps from it, ui/numberStepAnchor);
								     neither a placeholder nor an empty input prints, so the
								     static value carries the number onto the sheet. -->
								<input
									class="num"
									type="number"
									min="900"
									max="1100"
									step="1"
									aria-label="QNH (hPa)"
									value={flightPrep.dossier.qnhHpa ?? ''}
									placeholder="1013"
									oninput={(e) => setDossier({ qnhHpa: numOrNull(e) })}
								/><span class="print-value">{flightPrep.dossier.qnhHpa ?? 1013}</span>
							</td>
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

	/* The limit strip's colgroup mirror of the rowhead column; its spanning
	   label must not size columns itself (higher specificity than the
	   screen and print rowhead widths). */
	.fp-table.grid col.headcol {
		width: 132px;
	}

	/* FR escape hatch (measured overflow, docs/i18n.md): "Coucher du soleil
	   (UTC)" ellipsizes in the shared 132px legend, so the French grid
	   legend widens; every .grid table shares it, keeping the strips
	   aligned. Kept before the [colspan] rule so the limit strip's auto
	   width still wins. */
	:global([lang='fr']) .fp-table.grid .rowhead,
	:global([lang='fr']) .fp-table.grid col.headcol {
		width: 148px;
	}

	.fp-table.grid .rowhead[colspan] {
		width: auto;

		/* The endurance-limit label is longer than its spanned columns at the
		   default panel width: let it wrap instead of ellipsizing (the fixed
		   grid keeps the value cell aligned either way). */
		white-space: normal;
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

	/* On the shared workbook .num (width from --num-w above); only this
	   page lets a crowded cell shrink it. */
	.num {
		max-width: 100%;
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

	.wind {
		max-width: 320px;
	}

	/* The .fp-table hop outranks the shared right-aligned workbook cell
	   (.fp-page .fp-table td, styles/workbook.css) whatever the bundle
	   order. */
	.fp-table.wind td {
		text-align: center;
	}

	/* The Météo inputs (wind speed / direction / QNH) a touch larger than the
	   default .num and all the same width. */
	.wind .num {
		width: 84px;
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
		.page {
			gap: 8px;
		}

		.box,
		section,
		.fp-table {
			break-inside: avoid;
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

		.fp-table.grid col.headcol {
			width: 118px;
		}

		td.lt .local {
			font-size: 9px;
		}

		.cols,
		.two-col {
			grid-template-columns: 1fr 1fr;
		}

	}
</style>
