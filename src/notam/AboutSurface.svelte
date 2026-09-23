<script lang="ts">
	/* This app's About, and deliberately not Loxodrome's.
	 *
	 * AboutModal.svelte is 1 664 lines because it credits everything the
	 * flight app carries: the magnetic model, the aircraft sheets, the chart
	 * layers, the radar, the winds. This app ships none of those, and the
	 * repo's own rule for that modal is that a section names what it ACTUALLY
	 * ships (tests/aboutCoverage.spec.ts). Mounting it here would credit a
	 * dozen sources this site never fetches, which is a worse failure than a
	 * short page: it would be untrue.
	 *
	 * The INVERSE is worse still, and this page had it. Two sources it does
	 * fetch were missing: the NOAA weather behind the aerodrome panel's METAR
	 * and TAF, and the elevation mosaic the altitude profile reads its ground
	 * from, whose Copernicus tiers carry a mandatory attribution. Neither is a
	 * bbox-gated dataset, so neither was in the manifest this page derives its
	 * publishers from, and the file that lists what the app reads said it had
	 * neither. src/notam/datasets.ts VIEWER_LIVE_SOURCES is where they are
	 * named now, and tests/notamViewerAbout.spec.ts holds this page to it.
	 *
	 * So: short, and complete about what this app does carry. The obligations
	 * are real rather than decorative, since the site redistributes national
	 * AIP data, re-serves public elevation models and ships third-party code
	 * whose licences oblige it to pass the notices on.
	 *
	 * The licence TEXTS are import()ed on first open, the AboutModal pattern:
	 * minification strips every notice, so thirdPartyLicenseTexts.ts is the
	 * only place the app carries what MIT / BSD / Apache-2.0 / MPL-2.0 require
	 * it to hand on, and it is too big for the main chunk.
	 */
	import SurfaceShell from '$lib/components/SurfaceShell.svelte';
	import { THIRD_PARTY_LICENSES } from '$lib/data/thirdPartyLicenses';

	import { aboutModal, closeAbout } from '$lib/state/aboutModal.svelte';
	import { dataState } from '$lib/state/data.svelte';
	import { fmtAiracDate } from '$lib/format/about';
	import { ensureTerrainRegions, terrainRegions, type TerrainRegion } from '$lib/map/terrain';
	import { i18n, t } from '$lib/state/i18n.svelte';
	import {
		AD_CHART_CREDITS,
		AIP_CREDITS,
		viewerAdChartPrefixes,
		viewerDatasetPrefixes,
		viewerNationalPublishers,
		type ViewerCredit,
	} from './datasets';
	import { LOXODROME_URL, SOURCE_URL } from './loxodrome';

	/** The licence texts, once someone asks for one. Null until then, and null
	 *  again if the chunk fails: the row says so rather than the page failing
	 *  to open. */
	let texts = $state<Record<string, string> | null>(null);

	/* The elevation tiers, read from the mosaic's own manifest rather than
	   copied here, exactly as AboutModal does it: the credit then cannot drift
	   from what the tiles actually are. Best-effort by design (map/terrain.ts):
	   a manifest that will not read costs the row, never the ground.
	
	   Gated on the surface being OPEN, which AboutModal gets for free and this
	   one does not: the flight app mounts its About through LazySurface, so the
	   module does not even load until someone asks, where App.svelte mounts
	   this component unconditionally and its effects run at BOOT. Ungated it
	   put /data/terrain.json second in the boot waterfall of every session,
	   for a page nobody had opened. */
	// The manifest's own row type, like AboutModal's: narrowing it to the two
	// fields rendered dropped `id`, and keying the list on `label` would
	// throw each_key_duplicate the day two tiers share one (two bounds-split
	// Copernicus regions, say), inside an open dialog, blanking the page.
	// A read that settled with none says so rather than ending the section
	// on "the public models below".
	let tiers = $state<TerrainRegion[]>([]);
	let tiersRead = $state(false);
	$effect(() => {
		if (!aboutModal.open) {
			return;
		}
		void ensureTerrainRegions().then(() => {
			tiers = terrainRegions();
			tiersRead = true;
		});
	});
	let openId = $state<string | null>(null);
	let failed = $state(false);

	async function toggle(id: string): Promise<void> {
		if (openId === id) {
			openId = null;
			return;
		}
		if (!texts && !failed) {
			try {
				const mod = await import('$lib/data/thirdPartyLicenseTexts');
				texts = mod.THIRD_PARTY_LICENSE_TEXTS;
			} catch {
				failed = true;
			}
		}
		openId = id;
	}

	/** The packages THIS app ships, which is 9 of the 37 in the generated list.
	 *  The rest belong to Loxodrome alone, and crediting them here would claim
	 *  a service worker, a printer and offline packs this app does not have,
	 *  which is the mirror of shipping a dataset uncredited. The flag is read
	 *  from dist/notam's own source maps at generation time
	 *  (scripts/gen-licenses.js), so it cannot drift from the bundle. */
	const libraries = THIRD_PARTY_LICENSES.filter((l) => l.inViewer);

	/** The national AIS publishers, named as the Layers tab names them so the
	 *  credit reads in the reader's language, and DERIVED from the dataset
	 *  manifest so one cannot ship uncredited (src/notam/datasets.ts).
	 *
	 *  Ordered the way the flight app's About orders its own sections: France
	 *  leads, being the home State, then the rest sort on the localised name
	 *  under the READING locale, so the French list reads Allemagne, Autriche,
	 *  Belgique rather than the English order translated. */
	const publishers = $derived.by(() => {
		const names = t.layers.publisherNames;
		const keys = viewerNationalPublishers();
		const rest = keys
			.filter((k) => k !== 'fr')
			.map((k) => names[k])
			.sort((a, b) => a.localeCompare(b, i18n.locale));
		return [names.fr, ...rest].join(', ');
	});

	/** Each source's own terms (datasets.ts AIP_CREDITS), in the same order:
	 *  France first, then by the reader's own name for the publisher. Italy
	 *  among them, its heading saying it is community data. */
	function byName(keys: string[], credits: Readonly<Record<string, ViewerCredit>>, names: Record<string, string>) {
		const rows = keys.filter((k) => credits[k]).map((k) => ({ key: k, ...credits[k] }));
		return [
			...rows.filter((r) => r.key === 'fr'),
			...rows
				.filter((r) => r.key !== 'fr')
				.sort((a, b) => (names[a.key] ?? a.key).localeCompare(names[b.key] ?? b.key, i18n.locale)),
		];
	}
	const aipCredits = $derived(
		byName(viewerDatasetPrefixes(), AIP_CREDITS, t.layers.publisherNames as Record<string, string>),
	);
	const chartCredits = $derived(
		byName(viewerAdChartPrefixes(), AD_CHART_CREDITS, {
			...(t.layers.publisherNames as Record<string, string>),
			us: t.layers.publisherNames.faa,
		}),
	);

	/** The cycle this session loaded for France, the edition date the
	 *  Licence Ouverte asks to be stated beside the SIA's name. None before a
	 *  French dataset has loaded, when nothing French is on screen either. */
	const frCycle = $derived(dataState.airac.airspaces.fr?.effective ?? dataState.airac.airports.fr?.effective ?? null);
