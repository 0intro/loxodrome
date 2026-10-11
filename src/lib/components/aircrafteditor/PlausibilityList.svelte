<script lang="ts">
	/* The figures to check on a page (aircraft/plausibility.ts), worded where
	 * they were typed: a short list in the workbook's orange, under the
	 * readings it concerns, that never blocks a save. Each line names the cell
	 * the way the grid shows it (table, altitude, column, mass row). */

	import type {
		DistanceMetric,
		GridCell,
		MetricTableRef,
		PlausibilityWarning,
		TableMass,
	} from '$lib/aircraft/plausibility';
	import type { PerfPhase } from '$lib/aircraft/performance';
	import { t } from '$lib/state/i18n.svelte';

	let { warnings }: { warnings: PlausibilityWarning[] } = $props();

	// A transposed cell trips its neighbours too: past this many lines the
	// rest is counted, so the list stays a pointer, never a wall.
	const SHOWN = 8;

	function table(phase: PerfPhase): string {
		return phase === 'takeoff' ? t.aircraft.takeoffDistances : t.aircraft.landingDistances;
	}

	function column(axis: GridCell['axis'], tempC: number): string {
		return axis === 'oat' ? t.aircraft.checkOat(tempC) : t.aircraft.checkIsa(tempC);
	}

	function mass(m: TableMass): string {
		return m === 'max' ? t.aircraft.checkMassMax : t.aircraft.checkMassMin;
	}

	function metric(m: DistanceMetric): string {
		return m === 'roll' ? t.aircraft.checkRoll : t.aircraft.checkD15;
	}

	function metricTable(m: MetricTableRef): string {
		return m === 'asd' ? t.aircraft.checkTableAsd : m === 'climb' ? t.aircraft.checkTableClimb : t.aircraft.checkTableTakeoffClimb;
	}

	function config(c: { phase: PerfPhase; flapsDeg: number }): string {
		return t.aircraft.cfgTitle({
			phase: c.phase === 'takeoff' ? t.aircraft.takeoff : t.aircraft.landing,
			flaps: String(c.flapsDeg),
		});
	}

	function text(w: PlausibilityWarning): string {
		switch (w.kind) {
			case 'grid-falls': {
				const at = { table: table(w.cell.phase), alt: w.cell.altFt, col: column(w.cell.axis, w.cell.tempC) };
				return t.aircraft.checkGridFalls({
					...at,
					mass: mass(w.mass),
					metric: metric(w.metric),
					to: w.toM,
					fromPlace: w.along === 'altitude' ? `${w.fromAltFt} ft` : column(w.cell.axis, w.fromTempC),
					from: w.fromM,
				});
			}
			case 'grid-roll-long':
				return t.aircraft.checkGridRollLong({
					table: table(w.cell.phase),
					alt: w.cell.altFt,
					col: column(w.cell.axis, w.cell.tempC),
					mass: mass(w.mass),
					roll: w.rollM,
					d15: w.d15M,
				});
			case 'grid-min-long':
				return t.aircraft.checkGridMinLong({
					table: table(w.cell.phase),
					alt: w.cell.altFt,
					col: column(w.cell.axis, w.cell.tempC),
					metric: metric(w.metric),
					min: w.minM,
					max: w.maxM,
				});
			case 'table-mass-above-envelope':
				return t.aircraft.checkTableMass({ mass: w.massMaxKg, top: w.envelopeTopKg });
			case 'fit-falls':
				return w.along === 'temperature'
					? t.aircraft.checkFitFallsTemp({ config: config(w.config), metric: metric(w.metric), alt: w.altFt })
					: t.aircraft.checkFitFallsAlt({ config: config(w.config), metric: metric(w.metric), temp: w.tempC });
			case 'fit-roll-long':
				return t.aircraft.checkFitRollLong({ config: config(w.config), alt: w.altFt, temp: w.tempC });
			case 'fit-not-positive':
				return t.aircraft.checkFitNotPositive({ config: config(w.config), metric: metric(w.metric), alt: w.altFt, temp: w.tempC });
			case 'envelope-crosses':
				return t.aircraft.checkEnvelopeCrosses;
			case 'metric-wrong-way': {
				const p = {
					table: metricTable(w.cell.table),
					alt: w.cell.altFt,
					col: column(w.cell.axis, w.cell.tempC),
					mass: mass(w.mass),
					to: w.to,
					fromPlace: w.along === 'altitude' ? `${w.fromAltFt} ft` : column(w.cell.axis, w.fromTempC),
					from: w.from,
				};
				return w.cell.table === 'asd' ? t.aircraft.checkMetricFalls(p) : t.aircraft.checkClimbRises(p);
			}
			case 'metric-mass-wrong-way': {
				const p = {
					table: metricTable(w.cell.table),
					alt: w.cell.altFt,
					col: column(w.cell.axis, w.cell.tempC),
					min: w.min,
					max: w.max,
				};
				return w.cell.table === 'asd' ? t.aircraft.checkMetricMinLong(p) : t.aircraft.checkClimbMinLow(p);
			}
			case 'metric-mass-above-envelope':
				return t.aircraft.checkMetricMass({ table: metricTable(w.table), mass: w.massMaxKg, top: w.envelopeTopKg });
			case 'vmc-not-below-vyse':
				return t.aircraft.checkVmcVyse({ vmc: w.vmcKt, vyse: w.vyseKt });
			case 'asd-short':
				return t.aircraft.checkAsdShort({ asd: w.asdM, roll: w.rollM });
		}
	}
</script>

{#if warnings.length > 0}
	<div class="checks">
		<h6>{t.aircraft.checksHead}</h6>
		<ul>
			{#each warnings.slice(0, SHOWN) as w, i (i)}
				<li>{text(w)}</li>
			{/each}
		</ul>
		{#if warnings.length > SHOWN}
			<p>{t.aircraft.checksMore(warnings.length - SHOWN)}</p>
		{/if}
	</div>
{/if}

<style>
	/* The workbook's orange, as an extrapolated reading: look again, nothing
	   is refused. On the measure of the page's prose. */
	.checks {
		max-inline-size: var(--measure);
		color: var(--workbook-orange);
		font-size: 12px;
		line-height: 1.45;
	}

	h6 {
		margin: 0 0 2px;
		font-size: 12px;
		font-weight: 600;
	}

	ul {
		margin: 0;
		padding-inline-start: 18px;
	}

	p {
		margin: 2px 0 0;
	}
</style>
