<script lang="ts">
	import {
		aboutModal,
		closeAbout,
		showAbout,
		showLicense,
	} from '$lib/state/aboutModal.svelte';
	import { AIXM_COUNTRIES, loadAboutMeta, type AboutMeta, type AixmCountryMeta } from '$lib/data/aboutMeta';
	import { dataState, type AiracSlot } from '$lib/state/data.svelte';
	import type { FaaAirspacesMeta, NatureMeta, SupAipMeta } from '$lib/data/meta';
	import { publishedChartLayers } from '$lib/map/chartOverlays';
	import { MIT_LICENSE_TEXT } from '$lib/data/license';
	import { THIRD_PARTY_LICENSES, thirdPartyLicense } from '$lib/data/thirdPartyLicenses';
	import SurfaceShell from './SurfaceShell.svelte';
	import {
		fmtUTC,
		fmtAiracDate,
		announceNextCycle,
		relativeActive,
		agoDays,
		freshnessClass,
	} from '$lib/format/about';
	import { fmtInt, i18n, t } from '$lib/state/i18n.svelte';

	// Local render shims over the structured parts (the catalogs carry the
	// words); arrow bodies defer the t reads, so the language stays live.
	const fmtNumber = (n: number | undefined): string =>
		n == null ? '–' : fmtInt(n);
	const fmtRelative = (iso: string | undefined): string => {
		const r = relativeActive(iso);
		return r.kind === 'none'
			? ''
			: r.kind === 'now'
				? t.about.activeNow
				: r.kind === 'soon'
					? t.about.activeSoon
					: t.about.activeInDays(r.days);
	};
	const fmtAgo = (iso: string | undefined): string => {
		const d = agoDays(iso);
		return d === null ? '' : d === 0 ? t.about.generatedToday : t.about.daysAgo(d);
	};
	import { airacYYNN } from '$lib/data/airac';
	import { ensureTerrainRegions, terrainRegions, type TerrainRegion } from '$lib/map/terrain';
	import { magneticModelExpired } from '$lib/route/magnetic';
	import Icon from './Icon.svelte';
	import AixmDiagnosticsTable from './AixmDiagnosticsTable.svelte';
	import DataSourceCard from './DataSourceCard.svelte';

	/** The tiers the elevation mosaic is actually made of, for the credits
	 *  below. Read through the manifest loader rather than assumed: the
	 *  Copernicus licence (Article 6) obliges a derived work to carry its
	 *  notices VERBATIM, and a sentence hardcoded here would go quietly
	 *  wrong the day a tier is added. Empty until the manifest resolves,
	 *  and the card simply omits the row until then. */
	let terrainTiers = $state<TerrainRegion[]>([]);
	$effect(() => {
		void ensureTerrainRegions().then(() => {
			terrainTiers = terrainRegions();
		});
	});

	/** The cycle this session actually LOADED for a publisher.
	 *
	 *  Not the same as the current-slot sidecar, and the card used to print
	 *  that one. Between a pre-release becoming effective and the workflow
	 *  rolling it into the current slot, the loader fetches the `.next`
	 *  file: on 15 August the app was serving France and Belgium from AIRAC
	 *  2608 while their cards read 2607 and offered to reload for a cycle
	 *  already in use. dataState.airac holds the loader's own decision, so
	 *  reading it cannot drift from what was fetched.
	 *
	 *  A card names the datasets it lists, so the cell is looked up in that
	 *  order; a publisher outside the AIRAC matrix (or one whose fetch has
	 *  not landed) falls back to its sidecar. */
	const AIRAC_LOOKUP = ['airspaces', 'obstacles', 'airports', 'navaids'] as const;
	const loadedCycle = (country: string): AiracSlot | undefined => {
		for (const dataset of AIRAC_LOOKUP) {
			// A publisher outside the matrix simply misses every key.
			const row: Partial<Record<string, AiracSlot>> = dataState.airac[dataset];
			const cell = row[country];
			if (cell?.effective) {
				return cell;
			}
		}
		return undefined;
	};

	/** The nature families a publisher actually files, in the catalog's own
	 *  order so the rows read the same everywhere. Which families a set
	 *  carries is per publisher (Belgium bird areas, France parks and
	 *  sensitive sites, Italy reserves), so the card reads the meta's counts
	 *  rather than assuming one. An unknown key is skipped: the label map is
	 *  the drawn set, and a family with no glyph has nothing to say here. */
	const NATURE_ORDER = ['NATURE', 'SENSITIVE', 'BIRD'] as const;
	type NatureType = (typeof NATURE_ORDER)[number];
	const natureRows = (
		n: NatureMeta | null | undefined,
	): { type: NatureType; count: number }[] =>
		n
			? NATURE_ORDER.filter((k) => (n.counts[k] ?? 0) > 0).map((k) => ({
					type: k,
					count: n.counts[k] ?? 0,
				}))
			: [];

	// Three states for the data-sources block: pending, loaded, failed.
	// The rest of the modal renders regardless; the block only blanks out.
	let meta = $state<AboutMeta | null>(null);
	let metaError = $state<string | null>(null);
	// Bumped on every open / close transition so a fetch that's still in
	// flight when the modal closes (or is reopened) can't write stale state
	// over a newer flight. Without this guard a transient failure stuck
	// `metaError` permanently, since close → reopen short-circuited on the
	// truthy error and never retried.
	let metaFlight = 0;

	$effect(() => {
		if (!aboutModal.open) {
			// Cancel any in-flight fetch and reset the error so the next
			// open retries from scratch.
			metaFlight += 1;
			metaError = null;
			return;
		}
		if (meta) {
			return;
		}
		const myFlight = ++metaFlight;
		loadAboutMeta()
			.then((loaded) => {
				if (myFlight === metaFlight) {
					meta = loaded;
				}
			})
			.catch((e: unknown) => {
				if (myFlight === metaFlight) {
					metaError = e instanceof Error ? e.message : String(e);
				}
			});
	});

	// Every publisher card shares one template below; each record carries
	// the country's dataset metas plus the card's own extras (licence note,
	// the nature / SUP AIP rows, the FAA's three airspace products). Built
	// in a $derived so the headings and licence notes re-translate live, and
	// SORTED there, so the order is a rule rather than the order the records
	// happened to be written in.
	interface PublisherCard extends AixmCountryMeta {
		key: string;
		href: string;
		head: string;
		/** AT publishes no runway or RNAV-waypoint figures, so its airport
		 *  / navaid rows show the bare counts. */
		bareCounts?: boolean;
		/** Where the AIRAC + generated rows come from for a publisher with
		 *  no airspace dataset to carry them. Set only where the effective
		 *  date really is an AIRAC date: Switzerland leaves it unset,
		 *  because FOCA revises its register "as needed" and labelling a
		 *  publication date AIRAC would assert a cycle that does not
		 *  exist. Structural rather than one meta type, because the FAA's
		 *  airspace sidecar states no effective date at all. */
		cycle?: { effective?: string | undefined; generatedAt: string } | null;
		/** The FAA files its airspace as three products rather than one
		 *  dataset, so its card counts them separately. An optional field on
		 *  the shared record rather than a card of its own: the sort then
		 *  has ONE list to order, and the rows every publisher shares cannot
		 *  drift between two copies of the template. */
		usAirspaces?: FaaAirspacesMeta | null;
		/** The cycle is read OFF the generation date, its publisher stating
		 *  no effective one (the FAA hub). Also skips the loadedCycle probe,
		 *  which has no cell to find. */
		airacFromGenerated?: boolean;
		nature?: NatureMeta | null;
		supaip?: SupAipMeta | null;
		/** REQUIRED, so a publisher cannot be added without saying what its
		 *  terms are. Every string was read at the publisher's own source,
		 *  not inferred; where a publisher grants nothing, the card says
		 *  that rather than implying a permission nobody gave. Reading them
		 *  is what found five publishers whose own AIP forbids re-serving;
		 *  those are held out of the build entirely (cmd/eaip Consent,
		 *  docs/eaip-states.md) rather than shipped with a disclaimer. */
		license: string;
	}

	/** One card per publisher that indexes its own aerodrome charts. A chart
	 *  index is chart data whoever files it, so all six sit in the Aerodrome
	 *  charts section; four of them used to be a single row on the
	 *  publisher's AIP card, which is why that section read as France's
	 *  alone. */
	interface AdChartCard {
		key: string;
		href: string;
		head: string;
		license: string;
		generatedAt: string;
		/** Charts, and the sites carrying them (AT / UK / US). */
		charts?: { count: number; sites: number };
		/** The DFS publishes permalinked aerodrome pages, not chart PDFs. */
		pages?: number;
	}

	/** THE order for every card list in the credits, so a section cannot
	 *  invent its own: the publishers by their country name IN THE READING
	 *  LANGUAGE. The names are the Layers tab's own catalog, so no second
	 *  list of countries exists to drift, and the collator is what makes the
	 *  French list read Allemagne, Autriche, Belgique rather than the English
	 *  order translated. France is pinned ahead of the sorted run in the
	 *  markup, not here, its card being bespoke. */
	function byPublisherName<T extends { key: string }>(cards: T[]): T[] {
		const names: Partial<Record<string, string>> = t.layers.publisherNames;
		const collator = new Intl.Collator(i18n.locale);
		return [...cards].sort((a, b) =>
			collator.compare(names[a.key] ?? a.key, names[b.key] ?? b.key),
		);
	}

	/** How much the national AIXM overlays add to the worldwide baseline,
	 *  summed over every publisher that ships an aerodrome dataset (France
	 *  plus the AIXM records, the FAA among them). */
	const airportOverlays = $derived.by(() => {
		const m = meta;
		if (!m) {
			return { rows: 0, publishers: 0 };
		}
		const counts = [
			m.frAirports?.ahpCount,
			...AIXM_COUNTRIES.map((c) => m.aixm[c].airports?.ahpCount),
			m.faaAirports?.ahpCount,
		].filter((n): n is number => n != null && n > 0);
		return {
			rows: counts.reduce((a, b) => a + b, 0),
			publishers: counts.length,
		};
	});

	const publisherCards = $derived.by((): PublisherCard[] => {
		const m = meta;
		if (!m) {
			return [];
		}
		const cards: PublisherCard[] = [
			{
				key: 'uk',
				href: 'https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/',
				head: t.about.headUk,
				...m.aixm.uk,
				license: t.about.licUk,
			},
			{
				key: 'be',
				href: 'https://ops.skeyes.be/html/belgocontrol_static/eaip/eAIP_Main/html/index-en-GB.html',
				head: t.about.headBelgium,
				...m.aixm.be,
				nature: m.beNature,
				supaip: m.beSupaip,
				license: t.about.licBelgium,
			},
			{
				key: 'de',
				href: 'https://aip.dfs.de/datasets/',
				head: t.about.headGermany,
				...m.aixm.de,
				license: t.about.licGermany,
			},
			{
				key: 'it',
				href: 'https://openflightmaps.org/',
				head: t.about.headItaly,
				...m.aixm.it,
				nature: m.itNature,
				bareCounts: true,
				license: t.about.licItaly,
			},
			{
				key: 'ch',
				href: 'https://www.bazl.admin.ch/de/digitale-luftfahrthinderniskarte',
				head: t.about.headSwitzerland,
				airspaces: null,
				airports: null,
				navaids: null,
				facilities: null,
				obstacles: m.chObstacles,
				bareCounts: true,
				license: t.about.licSwitzerland,
			},
			{
				key: 'fi',
				href: 'https://www.ais.fi/ais/aipobst/aipobst.htm',
				head: t.about.headFinland,
				airspaces: null,
				airports: null,
				navaids: null,
				facilities: null,
				obstacles: m.fiObstacles,
				cycle: m.fiObstacles,
				bareCounts: true,
				license: t.about.licFinland,
			},
			{
				key: 'nl',
				href: 'https://geoportaal.lvnl.nl/',
				head: t.about.headNetherlands,
				...m.aixm.nl,
				bareCounts: true,
				license: t.about.licNetherlands,
			},
			{
				key: 'ge',
				href: 'https://ais.airnav.ge/en/aip-dataset',
				head: t.about.headGeorgia,
				...m.aixm.ge,
				bareCounts: true,
				license: t.about.licGeorgia,
			},
			{
				key: 'at',
				href: 'https://www.austrocontrol.at/en/pilots/pre-flight_preparation/aim_products',
				head: t.about.headAustria,
				...m.aixm.at,
				bareCounts: true,
				license: t.about.licAustria,
			},
			{
				key: 'sk',
				href: 'https://aim.lps.sk/',
				head: t.about.headSlovakia,
				...m.aixm.sk,
				bareCounts: true,
				license: t.about.licSlovakia,
			},
			{
				key: 'ie',
				href: 'https://www.airnav.ie/',
				head: t.about.headIreland,
				...m.aixm.ie,
				bareCounts: true,
				license: t.about.licIreland,
			},
			{
				key: 'rs',
				href: 'https://smatsa.rs/en/aip/',
				head: t.about.headSerbiaMontenegro,
				...m.aixm.rs,
				bareCounts: true,
				license: t.about.licSerbiaMontenegro,
			},
			{
				key: 'xk',
				href: 'https://kans-ks.org/eAIP/default.html',
				head: t.about.headKosovo,
				...m.aixm.xk,
				bareCounts: true,
				license: t.about.licKosovo,
			},
			{
				key: 'es',
				href: 'https://aip.enaire.es/AIP/DatosDigitales-en.html',
				head: t.about.headSpain,
				...m.aixm.es,
				supaip: m.esSupaip,
				license: t.about.licSpain,
			},
			{
				key: 'faa',
				href: 'https://adds-faa.opendata.arcgis.com/',
				head: t.about.headFaa,
				airspaces: null,
				airports: m.faaAirports,
				navaids: m.faaNavaids,
				obstacles: m.faaObstacles,
				facilities: null,
				usAirspaces: m.faa,
				cycle: m.faa,
				airacFromGenerated: true,
				license: t.about.licNoaa,
			},
		];
		// A publisher with no sidecar at all gets no card (a fresh clone
		// before its first workflow run).
		return byPublisherName(
			cards.filter(
				(c) => c.airspaces || c.airports || c.obstacles || c.navaids || c.usAirspaces,
			),
		);
	});

	const adChartCards = $derived.by((): AdChartCard[] => {
		const m = meta;
		if (!m) {
			return [];
		}
		const cards: AdChartCard[] = [];
		if (m.atAdCharts) {
			cards.push({
				key: 'at',
				href: 'https://www.austrocontrol.at/en/pilots/pre-flight_preparation/aim_products',
				head: t.about.headAtAdCharts,
				license: t.about.licAustria,
				generatedAt: m.atAdCharts.generatedAt,
				charts: {
					count: m.atAdCharts.charts,
					sites: m.atAdCharts.aerodromes + m.atAdCharts.heliports,
				},
			});
		}
		if (m.deAdCharts) {
			cards.push({
				key: 'de',
				href: 'https://aip.dfs.de/BasicVFR/',
				head: t.about.headDeAdCharts,
				license: t.about.licGermany,
				generatedAt: m.deAdCharts.generatedAt,
				pages: m.deAdCharts.aerodromes,
			});
		}
		if (m.ukAdCharts) {
			cards.push({
				key: 'uk',
				href: 'https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/',
				head: t.about.headUkAdCharts,
				license: t.about.licUk,
				generatedAt: m.ukAdCharts.generatedAt,
				charts: { count: m.ukAdCharts.charts, sites: m.ukAdCharts.aerodromes },
			});
		}
		if (m.usAdCharts) {
			cards.push({
				key: 'faa',
				href: 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/',
				head: t.about.headUsAdCharts,
				license: t.about.licNoaa,
				generatedAt: m.usAdCharts.generatedAt,
				charts: { count: m.usAdCharts.charts, sites: m.usAdCharts.airports },
			});
		}
		return byPublisherName(cards);
	});

	/* The third-party licence texts are ~79 kB, which no reader who never
	 * opens one should download, so they are their own module fetched on the
	 * first click rather than on every About open. Awaiting the import
	 * BEFORE switching the view is what keeps the licence page from flashing
	 * empty; a failed fetch still opens it, saying so, because a dead button
	 * is worse than a bad line. */
	let licenseTexts = $state<Record<string, string> | null>(null);

	async function openLicense(id: string): Promise<void> {
		if (!licenseTexts) {
			// A rejected import leaves licenseTexts null, which the view
			// already renders as "could not be loaded"; the page still opens.
			try {
				const mod = await import('$lib/data/thirdPartyLicenseTexts');
				licenseTexts = mod.THIRD_PARTY_LICENSE_TEXTS;
			} catch {
				/* handled by the null text below */
			}
		}
		showLicense(id);
	}

	/** What the licence view shows: a package plus its text, or null for the
	 *  app's own MIT, which is inlined and always there. */
	const shownLicense = $derived.by(() => {
		const id = aboutModal.licenseId;
		if (id === null) {
			return null;
		}
		const entry = thirdPartyLicense(id);
		return entry ? { ...entry, text: licenseTexts?.[id] ?? null } : null;
	});

	// WMM2025 validity advisory (one boolean; the wall clock can't cross
	// 2030.0 mid-session in any way worth tracking).
	const wmmExpired = magneticModelExpired(new Date());

	// Diagnostics panel: dev-only counters that surface AIXM 5.1 decoder
	// drift. Vite's `import.meta.env.DEV` is statically inlined; in a
	// production build the panel block evaluates to false and the
	// branch is dead-code-eliminated. Gated together so a missing meta
	// silently hides the row.
	const devMode = import.meta.env.DEV;
