<script lang="ts">
	/* Who knows a zone's real activity, as its publication names them
	   (data/knownFrom.ts): each unit with its frequency, a party known by
	   telephone with its number as a link a phone dials. */
	import type { KnownUnit } from '$lib/data/knownFrom';
	import { t } from '$lib/state/i18n.svelte';
	import ContactTable from './ContactTable.svelte';

	interface Props {
		units: KnownUnit[];
	}

	let { units }: Props = $props();

	const rows = $derived(
		units.map((u) => ({ label: u.unit, freq: u.freq ?? '', phones: u.phone ? [u.phone] : [], note: '' })),
	);
</script>

<section class="block">
	<h3 title={t.detail.realActivityTip}>{t.detail.realActivityKnownTo}</h3>
	<ContactTable {rows} />
</section>

<style>
	.block h3 {
		margin: 0 0 4px;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}
</style>
