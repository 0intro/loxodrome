<script lang="ts">
	import type { AboutMeta } from '$lib/data/aboutMeta';
	import { fmtInt } from '$lib/state/i18n.svelte';

	const fmtNumber = (n: number | undefined): string =>
		n == null ? '–' : fmtInt(n);

	// Rendered only behind AboutModal's `import.meta.env.DEV` gate, so meta
	// is always present here.
	interface Props {
		meta: AboutMeta;
	}
	let { meta }: Props = $props();
</script>

<!-- i18n-ignore-start: dev-only diagnostics (rendered only behind AboutModal's import.meta.env.DEV gate) -->
<table class="diag-table">
	<thead>
		<tr>
			<th>Publisher</th>
			<th>Dataset</th>
			<th class="num" title="features missing horizontalProjection / boundary">no-bnd</th>
			<th class="num" title="features missing type">no-type</th>
			<th class="num" title="features outside BASELINE timeslice">non-base</th>
			<th class="num" title="xlink:href targets not resolved in this file">unres-xlink</th>
		</tr>
	</thead>
	<tbody>
		{#if meta.aixm.uk.airspaces}
			<tr>
				<td>UK</td>
				<td>airspaces</td>
				<td class="num" class:warn={meta.aixm.uk.airspaces.skippedNoBoundary > 0}>{fmtNumber(meta.aixm.uk.airspaces.skippedNoBoundary)}</td>
				<td class="num" class:warn={meta.aixm.uk.airspaces.skippedNoType > 0}>{fmtNumber(meta.aixm.uk.airspaces.skippedNoType)}</td>
				<td class="num" class:warn={meta.aixm.uk.airspaces.skippedNonBaseline > 0}>{fmtNumber(meta.aixm.uk.airspaces.skippedNonBaseline)}</td>
				<td class="num" class:warn={meta.aixm.uk.airspaces.unresolvedXlinks > 0}>{fmtNumber(meta.aixm.uk.airspaces.unresolvedXlinks)}</td>
			</tr>
		{/if}
		{#if meta.aixm.uk.obstacles}
			<tr>
				<td>UK</td>
				<td>obstacles</td>
				<td class="num">–</td>
				<td class="num">–</td>
				<td class="num" class:warn={meta.aixm.uk.obstacles.skippedNonBaseline > 0}>{fmtNumber(meta.aixm.uk.obstacles.skippedNonBaseline)}</td>
				<td class="num">–</td>
			</tr>
		{/if}
		{#if meta.aixm.es.airspaces}
			<tr>
				<td>ES</td>
				<td>airspaces</td>
				<td class="num" class:warn={meta.aixm.es.airspaces.skippedNoBoundary > 0}>{fmtNumber(meta.aixm.es.airspaces.skippedNoBoundary)}</td>
				<td class="num" class:warn={meta.aixm.es.airspaces.skippedNoType > 0}>{fmtNumber(meta.aixm.es.airspaces.skippedNoType)}</td>
				<td class="num" class:warn={meta.aixm.es.airspaces.skippedNonBaseline > 0}>{fmtNumber(meta.aixm.es.airspaces.skippedNonBaseline)}</td>
				<td class="num" class:warn={meta.aixm.es.airspaces.unresolvedXlinks > 0}>{fmtNumber(meta.aixm.es.airspaces.unresolvedXlinks)}</td>
			</tr>
		{/if}
		{#if meta.aixm.es.obstacles}
			<tr>
				<td>ES</td>
				<td>obstacles</td>
				<td class="num">–</td>
				<td class="num">–</td>
				<td class="num" class:warn={meta.aixm.es.obstacles.skippedNonBaseline > 0}>{fmtNumber(meta.aixm.es.obstacles.skippedNonBaseline)}</td>
				<td class="num">–</td>
			</tr>
		{/if}
	</tbody>
</table>
<!-- i18n-ignore-end -->

<style>
	.diag-table {
		width: 100%;
		border-collapse: collapse;
		margin-top: 4px;
		font-size: 12px;
	}

	.diag-table th,
	.diag-table td {
		padding: 2px 6px;
		border-bottom: 1px solid var(--border);
		text-align: left;
	}

	.diag-table th {
		font-weight: 600;
		color: var(--text-muted);
		font-size: 11px;
	}

	.diag-table td.num,
	.diag-table th.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.diag-table td.warn {
		color: var(--workbook-orange);
		font-weight: 600;
	}
</style>