</script>

<SurfaceShell
	id="about"
	onClose={closeAbout}
	labelledby="about-title"
	closeLabel={t.about.closeAbout}
	boxClass="about-box"
>
	{#snippet header()}
		<h2 id="about-title">
			<!-- i18n-ignore-start: product brand and release channel, invariant -->
			<span class="brand">Loxodrome</span>
			<span class="beta-badge" title={t.common.betaTip(__APP_VERSION__)}>BETA</span>
			<!-- i18n-ignore-end -->
			<!-- The full version and the short SHA, which together pin a bug
			     report to a build. Empty-version fallback keeps this honest
			     even if Vite's define ever resolves to an unexpected blank. -->
			<span class="version">v{__APP_VERSION__ || '0'} · {__APP_SHA__}</span>
		</h2>
	{/snippet}

	{#if aboutModal.view === 'license'}
			<div class="body license">
				<button type="button" class="back" onclick={showAbout}>
					<Icon name="chevron-left" size={16} />
					<span>{t.about.backToAbout}</span>
				</button>
				{#if shownLicense}
					<!-- i18n-ignore-start: package name, version and licence id, invariant -->
					<p class="lic-head">
						<a href={shownLicense.url} target="_blank" rel="noopener noreferrer">{shownLicense.name}</a>
						<span class="version">{shownLicense.version}</span>
						<span class="lic">{shownLicense.spdx}</span>
					</p>
					<!-- i18n-ignore-end -->
					{#if shownLicense.text}
						<pre lang="en">{shownLicense.text}</pre>
					{:else}
						<p class="muted">{t.about.licenseTextUnavailable}</p>
					{/if}
				{:else}
					<pre lang="en">{MIT_LICENSE_TEXT}</pre>
				{/if}
			</div>
		{:else}
		<div class="body">
			<p class="tagline">
				{t.about.tagline}
			</p>

			<!-- What the application does, before where its controls are: the
			     four phases of the flight it serves. The briefing is one of
			     them. The app is named after it and grew out of it, but it has
			     not been the frame the rest hangs off for a long time. -->
			<section>
				<h3>{t.about.whatItDoesHeading}</h3>
				<ul class="does">
					<li><strong>{t.about.doesChartLabel}</strong>{t.about.doesChart}</li>
					<li><strong>{t.about.doesPrepLabel}</strong>{t.about.doesPrep}</li>
					<li><strong>{t.about.doesBriefingLabel}</strong>{t.about.doesBriefing}</li>
					<li><strong>{t.about.doesFlightLabel}</strong>{t.about.doesFlight}</li>
					<li><strong>{t.about.doesAccountLabel}</strong>{t.about.doesAccount}</li>
				</ul>
			</section>

			<section>
				<h3>{t.about.howToHeading}</h3>
				<ul class="tabs">
					<!-- i18n-ignore: file extension, invariant -->
					<li><strong>{t.tabs.notams}</strong>{t.about.tabNotamsDesc1}<code>.txt</code>{t.about.tabNotamsDesc2}</li>
					<li><strong>{t.tabs.airports}</strong>{t.about.tabAirportsDesc}</li>
					<li><strong>{t.tabs.route}</strong>{t.about.tabRouteDesc}</li>
					<!-- In sidebar order, so the list reads down the rail. -->
					<li><strong>{t.tabs.aircraft}</strong>{t.about.tabAircraftDesc}</li>
					<li><strong>{t.tabs.weather}</strong>{t.about.tabWeatherDesc}</li>
					<li><strong>{t.tabs.navigation}</strong>{t.about.tabNavigationDesc}</li>
					<li><strong>{t.tabs.layers}</strong>{t.about.tabLayersDesc}</li>
					<li><strong>{t.tabs.settings}</strong>{t.about.tabSettingsDesc}</li>
				</ul>
				<!-- What belongs to no tab: the conditions the whole map is read
				     at, the map's own "what is here?" query, and the two keys
				     that answer from anywhere. -->
				<p class="muted">{t.about.conditionsHint}</p>
				<p class="muted">{t.about.rightClickHint}</p>
				<p class="muted">{t.about.searchHint}</p>
			</section>

			<section class="disclaimer">
				<h3>{t.about.disclaimerHeading}</h3>
				<p>
					{t.about.disclaimer1}
					<strong>{t.about.disclaimerStrong}</strong>{t.about.disclaimer2}
				</p>
			</section>

			<section>
				<h3>{t.about.privacyHeading}</h3>
				<p>{t.about.privacyIntro}</p>
				<!-- What never leaves the device comes before the list of what
				     does: the position first, since the app holds a location
				     permission, then the device storage and the one gesture
				     that erases it.
				     This section is also the SOURCE of the hosted privacy
				     policy the Play listing points at: scripts/gen-privacy.js
				     generates public/privacy.html from these very strings, in
				     this order, and tests/privacyPage.spec.ts fails when the
				     two disagree. Reordering the list here reorders the
				     published policy. -->
				<p>{t.about.privacyPosition}</p>
				<p>{t.about.privacyStored}</p>
				<p>{t.about.privacyAccount}</p>
				<ul class="privacy">
					<!-- i18n-ignore-start: service domain names, invariant -->
					<!-- The first two are unconditional: the map fetches tiles to
					     draw, and the route profile / min-alt corridor / airspace
					     alerts fetch terrain to answer at all. Listing them first
					     is the honest order, since no toggle stops either. -->
					<li>{t.about.privacyTiles}</li>
					<li>{t.about.privacyTerrain}</li>
					<li>
						{t.about.privacyAutorouter}
						<a href="https://www.autorouter.aero/" target="_blank" rel="noopener noreferrer"><code>autorouter.aero</code></a>
					</li>
					<!-- The other NOTAM source, which sends the same thing to a
					     different service: listed on its own line rather than
					     folded into autorouter's, since the two are separate
					     relays to separate providers. -->
					<li>{t.about.privacySofiaNotam}</li>
					<li>{t.about.privacyWeather}</li>
					<li>
						{t.about.privacyWindsAloft}
						<code>api.open-meteo.com</code>
					</li>
					<li>{t.about.privacySofia}</li>
					<!-- i18n-ignore-end -->
				</ul>
				<p>{t.about.privacyProxy}</p>
				<p>{t.about.privacyHosting}</p>
				<p>{t.about.privacyToggleOff}</p>
			</section>

			<!-- The credits below are classified by TYPE of data, one section
			     each: what a source IS is what files it, never who publishes it
			     and never how it reaches the device. Two rules hold inside a
			     section.

			     ORDER. France leads, being the home State and the one dataset
			     built by hand, then the two worldwide sets the national data
			     overlays, then the publishers by their country name IN THE
			     READING LANGUAGE (byPublisherName). The names are the Layers
			     tab's own, so no second list of countries exists to drift, and
			     the collator is what makes the French list read Allemagne,
			     Autriche, Belgique rather than the English order translated.

			     CONTAINERS. `.sources` is a multicolumn flow and a
			     DataSourceCard's shared label column is resolved per container
			     (10.5rem for the figure cards, 5.5rem for the prose ones), so a
			     section holding both keeps them in two containers rather than
			     one. Only Weather holds both; that alignment is what the old
			     Data sets / Live services split was really buying, and it is
			     bought here without spending the heading on it.

			     What those headings said is not lost: every card states its own
			     Fetched or Refresh row, and which requests leave the device is
			     the Privacy section above, which is also the one published as
			     the hosted policy. -->
			<section>
				<h3>{t.about.aipHeading}</h3>
				{#if metaError}
					<p class="muted">{t.about.metaUnavailable(metaError)}</p>
				{:else if !meta}
					<p class="muted">{t.about.loadingSources}</p>
				{:else}
					{@const m = meta}
					<div class="sources">
						<DataSourceCard>
							{#snippet heading()}
								<a href="https://www.sia.aviation-civile.gouv.fr/" target="_blank" rel="noopener noreferrer">{t.about.headFrance}</a>
							{/snippet}
							{@const frCell = loadedCycle('fr')}
							{@const frNext = announceNextCycle(frCell, m.frenchNext?.effective)}
							<dt>AIRAC</dt>
							<dd>{fmtAiracDate(frCell?.effective ?? m.french.effective)}</dd>
							{#if frNext}
								<dt>{t.about.nextCycle}</dt>
								<dd>
									{fmtAiracDate(frNext)}
									<span class="aside">({fmtRelative(frNext)})</span>
								</dd>
							{/if}
							<dt>{t.about.generated}</dt>
							<dd class={freshnessClass(m.french.generatedAt)}>
								{fmtUTC(m.french.generatedAt)}
								<span class="aside">({fmtAgo(m.french.generatedAt)})</span>
							</dd>
							<dt>{t.layers.airspaces}</dt>
							<dd>{fmtNumber(m.french.airspaceCount)}</dd>
							{#if m.obstacles}
								<dt>{t.layers.obstacles}</dt>
								<dd>
									{fmtNumber(m.obstacles.obstacleCount)}
									<span class="aside">({t.about.obstaclesAside({ lit: fmtNumber(m.obstacles.litCount), windTurbines: fmtNumber(m.obstacles.counts.windturbine ?? 0) })})</span>
								</dd>
							{/if}
							{#if m.navaids}
								<dt>{t.layers.navaids}</dt>
								<dd>
									{fmtNumber(m.navaids.navaidCount)}
									<span class="aside">({t.about.navaidsAside(fmtNumber(m.navaids.counts.WAYPOINT ?? 0))})</span>
								</dd>
							{/if}
							{#if m.frFacilities}
								<dt>{t.about.facilitiesLabel}</dt>
								<dd>
									{fmtNumber(m.frFacilities.aerodromeCount)}
									{#if m.frFacilities.heliportCount}
										<span class="aside">({t.about.heliportsAside(fmtNumber(m.frFacilities.heliportCount))})</span>
									{/if}
								</dd>
							{/if}
							{#each natureRows(m.frNature) as row (row.type)}
								<dt>{t.data.natureTypes[row.type]}</dt>
								<dd>{fmtNumber(row.count)}</dd>
							{/each}
							<dt>{t.about.licenseLabel}</dt>
							<dd class="muted">{t.about.licFrance}</dd>
							<dt>{t.about.refresh}</dt>
							<dd class="muted">{t.about.refreshManual}</dd>
						</DataSourceCard>

						{#if m.supaip}
							{@const sup = m.supaip}
							<DataSourceCard>
								{#snippet heading()}
									<a href="https://www.sia.aviation-civile.gouv.fr/" target="_blank" rel="noopener noreferrer">{t.about.headSupAip}</a>
								{/snippet}
								<dt>{t.about.generated}</dt>
								<dd class={freshnessClass(sup.generatedAt)}>
									{fmtUTC(sup.generatedAt)}
									<span class="aside">({fmtAgo(sup.generatedAt)})</span>
								</dd>
								<dt>{t.about.supplementsLabel}</dt>
								<dd>
									{fmtNumber(sup.total)}
									<span class="aside">({t.about.supAside({ active: fmtNumber(sup.active), withGeometry: fmtNumber(sup.withGeometry) })})</span>
								</dd>
								<dt>{t.about.licenseLabel}</dt>
								<dd class="muted">{t.about.licFrance}</dd>
								<dt>{t.about.refresh}</dt>
								<dd class="muted">{t.about.refreshWeekly}</dd>
							</DataSourceCard>
						{/if}

						<DataSourceCard>
							{#snippet heading()}
								<a href="https://ourairports.com/" target="_blank" rel="noopener noreferrer">{t.about.headOurAirports}</a> {t.about.headOurAirportsSuffix}
							{/snippet}
							{@const apCell = dataState.airac.airports.fr}
							{@const apNext = announceNextCycle(apCell, m.frAirportsNext?.effective)}
							{#if apCell?.effective ?? m.frAirports?.effective}
								<dt>AIRAC (FR AIXM)</dt>
								<dd>{fmtAiracDate(apCell?.effective ?? m.frAirports?.effective)}</dd>
							{/if}
							{#if apNext}
								<dt>{t.about.nextCycle}</dt>
								<dd>
									{fmtAiracDate(apNext)}
									<span class="aside">({fmtRelative(apNext)})</span>
								</dd>
							{/if}
							<dt>{t.about.generated}</dt>
							<dd class={freshnessClass(m.airports.generatedAt)}>
								{fmtUTC(m.airports.generatedAt)}
								<span class="aside">({fmtAgo(m.airports.generatedAt)})</span>
							</dd>
							<dt>{t.layers.airports}</dt>
							<dd>
								{fmtNumber(m.airports.rowCount)}
								<!-- Counted rather than listed: ten publishers now
								     overlay this baseline and a hand-written list
								     of five was already wrong. Each publisher's own
								     figure is on its own card. -->
								{#if airportOverlays.publishers > 0}
									<span class="aside">({t.about.overlaysAside({ count: fmtNumber(airportOverlays.rows), publishers: fmtNumber(airportOverlays.publishers) })})</span>
								{/if}
							</dd>
							<dt>{t.detail.runways}</dt>
							<dd>{fmtNumber(m.airports.runwayCount)}</dd>
							<dt>{t.about.licenseLabel}</dt>
							<dd class="muted">{t.about.licOurAirports}</dd>
							<dt>{t.about.refresh}</dt>
							<dd class="muted">{t.about.refreshMonthly}</dd>
						</DataSourceCard>

						{#if m.pruatlas}
							{@const pru = m.pruatlas}
							<DataSourceCard>
								{#snippet heading()}
									<!-- i18n-ignore: product name, invariant -->
									<a href="https://github.com/euctrl-pru/pruatlas" target="_blank" rel="noopener noreferrer">EUROCONTROL pruatlas</a>
								{/snippet}
								<dt>AIRAC</dt>
								<dd>
									AIRAC {airacYYNN(pru.generatedAt)}
									{#if pru.source.cycle != null}
										<!-- i18n-ignore: product name, invariant -->
										<span class="aside">(pruatlas ir-{pru.source.cycle})</span>
									{/if}
								</dd>
								<dt>{t.about.generated}</dt>
								<dd class={freshnessClass(pru.generatedAt)}>
									{fmtUTC(pru.generatedAt)}
									<span class="aside">({fmtAgo(pru.generatedAt)})</span>
								</dd>
								<dt>{t.about.firsUirs}</dt>
								<dd>{fmtNumber(pru.source.count)}</dd>
								<dt>{t.about.licenseLabel}</dt>
								<dd class="muted">{t.about.licPruatlas}</dd>
								<dt>{t.about.refresh}</dt>
								<dd class="muted">{t.about.refreshWeekly}</dd>
							</DataSourceCard>
						{/if}

						<!-- ONE template for every publisher, the FAA included: its
						     three airspace products ride an optional field on the
						     shared record rather than a card of their own, so the
						     sort has one list to order and the rows every publisher
						     shares cannot drift between two copies. -->
						{#each publisherCards as c (c.key)}
							<DataSourceCard>
								{#snippet heading()}
									<a href={c.href} target="_blank" rel="noopener noreferrer">{c.head}</a>
								{/snippet}
								{@const stamp = c.airspaces ?? c.cycle}
								<!-- The loaded cycle is looked up only for a card that
								     already claims one AND states an effective date of
								     its own. Switzerland deliberately claims none (FOCA
								     revises as needed and its date is a publication
								     date), and it still has an obstacles cell in the
								     AIRAC matrix, so reading that cell unconditionally
								     would label that date AIRAC; the FAA hub publishes
								     no effective date at all, so its cycle is read off
								     the generation date instead. -->
								{@const cell = stamp && !c.airacFromGenerated ? loadedCycle(c.key) : undefined}
								{@const nextCyc = announceNextCycle(cell, undefined)}
								{#if c.airacFromGenerated}
									{#if stamp}
										<dt>AIRAC</dt>
										<dd>AIRAC {airacYYNN(stamp.generatedAt)}</dd>
									{/if}
								{:else if cell?.effective ?? stamp?.effective}
									<dt>AIRAC</dt>
									<dd>{fmtAiracDate(cell?.effective ?? stamp?.effective)}</dd>
								{/if}
								{#if nextCyc}
									<dt>{t.about.nextCycle}</dt>
									<dd>
										{fmtAiracDate(nextCyc)}
										<span class="aside">({fmtRelative(nextCyc)})</span>
									</dd>
								{/if}
								{#if stamp?.generatedAt}
									<dt>{t.about.generated}</dt>
									<dd class={freshnessClass(stamp.generatedAt)}>
										{fmtUTC(stamp.generatedAt)}
										<span class="aside">({fmtAgo(stamp.generatedAt)})</span>
									</dd>
								{/if}
								{#if c.usAirspaces}
									<!-- i18n-ignore-start: FAA dataset names, invariant -->
									<dt>Boundary</dt>
									<dd>{t.about.airspacesCount(fmtNumber(c.usAirspaces.boundary.count))}</dd>
									<dt>Special-Use</dt>
									<dd>{t.about.airspacesCount(fmtNumber(c.usAirspaces.specialUse.count))}</dd>
									<!-- i18n-ignore-end -->
									<dt>{t.about.faaClass}</dt>
									<dd>{t.about.airspacesCount(fmtNumber(c.usAirspaces.class.count))}</dd>
								{/if}
								{#if c.airspaces}
									<dt>{t.layers.airspaces}</dt>
									<dd>{fmtNumber(c.airspaces.airspaceCount)}</dd>
								{/if}
								{#if c.airports}
									<dt>{t.layers.airports}</dt>
									{#if c.bareCounts}
										<dd>{fmtNumber(c.airports.ahpCount)}</dd>
									{:else}
										<dd>
											{fmtNumber(c.airports.ahpCount)}
											<span class="aside">({t.about.runwaysAside(fmtNumber(c.airports.runwayCount))})</span>
										</dd>
									{/if}
								{/if}
								{#if c.obstacles}
									<dt>{t.layers.obstacles}</dt>
									<dd>
										{fmtNumber(c.obstacles.obstacleCount)}
										<span class="aside">({t.about.obstaclesAside({ lit: fmtNumber(c.obstacles.litCount), windTurbines: fmtNumber(c.obstacles.counts.windturbine ?? 0) })})</span>
									</dd>
								{/if}
								{#if c.navaids}
									<dt>{t.layers.navaids}</dt>
									{#if c.bareCounts}
										<dd>{fmtNumber(c.navaids.navaidCount)}</dd>
									{:else}
										<dd>
											{fmtNumber(c.navaids.navaidCount)}
											<span class="aside">({t.about.navaidsAside(fmtNumber(c.navaids.counts.WAYPOINT ?? 0))})</span>
										</dd>
									{/if}
								{/if}
								{#if c.facilities}
									<dt>{t.about.facilitiesLabel}</dt>
									<dd>
										{fmtNumber(c.facilities.aerodromeCount)}
										{#if c.facilities.heliportCount}
											<span class="aside">({t.about.heliportsAside(fmtNumber(c.facilities.heliportCount))})</span>
										{/if}
									</dd>
								{/if}
								<!-- One row per family the publisher actually files:
								     Belgium's set is bird areas, France's is parks
								     and sensitive sites, Italy's is reserves. A
								     single hardcoded label got the other two
								     wrong. -->
								{#each natureRows(c.nature) as row (row.type)}
									<dt>{t.data.natureTypes[row.type]}</dt>
									<dd>{fmtNumber(row.count)}</dd>
								{/each}
								{#if c.supaip}
									<dt>{t.detail.supAip}</dt>
									<dd>{fmtNumber(c.supaip.total)}</dd>
								{/if}
								<dt>{t.about.licenseLabel}</dt>
								<dd class="muted">
									{c.license}
									<!-- The OFMA licence asks an application to give its users a
									     way to report errors back, so the address it names has to
									     be reachable from here rather than printed as prose
									     (docs/it-aip.md). -->
									{#if c.key === 'it'}
										<!-- i18n-ignore: project domain name, invariant -->
										<a href="https://openflightmaps.org/" target="_blank" rel="noopener noreferrer">openflightmaps.org</a>
									{/if}
								</dd>
								<dt>{t.about.refresh}</dt>
								<dd class="muted">{t.about.refreshWeekly}</dd>
							</DataSourceCard>
						{/each}
					</div>
				{/if}
			</section>

			{#if devMode && meta}
				<!-- i18n-ignore-start: dev-only diagnostics, stripped from production builds -->
				<section class="diag">
					<h3>AIXM 5.1 decoder diagnostics (dev)</h3>
					<p class="muted">
						Soft-skip and unresolved-xlink counters from
						<code>internal/aixm5</code>. Zero across the board means
						the publisher's schema still matches our decoder; any
						non-zero value is a sign the upstream feed drifted.
						This block is stripped from production builds.
					</p>
					<AixmDiagnosticsTable {meta} />
				</section>
				<!-- i18n-ignore-end -->
			{/if}

			<section>
				<h3>{t.about.adChartsHeading}</h3>
				{#if metaError}
					<p class="muted">{t.about.metaUnavailable(metaError)}</p>
				{:else if !meta}
					<p class="muted">{t.about.loadingSources}</p>
				{:else}
					{@const m = meta}
					<div class="sources">
						{#if m.frAdCharts}
							{@const adc = m.frAdCharts}
							<DataSourceCard>
								{#snippet heading()}
									<a href="https://www.sia.aviation-civile.gouv.fr/" target="_blank" rel="noopener noreferrer">{t.about.headAdCharts}</a>
								{/snippet}
								<dt>{t.about.generated}</dt>
								<dd class={freshnessClass(adc.generatedAt)}>
									{fmtUTC(adc.generatedAt)}
									<span class="aside">({fmtAgo(adc.generatedAt)})</span>
								</dd>
								<dt>{t.about.adChartsLabel}</dt>
								<dd>
									{fmtNumber(adc.charts)}
									<span class="aside">({t.about.adChartsAside({ aerodromes: fmtNumber(adc.aerodromes) })})</span>
								</dd>
								<dt>{t.about.licenseLabel}</dt>
								<dd class="muted">{t.about.licFrance}</dd>
								<dt>{t.about.refresh}</dt>
								<dd class="muted">{t.about.refreshWeekly}</dd>
							</DataSourceCard>
						{/if}

						{#if m.frVacGeo}
							{@const vg = m.frVacGeo}
							<DataSourceCard>
								{#snippet heading()}
									<a href="https://www.sia.aviation-civile.gouv.fr/" target="_blank" rel="noopener noreferrer">{t.about.headVacGeo}</a>
								{/snippet}
								<dt>{t.about.generated}</dt>
								<dd class={freshnessClass(vg.generatedAt)}>
									{fmtUTC(vg.generatedAt)}
									<span class="aside">({fmtAgo(vg.generatedAt)})</span>
								</dd>
								<dt>{t.about.vacGeoLabel}</dt>
								<dd>
									{fmtNumber(vg.panels)}
									<span class="aside">({t.about.vacGeoAside({ aerodromes: fmtNumber(vg.aerodromes) })})</span>
								</dd>
								<dt>{t.about.licenseLabel}</dt>
								<dd class="muted">{t.about.licFrance}</dd>
								<dt>{t.about.refresh}</dt>
								<dd class="muted">{t.about.refreshWeekly}</dd>
							</DataSourceCard>
						{/if}

						{#each adChartCards as c (c.key)}
							<DataSourceCard>
								{#snippet heading()}
									<a href={c.href} target="_blank" rel="noopener noreferrer">{c.head}</a>
								{/snippet}
								<dt>{t.about.generated}</dt>
								<dd class={freshnessClass(c.generatedAt)}>
									{fmtUTC(c.generatedAt)}
									<span class="aside">({fmtAgo(c.generatedAt)})</span>
								</dd>
								{#if c.charts}
									<dt>{t.about.adChartsLabel}</dt>
									<dd>
										{fmtNumber(c.charts.count)}
										<span class="aside">({t.about.chartsAside(fmtNumber(c.charts.sites))})</span>
									</dd>
								{/if}
								{#if c.pages != null}
									<dt>{t.about.adChartsLabel}</dt>
									<dd>{t.about.chartPages(fmtNumber(c.pages))}</dd>
								{/if}
								<dt>{t.about.licenseLabel}</dt>
								<dd class="muted">{c.license}</dd>
								<dt>{t.about.refresh}</dt>
								<dd class="muted">{t.about.refreshWeekly}</dd>
							</DataSourceCard>
						{/each}
					</div>
				{/if}
			</section>

			<section>
				<h3>{t.about.chartsHeading}</h3>
				<!-- Straight from the chart-layer registry (chartOverlays.ts):
				     label, product page and licence live there, so a layer
				     credits itself the moment it publishes. -->
				<ul class="libs charts">
					{#each publishedChartLayers() as def (def.id)}
						<li>
							<a href={def.homepage} target="_blank" rel="noopener noreferrer">{def.label}</a>
							<span class="lic">{def.license}</span>
						</li>
					{/each}
				</ul>
			</section>

			<section>
				<h3>{t.about.notamHeading}</h3>
				<div class="sources">
					<DataSourceCard prose>
						{#snippet heading()}
							<a href="https://www.autorouter.aero/" target="_blank" rel="noopener noreferrer">{t.about.headArNotam}</a>
						{/snippet}
						<dt>{t.about.dataLabel}</dt>
						<dd>{t.about.arNotamData}</dd>
						<dt>{t.about.licenseLabel}</dt>
						<dd class="muted">{t.about.licAutorouter}</dd>
					</DataSourceCard>

					<DataSourceCard prose>
						{#snippet heading()}
							<a href="https://sofia-briefing.aviation-civile.gouv.fr/" target="_blank" rel="noopener noreferrer">{t.about.headSofiaNotam}</a>
						{/snippet}
						<dt>{t.about.dataLabel}</dt>
						<dd>{t.about.sofiaNotamData}</dd>
						<dt>{t.about.licenseLabel}</dt>
						<dd class="muted">{t.about.licSofiaNotam}</dd>
					</DataSourceCard>
				</div>
			</section>

			<section>
				<h3>{t.about.weatherHeading}</h3>
				<!-- Two containers, not two sections: the station catalog is a
				     figure card and the three services are prose ones, and the
				     shared label column each resolves is per container. -->
				{#if metaError}
					<p class="muted">{t.about.metaUnavailable(metaError)}</p>
				{:else if !meta}
					<p class="muted">{t.about.loadingSources}</p>
				{:else}
					{@const m = meta}
					<div class="sources">
						{#if m.metarStations}
							{@const ms = m.metarStations}
							<DataSourceCard>
								{#snippet heading()}
									<a href="https://aviationweather.gov/data/api/" target="_blank" rel="noopener noreferrer">{t.about.headMetarStations}</a>
								{/snippet}
								<dt>{t.about.generated}</dt>
								<dd class={freshnessClass(ms.generatedAt)}>
									{fmtUTC(ms.generatedAt)}
									<span class="aside">({fmtAgo(ms.generatedAt)})</span>
								</dd>
								<dt>{t.about.stationCatalogLabel}</dt>
								<dd>
									{t.about.stationsCount(fmtNumber(ms.stationCount))}
									<span class="aside">({t.about.stationsAside({ taf: fmtNumber(ms.tafCount), countries: fmtNumber(ms.countryCount) })})</span>
								</dd>
								<dt>{t.about.refresh}</dt>
								<dd class="muted">{t.about.refreshWeekly}</dd>
								<dt>{t.about.licenseLabel}</dt>
								<dd class="muted">{t.about.licNoaa}</dd>
							</DataSourceCard>
						{/if}
					</div>
				{/if}
				<div class="sources">
					<DataSourceCard prose>
						{#snippet heading()}
							<a href="https://aviationweather.gov/" target="_blank" rel="noopener noreferrer">{t.about.headNoaa}</a>
						{/snippet}
						<dt>{t.about.dataLabel}</dt>
						<dd>{t.about.noaaData}</dd>
						<dt>{t.about.fetchedLabel}</dt>
						<dd>
							{t.about.noaaFetched}
							<span class="aside">{t.about.noaaFetchedAside}</span>
						</dd>
						<dt>{t.about.licenseLabel}</dt>
						<dd class="muted">{t.about.licNoaa}</dd>
					</DataSourceCard>

					<DataSourceCard prose>
						{#snippet heading()}
							<a href="https://sofia-briefing.aviation-civile.gouv.fr/" target="_blank" rel="noopener noreferrer">{t.about.headSofia}</a>
						{/snippet}
						<dt>{t.about.dataLabel}</dt>
						<dd>{t.about.sofiaData}</dd>
						<dt>{t.about.fetchedLabel}</dt>
						<dd>
							{t.about.sofiaFetched}
							<span class="aside">{t.about.sofiaFetchedAside}</span>
						</dd>
						<dt>{t.about.licenseLabel}</dt>
						<dd class="muted">{t.about.licSofia}</dd>
					</DataSourceCard>

					<DataSourceCard prose>
						{#snippet heading()}
							<a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">{t.about.headOpenMeteo}</a>
						{/snippet}
						<dt>{t.about.dataLabel}</dt>
						<dd>
							{t.about.omData}
						</dd>
						<dt>{t.about.fetchedLabel}</dt>
						<dd>
							{t.about.omFetched}
							<span class="aside">{t.about.omFetchedAside}</span>
						</dd>
						<dt>{t.about.licenseLabel}</dt>
						<dd class="muted">
							{t.about.licOpenMeteo}
							<!-- i18n-ignore: service domain name, invariant -->
							<a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo.com</a>,
							CC BY 4.0
						</dd>
					</DataSourceCard>
				</div>
			</section>

			<section>
				<h3>{t.about.aircraftHeading}</h3>
				{#if metaError}
					<p class="muted">{t.about.metaUnavailable(metaError)}</p>
				{:else if !meta}
					<p class="muted">{t.about.loadingSources}</p>
				{:else}
					{@const m = meta}
					<div class="sources">
						{#if m.aircraft}
							{@const ac = m.aircraft}
							<DataSourceCard>
								{#snippet heading()}
									{t.about.headAircraft}
								{/snippet}
								<dt>{t.tabs.aircraft}</dt>
								<dd>
									{fmtNumber(ac.aircraftCount)}
									<span class="aside">({Object.entries(ac.counts).map(([type, n]) => (n > 1 ? `${type} x${n}` : type)).join(', ')})</span>
								</dd>
								<dt>{t.about.generated}</dt>
								<dd>{fmtUTC(ac.generatedAt)}</dd>
								<dt>{t.about.licenseLabel}</dt>
								<dd class="muted">{t.about.licAircraft}</dd>
								<dt>{t.about.refresh}</dt>
								<dd class="muted">{t.about.aircraftRefresh}</dd>
							</DataSourceCard>
						{/if}

						{#if m.faaDesignators}
							{@const fd = m.faaDesignators}
							<DataSourceCard>
								{#snippet heading()}
									<a href={fd.source} target="_blank" rel="noopener noreferrer">{t.about.headFaaDesignators}</a>
								{/snippet}
								<dt>{t.about.editionLabel}</dt>
								<dd>
									{fd.edition}
									<span class="aside">({t.about.effectiveAside(fd.effectiveDate)})</span>
								</dd>
								<dt>{t.about.designatorsLabel}</dt>
								<dd>
									{fmtNumber(fd.designatorCount)}
									<span class="aside">({t.about.designatorModelsAside(fmtNumber(fd.modelCount))})</span>
								</dd>
								<dt>{t.about.refresh}</dt>
								<dd class="muted">{t.about.faaDesignatorsRefresh}</dd>
								<dt>{t.about.licenseLabel}</dt>
								<dd class="muted">{t.about.licNoaa}</dd>
							</DataSourceCard>
						{/if}
					</div>
				{/if}
			</section>

			<section>
				<h3>{t.about.mapDataHeading}</h3>
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
			</section>

			<section>
				<h3>{t.about.terrainHeading}</h3>
				<div class="sources">
					<!-- The tiles carry no cycle and no count, so the card is
					     data + licence: what matters is that a safety-adjacent
					     elevation source is named at all
					     (src/lib/map/terrain.ts). It sits beside the geoid it
					     reads with, both of them answering a question about
					     height.
					     The heading names no publisher because the mosaic is
					     ours (cmd/terrain); who to credit is the Sources row,
					     and it comes from the manifest so that adding a tier
					     cannot leave its notice unprinted. -->
					<DataSourceCard prose>
						{#snippet heading()}
							{t.about.headTerrain}
						{/snippet}
						<dt>{t.about.dataLabel}</dt>
						<dd>{t.about.terrainData}</dd>
						<dt>{t.about.fetchedLabel}</dt>
						<dd>{t.about.terrainFetched}</dd>
						<dt>{t.about.licenseLabel}</dt>
						<dd class="muted">{t.about.licTerrain}</dd>
						{#if terrainTiers.length > 0}
							<dt>{t.about.terrainTiersLabel}</dt>
							<dd class="muted">
								<ul class="tiers">
									{#each terrainTiers as tier (tier.id)}
										<!-- i18n-ignore: the notice each source's licence demands, carried verbatim -->
										<li>{tier.label}: {tier.attribution}</li>
									{/each}
								</ul>
							</dd>
						{/if}
					</DataSourceCard>

					<DataSourceCard prose>
						{#snippet heading()}
							<a href="https://earth-info.nga.mil/index.php?dir=wgs84&action=wgs84" target="_blank" rel="noopener noreferrer">{t.about.headEgm96}</a>
						{/snippet}
						<dt>{t.about.dataLabel}</dt>
						<dd>{t.about.egm96Data}</dd>
						<dt>{t.about.licenseLabel}</dt>
						<dd class="muted">{t.about.licEgm96}</dd>
					</DataSourceCard>
				</div>
			</section>

			<section>
				<h3>{t.about.magneticHeading}</h3>
				<div class="sources">
					<DataSourceCard prose>
						{#snippet heading()}
							<a href="https://www.ncei.noaa.gov/products/world-magnetic-model" target="_blank" rel="noopener noreferrer">{t.about.headWmm}</a>
						{/snippet}
						<dt>{t.about.dataLabel}</dt>
						<dd>{t.about.wmmData}</dd>
						{#if wmmExpired}
							<dt>{t.about.wmmExpiredLabel}</dt>
							<dd class="expired">{t.about.wmmExpired}</dd>
						{/if}
						<dt>{t.about.licenseLabel}</dt>
						<dd class="muted">{t.about.licWmm}</dd>
					</DataSourceCard>
				</div>
			</section>

			<section>
				<h3>{t.about.librariesHeading}</h3>
				<!-- Generated from the build's own source maps, not hand-kept: the
				     rule this section states, runtime code in the shipped bundle
				     rather than build tooling, is one a list written by hand keeps
				     or breaks silently, and it had broken. It credited fourteen of
				     the thirty-seven packages that ship, named Vite (which
				     contributes no module at all) and missed html2canvas and the
				     canvg stack, each of which ships as its own chunk exactly the
				     way DOMPurify does, DOMPurify having been credited for that
				     reason. scripts/gen-licenses.js reads what actually shipped and
				     tests/thirdPartyLicenses.spec.ts fails when the two disagree.

				     The licence id opens the licence itself. Naming a licence is
				     not carrying it, and MIT, BSD, Apache-2.0 and MPL-2.0 all
				     require the notice to travel with the software; minification
				     strips every one of them from the bundle. -->
				<!-- i18n-ignore-start: library, version and licence names, invariant (docs/i18n.md rule 10) -->
				<ul class="libs">
					{#each THIRD_PARTY_LICENSES as lib (lib.id)}
						<li>
							<a href={lib.url} target="_blank" rel="noopener noreferrer">{lib.name}</a>
							<button type="button" class="lic" onclick={() => void openLicense(lib.id)}>{lib.spdx}</button>
						</li>
					{/each}
				</ul>
				<!-- i18n-ignore-end -->
			</section>

			<section>
				<h3>{t.about.authorHeading}</h3>
				<p>
					{t.about.copyright}
					<button type="button" class="link" onclick={() => showLicense()}>{t.about.licenseMit}</button>.
				</p>
				<p>
					{t.about.sourceLabel}
					<!-- i18n-ignore: repository URL, invariant -->
					<a href="https://github.com/0intro/loxodrome" target="_blank" rel="noopener noreferrer">github.com/0intro/loxodrome</a>
					·
					<a href="https://github.com/0intro/loxodrome/issues" target="_blank" rel="noopener noreferrer">{t.about.reportIssue}</a>
				</p>
			</section>
		</div>
	{/if}
</SurfaceShell>

<style>
	/* Wider than the shared default. The modal is a 36-card account of every
	   source the app touches, and the cards only align when the label column
	   is one WIDTH rather than each card's own measurement; at 840px that
	   width leaves too little for the values and the French ones wrap two
	   lines deep (measured: the data-sets block 6112px tall at 840, 5339px
	   at 960). Still well inside a 1040px laptop. */
	:global(.about-box) {
		--modal-width: min(960px, 92vw);
	}

	h2 {
		margin: 0;
		flex: 1;
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 16px;
		font-weight: 500;
		text-transform: none;
		letter-spacing: normal;
	}

	.brand {
		font-weight: 700;
		color: var(--accent);
	}

	.version {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		color: var(--text-muted);
	}

	.body {
		flex: 1;
		overflow-y: auto;
		padding: 14px 16px 18px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text);
	}

	.body section {
		margin-top: 14px;
	}

	.body h3 {
		margin: 0 0 6px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}

	.body p {
		margin: 0 0 6px;
	}

	.body p.tagline {
		margin: 0 0 4px;
		color: var(--text);
	}

	.body p.muted {
		color: var(--text-muted);
	}

	.body ul {
		margin: 0;
		padding-left: 18px;
	}

	.body ul.does li,
	.body ul.tabs li,
	.body ul.privacy li {
		margin-bottom: 4px;
	}

	/* The cards flow down columns rather than across a row grid. Thirty-six
	   cards say between two and eleven things each, so a row grid stretched
	   every one to the tallest in its row and seventeen of them carried dead
	   space, the worst 185px. A column flow gives each its own height; the
	   reading order becomes column-major, which is how an index reads.
	   `columns` takes the track WIDTH, so the count still follows the box:
	   two beside each other in the dialog, one on a phone. */
	.body .sources {
		columns: 380px;
		column-gap: 10px;
		margin-top: 4px;
	}

	/* Three tracks rather than four, because a licence id is not always a
	   short one: the bundle carries "(MPL-2.0 OR Apache-2.0)" and rgbcolor's
	   "MIT OR SEE LICENSE IN FEEL-FREE.md" verbatim. Measured over the 37
	   entries, four columns wrapped six ids and stood 428px tall, three wrap
	   two and stand 352px, two wrap none but 462px: three is both the
	   shortest and the tidiest.

	   min() inside the minmax, not a bare track width: auto-fill still lays
	   a full track when the container is narrower than the minimum, so a
	   bare 300px (and worse, the charts list's 420px) pushed the phone's
	   body wider than its own box. */
	.body ul.libs {
		list-style: none;
		padding-left: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
		gap: 4px 12px;
	}

	/* A row is name | licence, not two things side by side. As a flex pair
	   the licence simply trailed the name, so twelve entries put it at
	   twelve different offsets (33px to 118px) and the column was not a
	   column; stacked into one column on a phone, all twelve still differed.
	   A fixed name track gives one licence x per grid column, which is the
	   same answer the data-source cards' shared label column gives. */
	.body ul.libs li {
		display: grid;
		grid-template-columns: minmax(0, 10rem) minmax(0, 1fr);
		column-gap: 10px;
		align-items: baseline;
	}

	.body ul.libs .lic {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		color: var(--text-muted);
	}

	/* The libraries' licence id is the way into the licence text, so it is a
	   button; the base rule above keeps it looking like the plain chip the
	   other two lists carry. */
	.body ul.libs button.lic {
		justify-self: start;
		padding: 0;
		border: none;
		background: transparent;
		text-align: left;
		cursor: pointer;
	}

	.body ul.libs button.lic:hover,
	.body ul.libs button.lic:focus-visible {
		color: var(--accent);
		text-decoration: underline;
	}

	/* Chart product names and their attributions both run long, and as two
	   inline items they wrapped around each other: "Naviair ANC 1/250 000"
	   broke over three lines with its attribution straggling beside it. Each
	   row is a two-track grid instead, so the name has a column of its own
	   and every attribution in a column starts at the same x. */
	.body ul.libs.charts {
		grid-template-columns: repeat(auto-fill, minmax(min(420px, 100%), 1fr));
	}

	.body ul.libs.charts li {
		grid-template-columns: minmax(0, min(16rem, 55%)) minmax(0, 1fr);
	}

	.body .disclaimer p {
		padding: 8px 10px;
		background: var(--surface-2);
		border-left: 3px solid var(--accent);
		border-radius: 4px;
	}

	.body code {
		font-family: ui-monospace, monospace;
		font-size: 12px;
		padding: 1px 4px;
		background: var(--surface-3);
		border-radius: 3px;
	}

	.body a,
	.body button.link {
		color: var(--accent);
		text-decoration: none;
	}

	.body a:hover,
	.body button.link:hover {
		text-decoration: underline;
	}

	.body button.link {
		background: transparent;
		border: none;
		padding: 0;
		font: inherit;
		cursor: pointer;
	}

	.body.license {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	/* Which licence this is, above its text: the package, the version the
	   notice belongs to, and the id it declares. The app's own licence needs
	   no such line, since the Author section it is reached from just said
	   all three. */
	.body.license .lic-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin: 0;
	}

	.body.license .lic-head .version,
	.body.license .lic-head .lic {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		color: var(--text-muted);
	}

	.body.license pre {
		margin: 0;
		font-family: ui-monospace, monospace;
		font-size: 12px;
		line-height: 1.55;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		color: var(--text);
	}

	.back {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 6px;
		margin-left: -6px;
		background: transparent;
		border: none;
		border-radius: 4px;
		font: inherit;
		color: var(--accent);
		cursor: pointer;
	}

	.back:hover {
		background: var(--surface-3);
		text-decoration: underline;
	}

	/* The elevation mosaic's per-tier credits. A bare list inside the card's
	 * value column: these are legal notices, one per source, and they are
	 * long, so they read as stacked lines rather than a run-on sentence.
	 * No bullet, since the label column already says what the rows are. */
	.tiers {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.tiers li + li {
		margin-top: 4px;
	}
</style>