</script>

<SurfaceShell
	id="about"
	onClose={closeAbout}
	labelledby="viewer-about-title"
	closeLabel={t.about.closeAbout}
	boxClass="viewer-about-box"
>
	{#snippet header()}
		<h2 id="viewer-about-title">
			<!-- i18n-ignore: the product name, identical in both catalogs -->
			NOTAM Viewer
		</h2>
	{/snippet}

	<div class="body">
		<p>{t.viewer.aboutWhat}</p>

		<!-- i18n-ignore: the product name, identical in both catalogs -->
		<h3>Loxodrome</h3>
		<p>{t.viewer.siblingBody}</p>
		<p>
			<a href={LOXODROME_URL} target="_blank" rel="noopener">{t.viewer.siblingLink} ↗</a>
		</p>

		<h3>{t.viewer.aboutSourceHeading}</h3>
		<p>{t.viewer.aboutSourceBody}</p>
		<p>
			<a href={SOURCE_URL} target="_blank" rel="noopener"
				><!-- i18n-ignore: the repository address -->github.com/0intro/loxodrome ↗</a
			>
		</p>

		<h3>{t.about.aipHeading}</h3>
		<p>{t.viewer.aboutAipBody({ publishers })}</p>
		<ul class="credits">
			{#each aipCredits as c (c.key)}
				<li>
					<a href={c.href} target="_blank" rel="noopener noreferrer">{t.about[c.head]}</a>
					<span class="lic"
						>{t.about[c.license]}{#if c.key === 'it'}
							<a href={c.href} target="_blank" rel="noopener noreferrer"
								><!-- i18n-ignore: the association's address -->openflightmaps.org</a
							>{/if}</span
					>
					{#if c.key === 'fr' && frCycle}
						<!-- i18n-ignore: AIRAC is invariant and the date formatted -->
						<span class="lic">AIRAC {fmtAiracDate(frCycle)}</span>
					{/if}
				</li>
			{/each}
		</ul>
		<p>{t.viewer.aboutBaselineBody}</p>

		<h3>{t.about.adChartsHeading}</h3>
		<p>{t.viewer.aboutAdChartsBody}</p>
		<ul class="credits">
			{#each chartCredits as c (c.key)}
				<li>
					<a href={c.href} target="_blank" rel="noopener noreferrer">{t.about[c.head]}</a>
					<span class="lic">{t.about[c.license]}</span>
				</li>
			{/each}
		</ul>

		<h3>{t.about.notamHeading}</h3>
		<p>{t.viewer.aboutNotamBody}</p>

		<h3>{t.about.weatherHeading}</h3>
		<p>{t.viewer.aboutWeatherBody}</p>

		<h3>{t.viewer.aboutBaseMapHeading}</h3>
		<p>{t.viewer.aboutBaseMapBody}</p>
		<!-- Every base map the Layers popover OFFERS, not just the default
		     one. The corner credit is allowed to fold after five seconds only
		     because the licence stays findable from an About row
		     (map/attributionCredit.ts), and this is that row: a
		     pilot on Google Satellite or Bing Aerial has to find the notice
		     here. Mirrors AboutModal's list in the flight app. -->
		<!-- i18n-ignore-start: base-map product names + attributions, invariant (docs/i18n.md rule 10) -->
		<ul class="libs">
			<li>
				<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>
				<span class="lic">ODbL</span>
			</li>
			<li>
				<a href="https://opentopomap.org" target="_blank" rel="noopener noreferrer">OpenTopoMap</a>
				<span class="lic">CC-BY-SA</span>
			</li>
			<li>
				<a href="https://cartes.gouv.fr/" target="_blank" rel="noopener noreferrer">IGN</a>
				<span class="lic">© IGN</span>
			</li>
			<li>
				<a href="https://www.google.com/maps" target="_blank" rel="noopener noreferrer">Google</a>
				<span class="lic">© Google</span>
			</li>
			<li>
				<a href="https://www.bing.com/maps" target="_blank" rel="noopener noreferrer">Microsoft Bing</a>
				<span class="lic">© Microsoft</span>
			</li>
		</ul>
		<!-- i18n-ignore-end -->

		<h3>{t.about.terrainHeading}</h3>
		<p>{t.viewer.aboutTerrainBody}</p>
		{#if tiers.length > 0}
			<ul class="tiers">
				<!-- i18n-ignore-start: publisher attributions, quoted VERBATIM as each licence requires -->
				{#each tiers as tier (tier.id)}
					<li>{tier.label}: {tier.attribution}</li>
				{/each}
				<!-- i18n-ignore-end -->
			</ul>
		{:else if tiersRead}
			<p class="muted small">{t.about.terrainCreditsMissing}</p>
		{/if}

		<h3>{t.about.librariesHeading}</h3>
		<p class="muted small">{t.viewer.aboutLibrariesBody}</p>
		<ul class="libs">
			{#each libraries as lib (lib.id)}
				<li class:open={openId === lib.id}>
					<button class="lib-row" onclick={() => void toggle(lib.id)} aria-expanded={openId === lib.id}>
						<span class="lib-name">{lib.name}</span>
						<!-- i18n-ignore-start: a version number and an SPDX identifier -->
						<span class="muted small">{lib.version} &middot; {lib.spdx}</span>
						<!-- i18n-ignore-end -->
					</button>
					{#if openId === lib.id}
						<pre class="lib-text" lang="en">{texts?.[lib.id] ?? t.viewer.aboutLicenseMissing}</pre>
					{/if}
				</li>
			{/each}
		</ul>

		<p class="muted small">{t.about.copyright} {t.about.licenseMit}.</p>
	</div>
</SurfaceShell>

<style>
	/* The shell owns the box and the caller owns what is in it, so the width
	   is set on the box class (a scoped rule cannot reach a shell-owned
	   element) and the scrolling on the caller's own .body, which is the
	   convention AboutModal follows. Without the second one the content is
	   simply cut off: this page is about 1 980 px tall against a 774 px box,
	   so the whole licence list was unreachable. */
	:global(.viewer-about-box) {
		--modal-width: min(880px, 92vw);
	}

	.body {
		flex: 1;
		overflow-y: auto;
		padding: 14px 16px 18px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text);
	}

	.body h3 {
		margin-block: 18px 6px;
		font-size: var(--fs-sm);
	}

	.body h3:first-of-type {
		margin-block-start: 12px;
	}

	.body p {
		margin-block: 0 8px;
	}

	/* One source a line: its heading, linked to where its data is read, then
	   its own terms, muted. */
	.credits {
		margin: 0 0 8px;
		padding-left: 18px;
	}

	.credits .lic {
		display: block;
		color: var(--text-muted);
	}

	.credits li {
		margin-block-end: 2px;
	}

	/* The elevation attributions. Small and muted: they are a legal notice
	   rather than something to read, and the sentence above already says what
	   they are. */
	.tiers {
		margin: 0 0 8px;
		padding-left: 18px;
		font-size: var(--fs-2xs);
		color: var(--text-muted);
	}

	/* Two columns where there is room for them: 37 packages is a long thin
	   list against an 880 px box. The track is sized so the count falls out of
	   the width rather than being declared: 320 px fits twice in the 831 px
	   list and not three times, and once in a phone's 360, so one rule serves
	   both without a media query. An OPEN row spans the lot, because a licence
	   notice is a block of text and reading it down a half-width column is
	   worse than not showing it. */
	.libs {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		gap: 0 20px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.libs li.open {
		grid-column: 1 / -1;
	}

	/* A row, not a control that looks like one: the whole line opens its
	   notice, which is what the reader is reaching for. */
	.lib-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: baseline;
		inline-size: 100%;
		padding: 5px 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: start;
		cursor: pointer;
	}

	/* The 44 px floor. app.css applies it to every .btn, and this row is
	   deliberately not one (it is a line of text that opens a notice), so it
	   has to ask: 29.5 px measured on the phone otherwise. */
	:global(:root.touch-ui) .lib-row {
		min-block-size: 44px;
	}

	.lib-row:hover .lib-name,
	.lib-row:focus-visible .lib-name {
		text-decoration: underline;
	}

	.lib-text {
		margin: 4px 0 10px;
		padding: 8px;
		border-radius: var(--radius-sm);
		background: var(--bg);
		font-size: var(--fs-2xs);
		white-space: pre-wrap;
	}
</style>
