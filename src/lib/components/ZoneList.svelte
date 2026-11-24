<script lang="ts">
	/* The temporary zones of the viewing period by state (state/zoneList
	 * periodZones, docs/zone-activity.md "The zones list"): active, may be
	 * active, later in the period, and folded the zones inactive over it,
	 * each wearing the map's look for its state (ZoneSwatch); then the
	 * supplements in force that draw no zone, whose text is the whole of
	 * them. A typed period in the toolbar makes it a search by dates. A row
	 * opens the supplement on its zone, or the NOTAM. The phone's Brief page
	 * mounts it as its Zones section, the desktop and the viewer as the
	 * NOTAMs tab's Zones view. */
	import { supaipSubject, type SupAip } from '$lib/data/supaip';
	import { dataState, ensureSupaip } from '$lib/state/data.svelte';
	import { display } from '$lib/state/display.svelte';
	import { i18n, t } from '$lib/state/i18n.svelte';
	import { closePage, selectNotam, selectSupaip } from '$lib/state/ui.svelte';
	import { otherSupplements, periodZones, type ListedZone } from '$lib/state/zoneList.svelte';
	import type { ZoneDrawState } from '$lib/state/zoneStates.svelte';
	import ZoneSwatch from './ZoneSwatch.svelte';

	/* Ask for the supplements: the list is their one door on a phone, and the
	 * dataset otherwise loads with the map layer or the alerts. */
	$effect(() => {
		void ensureSupaip().catch(() => {});
	});

	const zones = $derived(periodZones());
	const others = $derived(otherSupplements(zones));
	const of = (state: ZoneDrawState): ListedZone[] => zones.filter((z) => z.state === state);
	const inactive = $derived(of('inactive'));

	function open(z: ListedZone): void {
		if (z.opens.kind === 'sup') {
			selectSupaip(z.opens.id, z.opens.zone);
		} else {
			selectNotam(z.opens.index);
		}
		closePage();
	}

	function pickSup(s: SupAip): void {
		selectSupaip(s.id);
		closePage();
	}
</script>

{#snippet rows(list: ListedZone[])}
	<ul class="zones">
		{#each list as z (z.key)}
			<li>
				<button type="button" class="row" onclick={() => open(z)}>
					<span class="line">
						{#if z.state !== 'inactive'}<ZoneSwatch state={z.state} family={z.family} />{/if}
						<span class="title">{z.name}</span>
					</span>
					<span class="sub">{z.source}</span>
				</button>
			</li>
		{/each}
	</ul>
{/snippet}

{#if dataState.supaipError}
	<p class="muted error" role="alert">{t.layers.supaipFailed}</p>
{:else if !dataState.supaipLoaded}
	<p class="muted">{t.layers.loadingSupaip}</p>
{:else if zones.length === 0 && others.length === 0}
	<p class="muted">{t.zones.listNone}</p>
{/if}
{#each [['active', t.zones.listActive], ['may', t.zones.listMay], ['later', t.zones.listLater]] as const as [state, title] (state)}
	{@const list = of(state)}
	{#if list.length > 0}
		<fieldset class="group">
			<legend>{title}</legend>
			{@render rows(list)}
		</fieldset>
	{/if}
{/each}
{#if inactive.length > 0}
	<details class="group inactive">
		<summary>{t.zones.listInactive(inactive.length)}</summary>
		{@render rows(inactive)}
	</details>
{/if}
{#if others.length > 0}
	<fieldset class="group">
		<legend>{t.zones.listOthers}</legend>
		<ul class="zones">
			{#each others as s (s.id)}
				<li>
					<button type="button" class="row" onclick={() => pickSup(s)}>
						<span class="title">{s.title}</span>
						<span class="sub">{supaipSubject(s, display.supaipLang, i18n.locale)}</span>
					</button>
				</li>
			{/each}
		</ul>
	</fieldset>
{/if}

<style>
	.zones {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* A list of hairlines inside a flat section (app.css, "Phones: a section
	   is FLAT"): it runs to the screen's edges like the section's own
	   hairline, each row's text at the section's inset. Screen only. */
	@media screen {
		.zones {
			margin-inline: calc(-1 * var(--flat-inset, 0px));
		}

		.zones .row {
			padding-inline: var(--flat-inset, 4px);
		}
	}

	.row {
		display: flex;
		flex-direction: column;
		gap: 2px;
		align-items: flex-start;
		width: 100%;
		min-height: 44px;
		padding: 6px 4px;
		font: inherit;
		color: var(--text);
		text-align: left;
		background: none;
		border: 0;
		border-bottom: 1px solid var(--border);
		cursor: pointer;
	}

	.line {
		display: inline-flex;
		gap: 8px;
		align-items: center;
	}

	.title {
		font-weight: 600;
	}

	.sub {
		overflow: hidden;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		font-size: var(--fs-xs);
		color: var(--text-muted);
	}

	.inactive summary {
		padding: 6px 0;
		font-size: var(--fs-xs);
		color: var(--text-muted);
		cursor: pointer;
	}
</style>
