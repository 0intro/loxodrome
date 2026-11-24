<script module lang="ts">
	export interface ContactRow {
		label: string;
		freq: string;
		phones: string[];
		note: string;
	}
</script>

<script lang="ts">
	/* Whom to reach and how, one row each: a unit with its frequency, or a
	   party with the telephone numbers it is reached on, each a link a phone
	   dials, or a note. A supplement's coordination block and a zone's
	   "Activity known on" both read it. */
	import { telHref } from '$lib/format/phone';
	import { t } from '$lib/state/i18n.svelte';

	interface Props {
		rows: ContactRow[];
	}

	let { rows }: Props = $props();
</script>

<table class="freqs">
	<tbody>
		{#each rows as r, i (r.label + '|' + i)}
			<tr>
				<td class="svc">{r.label}</td>
				<td class="freq">
					{#if r.freq}
						{r.freq}
					{:else if r.phones.length > 0}
						{#each r.phones as p, k (k)}
							{@const href = telHref(p)}
							{#if href}<a class="tel" {href} title={t.detail.telTip(p)}>{p}</a>{:else}{p}{/if}{k < r.phones.length - 1 ? ' / ' : ''}
						{/each}
					{:else if r.note}
						<span class="muted">{r.note}</span>
					{/if}
				</td>
			</tr>
		{/each}
	</tbody>
</table>

<style>
	.freqs {
		width: 100%;
		font-size: 12px;
		border-collapse: collapse;
	}

	.freqs td {
		padding: 3px 4px;
		vertical-align: top;
		border-bottom: 1px solid var(--border);
	}

	.freqs .svc {
		font-weight: 600;
	}

	/* The detail panel and the phone's detail sheet (DetailSurface): the
	   table runs edge to edge, its first and last cells insetting their text
	   by their own padding. Screen only: paper keeps the table inside its
	   margin. */
	@media screen {
		:global(.detail-box) .freqs,
		:global(aside.detail) .freqs {
			width: calc(100% + 2 * var(--detail-pad, 0px));
			margin-inline: calc(-1 * var(--detail-pad, 0px));
		}

		:global(.detail-box) .freqs td:first-child,
		:global(aside.detail) .freqs td:first-child {
			padding-left: var(--detail-pad, 4px);
		}

		:global(.detail-box) .freqs td:last-child,
		:global(aside.detail) .freqs td:last-child {
			padding-right: var(--detail-pad, 4px);
		}
	}

	.freqs .freq {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.tel {
		color: var(--accent);
	}
</style>
