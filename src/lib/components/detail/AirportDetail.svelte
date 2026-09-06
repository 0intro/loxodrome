<script lang="ts">
	import type { Airport, Runway, RunwayLighting, LightLine } from '$lib/data/airports';
	import { i18n, t } from '$lib/state/i18n.svelte';
	import {
		prettyAirportType,
		formatSurface,
		chartLink,
		ifrChartLink,
		groupChartsByFamily,
		siaAtlasVacUrl,
	} from '$lib/data/airports';
	import { dedupeById } from '$lib/data/dedup';
	import { airspacesOver } from '$lib/data/airspaces';
	import { notamsByIdent, notamOwner, type IndexedNotam } from '$lib/state/notam.svelte';
	import { arpNotamsByIdent } from '$lib/state/notamAirportLinks.svelte';
	import {
		getAirspaces,
		ensureAirspaces,
		ensureAerodromeFacilities,
		facilitiesForIdent,
		ensureFrAdCharts,
		frAdChartsForIdent,
		frVacForIdent,
		ensureUkAdCharts,
		ukAdChartsForIdent,
		ensureUsAdCharts,
		usAdChartsForIdent,
		ensureAtAdCharts,
		atAdLinksForIdent,
		ensureDeAdCharts,
		deAdLinkForIdent,
		dataState,
	} from '$lib/state/data.svelte';
	import { notamEText } from '$lib/notam/sections';
	import { sortNotamsBySubject } from '$lib/notam/qcode';
	import {
		extractRunwayDesignators,
		normalizeRunwayDesignator,
	} from '$lib/notam/runwayRefs';
	import { airportStatus } from '$lib/map/airportSymbols';
	import { flyToVisible } from '$lib/map/focus';
	import { sortRadios } from '$lib/format/radio';
	import { formatAipRemark } from '$lib/format/remark';
	import { resolveLangPref } from '$lib/i18n/locale';
	import { display } from '$lib/state/display.svelte';
	import { currentAiracString } from '$lib/data/airac';
	import { vacDocName, vacDocNameFor } from '$lib/offline/docNames';
	import { docLinkClick, storedDoc, storedDocCycle } from '$lib/state/aipDocOpen';
	import { offlineDocs } from '$lib/state/offlineDocs.svelte';
	import { resolveAirportRadios } from '$lib/state/freqOverride.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import AltitudeProfile from './AltitudeProfile.svelte';
	import CoordButton from './CoordButton.svelte';
	import Fields from './Fields.svelte';
	import FrequencyList from './FrequencyList.svelte';
	import NotamCardList from './NotamCardList.svelte';
	import NotamGroup from './NotamGroup.svelte';
	import NotamRowList from './NotamRowList.svelte';
	import WeatherSection from './WeatherSection.svelte';

	interface Props {
		airport: Airport;
	}

	let { airport }: Props = $props();

	const location = $derived(
		[airport.city, airport.country].filter(Boolean).join(', '),
	);

	// Official chart link (FR Carte VAC PDF, or UK/ES AD 2 aerodrome page),
	// plus the France-only instrument-chart link rendered beside it (the SIA
	// eAIP AD 2 / AD 3 page anchored at its chart section). Stored fr-adcharts
	// rows widen the link gate to the military-run pages whose civil ifr flag
	// is false (LFRJ).
	const atAdLinks = $derived(atAdLinksForIdent(airport.ident));
	const deAdLink = $derived(deAdLinkForIdent(airport.ident));
	const ukStoredCharts = $derived(ukAdChartsForIdent(airport.ident));
	const usStoredCharts = $derived(usAdChartsForIdent(airport.ident));
	// The US primary link opens a real chart, not a page: the airport
	// diagram when published, else the first chart in the set.
	const usPrimaryUrl = $derived(
		(usStoredCharts.find((c) => c.code === 'ADC') ?? usStoredCharts[0])?.url ?? null,
	);
	const frVac = $derived(frVacForIdent(airport.ident));
	const charts = $derived(
		chartLink(
			airport,
			undefined,
			atAdLinks?.adUrl ?? null,
			deAdLink?.url ?? null,
			ukStoredCharts.length > 0,
			usPrimaryUrl,
			frVac,
		),
	);
	// A field carrying both Atlas VAC plates (the fifteen large aerodromes
	// with their own helicopter chart) links the second one beside the first;
	// `chartLink` picked whichever matches the field's own kind.
	const frHelVacUrl = $derived(
		frVac === 'both' && airport.type !== 'heliport'
			? siaAtlasVacUrl(airport.ident, 3)
			: null,
	);
	// The offline Atlas VAC pack, when one is held: the same link, resolved
	// from disk instead of the SIA. A pack cut from a superseded cycle still
	// opens, an out-of-date plate the pilot can see is out of date beating no
	// plate at all, so the tap is where it has to say so: the phone's PDF
	// viewer shows nothing of ours once the file is handed over. The marker
	// carries the wording in title AND aria-label rather than colour alone,
	// and the plain-language version lives on the Layers-tab row.
	//
	// Both plates go through one derivation, because both come from the same
	// pack: a field with two plates must not warn about one and stay silent
	// about the other.
	const vacOffline = (name: string | null) => {
		const pack = storedDoc(name, false, 'fr');
		const cycle = pack ? storedDocCycle(pack) : null;
		return { stored: pack !== null, cycle, stale: cycle !== null && cycle !== currentAiracString() };
	};
	const frVacName = $derived(
		vacDocNameFor(airport.ident, frVac, airport.type === 'heliport'),
	);
	const frVacOffline = $derived((offlineDocs.gen, vacOffline(frVacName)));
	const frHelVacName = $derived(frHelVacUrl ? vacDocName(airport.ident, 3) : null);
	const frHelVacOffline = $derived((offlineDocs.gen, vacOffline(frHelVacName)));
	const offlineTitle = (o: { stored: boolean; cycle: string | null; stale: boolean }, fallback: string) =>
		o.stale && o.cycle ? t.detail.docStale(o.cycle) : o.stored ? t.detail.docOffline : fallback;

	const frStoredCharts = $derived(frAdChartsForIdent(airport.ident));
	const ifrCharts = $derived(ifrChartLink(airport, undefined, frStoredCharts.length > 0));

	// The airspace dataset is lazy-loaded (only when first shown on the map),
	// so kick off the load when this panel opens; the profile fills in once it
	// arrives. A failed fetch just leaves the profile empty.
	$effect(() => {
		void ensureAirspaces().catch(() => {});
	});

	// Lazy-load this field's own publisher's aerodrome-facilities dataset when
	// the panel opens; the information section fills in once it arrives. Only
	// the country the field belongs to is fetched, and a publisher that emits
	// no such dataset (Austria, the baseline rows) resolves to nothing.
	$effect(() => {
		void ensureAerodromeFacilities(airport.source).catch(() => {});
	});

	// Lazy-load the SIA eAIP chart-links dataset the same way; the Charts
	// row's collapsed list fills in once it arrives (FR-only).
	$effect(() => {
		void ensureFrAdCharts().catch(() => {});
	});

	// Same for the NATS eAIP chart list (UK-only): the collapsed "All
	// charts" list fills in once it arrives.
	$effect(() => {
		void ensureUkAdCharts().catch(() => {});
	});

	// Same for the FAA d-TPP chart list (US-only).
	$effect(() => {
		void ensureUsAdCharts().catch(() => {});
	});

	// Same for the DFS aerodrome-page links (DE-only): the panel opens the
	// per-aerodrome page instead of the generic eAIP root once it arrives.
	$effect(() => {
		void ensureDeAdCharts().catch(() => {});
	});

	// Same for the Austro Control eAIP links, which carry both the AD
	// section link and the chart list (AT-only).
	$effect(() => {
		void ensureAtAdCharts().catch(() => {});
	});

	// AIP-remark language (the Settings tab's preference, follows the UI
	// locale by default): shared with the airspace / obstacle remark panels.
	const lang = $derived(resolveLangPref(display.aipRemarkLang, i18n.locale));

	// The AIP directory record for this aerodrome, or null (a publisher with
	// no such dataset, no content, or still loading). facilitiesForIdent
	// tracks the lazy-load flag.
	const ad2 = $derived(facilitiesForIdent(airport.ident, airport.source));

	// Airspaces stacked over the field, from the full dataset so the profile
	// is independent of the map's zoom / category toggles. getAirspaces() is a
	// plain (non-reactive) ref, so gate on dataState.airspacesLoaded to
	// recompute once the data arrives.
	const overhead = $derived(
		dataState.airspacesLoaded
			? airspacesOver(getAirspaces() ?? [], airport.lat, airport.lon)
			: [],
	);

	const matched = $derived(
		notamsByIdent().get(airport.ident.toUpperCase()) ?? [],
	);

	// A source NOTAM split into multiple area-entries appears more than once in
	// `matched`. Keep only one entry per id; NotamDetail already groups all
	// areas of the source NOTAM internally. Checklist NOTAMs (QKKKK) are
	// administrative indexes, never aerodrome conditions; they only reach an
	// airport via an ident collision with a FIR and would be pure noise here.
	const matchedUnique = $derived(
		dedupeById(matched).filter((it) => notamOwner(it.notam).kind !== 'checklist'),
	);

	// Ident-collision split (UAAA Almaty: the airport ident IS the FIR id):
	// when this ident carries both aerodrome-owned NOTAMs and en-route NOTAMs
	// filed under it as a FIR, head each group; for the overwhelmingly common
	// single-kind case the list renders exactly as before.
	const aerodromeOwned = $derived(
		matchedUnique.filter((it) => notamOwner(it.notam).kind === 'aerodrome'),
	);
	const firFiled = $derived(
		matchedUnique.filter((it) => notamOwner(it.notam).kind !== 'aerodrome'),
	);
	const splitOwners = $derived(aerodromeOwned.length > 0 && firFiled.length > 0);

	// NOTAMs filed elsewhere (typically FIR-owned P-series obstacles) that
	// anchor their position to THIS aerodrome's reference point ("RDL
	// 194/0.25NM ARP LFPZ"). A separate collapsed list: the A) briefing
	// above stays spec-pure, the position references are one click away.
	const referencedByPosition = $derived(
		sortNotamsBySubject(
			dedupeById(arpNotamsByIdent().get(airport.ident.toUpperCase()) ?? []),
			(it) => it.notam.qCode,
		),
	);

	// Cited runway designator -> the aerodrome-owned NOTAMs citing it
	// ("RWY 03/21", "PISTES 23 ET 29"), to badge the runway-table rows.
	// Built from aerodromeOwned, so FIR-filed and checklist NOTAMs never
	// badge a runway.
	const runwayNotams = $derived.by(() => {
		const m: Record<string, IndexedNotam[]> = {};
		for (const it of aerodromeOwned) {
			const e = notamEText(it.notam);
			for (const d of extractRunwayDesignators(e)) {
				(m[d] ??= []).push(it);
			}
		}
		return m;
	});

	// The runway row whose NOTAM list is unfolded under the table (the
	// count chip toggles it); reset when the panel moves to another airport.
	let expandedRunway = $state<number | null>(null);
	$effect(() => {
		void airport.ident;
		expandedRunway = null;
	});

	// The AD-2 "Aerodrome information" section is collapsed by default (it can be
	// a wall of text); reset the toggle when the panel moves to another field.
	let ad2Expanded = $state(false);
	$effect(() => {
		void airport.ident;
		ad2Expanded = false;
	});

	// "Affecting NOTAMs" sits high in the panel and is collapsed by default
	// behind its count (the NotamGroup chevron idiom); reset when the panel
	// moves to another airport.
	let notamsExpanded = $state(false);
	$effect(() => {
		void airport.ident;
		notamsExpanded = false;
	});

	// AD-2 category labels (open-string data, widen-read with the code as its
	// own fallback), mirroring the surfaceLabel idiom below.
	function serviceLabel(cat: string): string {
		return (t.data.facilityServices as Record<string, string>)[cat] ?? cat;
	}
	function passengerLabel(cat: string): string {
		return (t.data.facilityPassenger as Record<string, string>)[cat] ?? cat;
	}
	function contactLabel(cat: string): string {
		return (t.data.facilityContact as Record<string, string>)[cat] ?? cat;
	}
	function directoryLabel(cat: string): string {
		return (t.data.facilityDirectory as Record<string, string>)[cat] ?? cat;
	}
	// Four helipad fields are CODED (the SIA publishes TPD / oui / "hostile
	// habitée"), so their VALUE is translated too; the rest of the block is
	// AIP free text, rendered verbatim like the AD 2 prose (docs/i18n.md
	// rule 6a: the dataset stores codes, the label lives here).
	function directoryValue(cat: string, text: string): string {
		const map =
			cat === 'status'
				? (t.data.heliportStatus as Record<string, string>)
				: cat === 'builtUp'
					? (t.data.heliportBuiltUp as Record<string, string>)
					: cat === 'night' || cat === 'terrace'
						? (t.data.yesNo as Record<string, string>)
						: null;
		return map?.[text.toLowerCase()] ?? text;
	}

	// Both ends of a runway resolve to the same row; a NOTAM citing
	// "RWY 03/21" must badge it once.
	function notamsForRunway(r: Runway): IndexedNotam[] {
		const out: IndexedNotam[] = [];
		// Local, intentionally non-reactive dedup index.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
		const seen = new Set<string>();
		for (const end of [r.le, r.he]) {
			if (!end) {
				continue;
			}
			for (const it of runwayNotams[normalizeRunwayDesignator(end)] ?? []) {
				if (!seen.has(it.notam.id)) {
					seen.add(it.notam.id);
					out.push(it);
				}
			}
		}
		return out;
	}

	// Render the bidirectional designator with the two ends stacked
	// on separate lines (le on top, he below) so the Runway column
	// stays as narrow as the per-direction declared-distance columns
	// that already render the same way. The embedded newline is
	// honoured by white-space: pre-line on the .runways td.
	function runwayName(r: Runway): string {
		if (r.le && r.he) {
			return `${r.le}\n${r.he}`;
		}
		return r.le || r.he || '–';
	}

	function runwaySize(r: Runway): string {
		if (r.lengthFt != null && r.widthFt != null) {
			return `${Math.round(r.lengthFt * 0.3048)} × ${Math.round(r.widthFt * 0.3048)} m`;
		}
		if (r.lengthFt != null) {
			return `${Math.round(r.lengthFt * 0.3048)} m`;
		}
		return '';
	}

	// Per-direction declared-distance pair, rendered as two stacked
	// numbers (le on top, he below) in metres. CSS `white-space:
	// pre-line` on the .num cell honours the embedded newline, so
	// each column stays roughly half as wide as the inline "le/he"
	// form. Returns '' when both sides are null so the cell stays
	// empty.
	function pairMetres(le: number | null, he: number | null): string {
		if (le == null && he == null) {
			return '';
		}
		const fmt = (n: number | null): string =>
			n == null ? '–' : String(Math.round(n * 0.3048));
		return `${fmt(le)}\n${fmt(he)}`;
	}

	const hasDeclaredDistances = $derived(
		airport.runways.some(
			(r) =>
				r.leLdaFt != null || r.heLdaFt != null ||
				r.leToraFt != null || r.heToraFt != null ||
				r.leTodaFt != null || r.heTodaFt != null ||
				r.leAsdaFt != null || r.heAsdaFt != null,
		),
	);

	// --- Runway lighting (AD 2.14) ---
	// The lighting detail lives in the per-runway expander (a trailing chevron
	// opens it) rather than a table column, so the declared distances keep the
	// width. A runway is expandable when it carries lighting, is lit, or has
	// NOTAMs; hasRunwayDetail gates the chevron column.
	function runwayExpandable(r: Runway, notams: IndexedNotam[]): boolean {
		return !!(r.leLighting || r.heLighting) || r.lit || notams.length > 0;
	}
	const hasRunwayDetail = $derived(
		airport.runways.some((r) => runwayExpandable(r, notamsForRunway(r))),
	);
	function lightPositionLabel(psn: string): string {
		return (t.data.lightPositions as Record<string, string>)[psn.toLowerCase()] ?? psn;
	}
	function lightSideLabel(side: string): string {
		return (t.data.lightSides as Record<string, string>)[side.toLowerCase()] ?? side;
	}
	function approachLabel(type: string): string {
		return (t.data.approachLights as Record<string, string>)[type.toLowerCase()] ?? type;
	}
	// A light line's colour + intensity value for the expander (position is the
	// dt label). '–' is the shared empty-cell placeholder.
	function lineValue(l: LightLine): string {
		const colour = l.colour ? ((t.data.lightColours as Record<string, string>)[l.colour.toLowerCase()] ?? l.colour) : '';
		const intst = l.intst ? ((t.data.lightIntensities as Record<string, string>)[l.intst.toLowerCase()] ?? l.intst) : '';
		if (colour && intst) {
			return `${colour} (${intst})`;
		}
		return colour || intst || '–';
	}
	function alsValue(als: [string, number | null]): string {
		// A generic 'OTHER' approach-light system carries no useful type name, so
		// show just the length; approachLabel falls back to the raw code for the
		// unmapped ICAO categories (A / C / D / ...).
		const type = als[0].toUpperCase() === 'OTHER' ? '' : approachLabel(als[0]);
		const len = als[1] != null ? `${als[1]} m` : '';
		return [type, len].filter(Boolean).join(', ') || '–';
	}

	// Radio frequencies in canonical service order (tower / ground first), with
	// any active frequency-change NOTAM overlaid: the matched rows carry the
	// NOTAM'd value + provenance, unmatched changes come back as flags.
	const resolvedRadios = $derived(resolveAirportRadios(airport));
	const radios = $derived(sortRadios(resolvedRadios.radios));
	const freqFlags = $derived(resolvedRadios.flags);

	const status = $derived(airportStatus(airport));

	// The lifecycle axis, beside the status (CAP / RST / MIL / JOINT) and the
	// traffic (VFR / IFR) ones: `type === 'closed'` is what every other
	// consumer reads (facilityKind's ICAO 91 symbol, the Layers group, the
	// overflight scan), so the tag reads it too.
	const isClosed = $derived(airport.type === 'closed');

	const accessLabel = $derived(
		airport.access === 'cap'
			? 'CAP'
			: airport.access === 'restricted'
				? 'RST'
				: '',
	);

	const accessTitle = $derived(
		airport.access === 'cap'
			? t.detail.accessCapTip
			: airport.access === 'restricted'
				? t.detail.accessRestrictedTip
				: '',
	);

	// The catalog tables carry literal keys; the dataset fields are open
	// strings, so the lookups widen at the read site and fall back to the
	// canonical English helpers.
	const typeLabel = $derived(
		(t.data.airportTypes as Record<string, string>)[airport.type] ??
			prettyAirportType(airport.type),
	);

	function surfaceLabel(raw: string): string {
		const s = formatSurface(raw);
		return (t.data.surfaces as Record<string, string>)[s.toLowerCase()] ?? s;
	}

	// Chart label + tooltip per link kind (the pure resolver returns the kind;
	// docs/i18n.md rule 6a).
	const chartLabel = $derived(
		charts?.kind === 'fr-vac'
			? t.detail.chartVac
			: charts?.kind === 'de-ad'
				? t.detail.chartAdDe
				: t.detail.chartAd,
	);
	// Belgian rows STORE their chart links on the airport row (cmd/be); the
	// French ones come from the lazily-loaded fr-adcharts dataset. Either
	// way the VAC sheets get first-class links beside the AD-page link
	// (France publishes none in its eAIP, the Atlas VAC link covers them),
	// and the rest sit in the collapsible list below, grouped by chart
	// family (instrument families first).
	const storedCharts = $derived(
		airport.charts.length > 0
			? airport.charts
			: frStoredCharts.length > 0
				? frStoredCharts
				: ukStoredCharts.length > 0
					? ukStoredCharts
					: usStoredCharts.length > 0
						? usStoredCharts
						: (atAdLinks?.charts ?? []),
	);
	const vacCharts = $derived(storedCharts.filter((c) => c.code === 'VAC'));
	const chartGroups = $derived(groupChartsByFamily(storedCharts));
	const chartTitle = $derived(
		charts?.kind === 'fr-vac'
			? t.detail.chartVacTip
			: charts?.kind === 'uk-ad'
				? t.detail.chartAdUkTip
				: charts?.kind === 'be-ad'
					? t.detail.chartAdBeTip
					: charts?.kind === 'de-ad'
						? t.detail.chartAdDeTip
						: charts?.kind === 'de-ad-page'
							? t.detail.chartAdDePageTip
							: charts?.kind === 'at-ad'
								? t.detail.chartAdAtTip
								: charts?.kind === 'us-dtpp'
									? t.detail.chartAdUsTip
									: t.detail.chartAdEsTip,
	);

	// Family header for the grouped stored-chart list (docs/i18n.md rule 6a:
	// the pure helper returns codes, the label is translated here). The
	// chartOther arm covers rows whose published filename yielded no code.
	function chartFamilyLabel(code: string): string {
		return (t.detail.chartFamilies as Record<string, string>)[code] ?? (code || t.detail.chartOther);
	}

</script>

<div class="content">
	<div class="name">{airport.name}</div>

	{#if isClosed || accessLabel || status === 'military' || status === 'joint' || airport.vfr || airport.ifr}
		<div class="tags">
			<!-- Closed leads the row: it is the one tag that changes what the
			     others mean. They still show, because a publisher routinely files
			     a field closed while still typing it civil GAT (EDCK, EDHP and
			     EDOP in the DFS set, 17 of the FAA's closed fields carry CAP),
			     and the panel reports what the AIP publishes rather than
			     arbitrating it. Untagged, the row asserted the opposite. -->
			{#if isClosed}
				<span class="tag tag--closed" title={t.detail.closedTip}>{t.detail.closedTag}</span>
			{/if}
			{#if accessLabel}
				<span
					class="tag tag--{airport.access}"
					title={accessTitle}
				>{accessLabel}</span>
			{/if}
			{#if status === 'joint'}
				<span class="tag tag--joint" title={t.detail.jointTip}>JOINT</span>
			{:else if status === 'military'}
				<span class="tag tag--military" title={t.detail.militaryTip}>MIL</span>
			{/if}
			{#if airport.vfr}
				<span class="tag tag--vfr" title={t.detail.vfrTip}>VFR</span>
			{/if}
			{#if airport.ifr}
				<span class="tag tag--ifr" title={t.detail.ifrTip}>IFR</span>
			{/if}
		</div>
	{/if}

	<!-- Action strip: the chart links (out of the identity fields) plus the
	     fly-to crosshair, one wrapping row of compact actions; the
	     collapsible all-charts list keeps its no-print and spans its own
	     line inside the strip. -->
	<div class="actions">
		<button
			type="button"
			class="act act-fly"
			onclick={() => flyToVisible({ lat: airport.lat, lng: airport.lon })}
			aria-label={t.detail.centerPositionTip}
			title={t.detail.centerPositionTip}
		>
			<Icon name="crosshair" size={14} />
		</button>
		{#each vacCharts as c, i (c.url)}
			<a
				class="act"
				href={c.url}
				target="_blank"
				rel="noopener noreferrer"
				title={c.title}
			>{vacCharts.length > 1 ? `${t.detail.chartVac} ${i + 1}` : t.detail.chartVac}</a>
		{/each}
		{#if charts}
			{@const vac = charts.kind === 'fr-vac' ? frVacOffline : null}
			<a
				class="act"
				class:stored={vac?.stored}
				class:superseded={vac?.stale}
				href={charts.url}
				target="_blank"
				rel="noopener noreferrer"
				title={vac ? offlineTitle(vac, chartTitle) : chartTitle}
				aria-label={vac?.stale && vac.cycle
					? `${chartLabel} ${t.detail.docStale(vac.cycle)}`
					: undefined}
				onclick={(e) =>
					charts.kind === 'fr-vac' && docLinkClick(e, charts.url, frVacName, false, 'fr')}
			>{chartLabel}</a>
		{/if}
		{#if frHelVacUrl}
			<a
				class="act"
				class:stored={frHelVacOffline.stored}
				class:superseded={frHelVacOffline.stale}
				href={frHelVacUrl}
				target="_blank"
				rel="noopener noreferrer"
				title={offlineTitle(frHelVacOffline, t.detail.chartVacHelTip)}
				aria-label={frHelVacOffline.stale && frHelVacOffline.cycle
					? `${t.detail.chartVacHel} ${t.detail.docStale(frHelVacOffline.cycle)}`
					: undefined}
				onclick={(e) => docLinkClick(e, frHelVacUrl, frHelVacName, false, 'fr')}
			>{t.detail.chartVacHel}</a>
		{/if}
		{#if ifrCharts}
			<a
				class="act"
				href={ifrCharts.url}
				target="_blank"
				rel="noopener noreferrer"
				title={t.detail.chartIfrTip}
			>{t.detail.chartIfr}</a>
		{/if}
		{#if storedCharts.length > 0}
			<details class="chart-list no-print">
				<summary>{t.detail.chartsAll(storedCharts.length)}</summary>
				{#each chartGroups as g (g.code)}
					<div class="chart-family">{chartFamilyLabel(g.code)}</div>
					<ul>
						{#each g.charts as c (c.url)}
							<li>
								<a
									class="ext"
									href={c.url}
									target="_blank"
									rel="noopener noreferrer"
								>{c.code || 'PDF'}</a>
								<span class="chart-title">{c.title}</span>
							</li>
						{/each}
					</ul>
				{/each}
			</details>
		{/if}
	</div>

	<Fields>
		<dt>{t.detail.type}</dt>
		<dd>{typeLabel}</dd>
		{#if airport.iata}
			<dt>IATA</dt>
			<dd>{airport.iata}</dd>
		{/if}
		{#if location}
			<dt>{t.detail.location}</dt>
			<dd>{location}</dd>
		{/if}
		{#if airport.elevFt != null}
			<dt>{t.detail.elevation}</dt>
			<dd>{airport.elevFt} ft ({Math.round(airport.elevFt * 0.3048)} m)</dd>
		{/if}
		{#if airport.transitionAltFt != null}
			<dt>{t.detail.transitionAltitude}</dt>
			<dd>{airport.transitionAltFt} ft</dd>
		{/if}
		<dt>{t.detail.position}</dt>
		<dd>
			<CoordButton lat={airport.lat} lon={airport.lon} inline />
		</dd>
	</Fields>

	<section class="block">
		{#if matchedUnique.length === 0}
			<h3>{t.detail.affectingNotamsAirport} ({matchedUnique.length})</h3>
			<p class="empty">{t.detail.noNotamsAirport}</p>
		{:else}
			<button
				type="button"
				class="notams-head"
				aria-expanded={notamsExpanded}
				onclick={() => (notamsExpanded = !notamsExpanded)}
			>
				<span class="chev" class:open={notamsExpanded} aria-hidden="true"></span>
				<h3>{t.detail.affectingNotamsAirport}</h3>
				<span class="count">{matchedUnique.length}</span>
			</button>
			{#if notamsExpanded}
				<div class="notams-body">
					{#if splitOwners}
						<h4 class="owner-head">{t.detail.ownerAerodrome} ({aerodromeOwned.length})</h4>
						<NotamCardList items={aerodromeOwned} grouped />
						<h4 class="owner-head">{t.detail.ownerEnRoute} ({firFiled.length})</h4>
						<NotamCardList items={firFiled} grouped />
					{:else}
						<NotamCardList items={matchedUnique} grouped />
					{/if}
				</div>
			{/if}
		{/if}
	</section>

	<WeatherSection ident={airport.ident} fallbackPos={{ lat: airport.lat, lon: airport.lon }} />

	{#snippet lgtEnd(end: string, lgt: RunwayLighting)}
		<div class="rwy-lgt-end">
			<div class="rwy-lgt-qfu">RWY {end}</div>
			<dl class="rwy-lgt">
				{#each lgt.lines as l, li (li)}
					<dt>{lightPositionLabel(l.psn)}</dt>
					<dd>{lineValue(l)}</dd>
				{/each}
				{#if lgt.papi}
					<dt>{lgt.papi[0]}</dt>
					<dd>{lgt.papi[1] ? lightSideLabel(lgt.papi[1]) : '–'}</dd>
				{/if}
				{#if lgt.als}
					<dt>{t.detail.approachLighting}</dt>
					<dd>{alsValue(lgt.als)}</dd>
				{/if}
			</dl>
		</div>
	{/snippet}

	{#if airport.runways.length > 0}
		<section class="block">
			<h3>{t.detail.runways}</h3>
			<div class="runways-wrap">
				<table class="runways">
					<thead>
						<tr>
							<th>{t.detail.runway}</th>
							<th>{t.detail.size}</th>
							<th>{t.detail.surface}</th>
							{#if hasDeclaredDistances}
								<th class="num" title={t.detail.ldaTip}>LDA</th>
								<th class="num" title={t.detail.toraTip}>TORA</th>
								<th class="num" title={t.detail.todaTip}>TODA</th>
								<th class="num" title={t.detail.asdaTip}>ASDA</th>
							{/if}
							{#if hasRunwayDetail}<th class="detail-col"></th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each airport.runways as r, i (i)}
							{@const rwNotams = notamsForRunway(r)}
							<tr>
								<td>{runwayName(r)}{#if rwNotams.length > 0}<button
											class="rwy-chip"
											class:open={expandedRunway === i}
											aria-expanded={expandedRunway === i}
											onclick={() => (expandedRunway = expandedRunway === i ? null : i)}
											title={t.detail.runwayNotamsTip(rwNotams.map((it) => it.notam.id).join(', '))}
										>{rwNotams.length}</button>{/if}</td>
								<td>{runwaySize(r)}</td>
								<td>{surfaceLabel(r.surface)}</td>
								{#if hasDeclaredDistances}
									<td class="num">{pairMetres(r.leLdaFt, r.heLdaFt)}</td>
									<td class="num">{pairMetres(r.leToraFt, r.heToraFt)}</td>
									<td class="num">{pairMetres(r.leTodaFt, r.heTodaFt)}</td>
									<td class="num">{pairMetres(r.leAsdaFt, r.heAsdaFt)}</td>
								{/if}
								{#if hasRunwayDetail}
									<td class="detail-col">
										{#if runwayExpandable(r, rwNotams)}
											<button
												type="button"
												class="rwy-detail-btn"
												class:open={expandedRunway === i}
												aria-expanded={expandedRunway === i}
												aria-label={t.detail.lighting}
												title={t.detail.lighting}
												onclick={() => (expandedRunway = expandedRunway === i ? null : i)}
											><span class="chev" aria-hidden="true"></span></button>
										{/if}
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if expandedRunway !== null && airport.runways[expandedRunway]}
				{@const er = airport.runways[expandedRunway]}
				{@const erNotams = notamsForRunway(er)}
				{#if er.leLighting || er.heLighting || er.lit || erNotams.length > 0}
					<div class="rwy-expand">
						{#if er.leLighting || er.heLighting}
							<div class="rwy-lighting">
								{#if er.leLighting}{@render lgtEnd(er.le, er.leLighting)}{/if}
								{#if er.heLighting}{@render lgtEnd(er.he, er.heLighting)}{/if}
							</div>
						{:else if er.lit}
							<div class="rwy-lit-plain">{t.detail.runwayLit}</div>
						{/if}
						{#if erNotams.length > 0}
							<div class="rwy-expand-label">RWY {runwayName(er).replace('\n', '/')}</div>
							<NotamRowList items={erNotams} />
						{/if}
					</div>
				{/if}
			{/if}
		</section>
	{/if}

	{#if radios.length > 0 || freqFlags.length > 0}
		<section class="block">
			<h3>{t.detail.frequencies}</h3>
			<FrequencyList layout="table" {radios} flags={freqFlags} />
		</section>
	{/if}

	<AltitudeProfile
		airspaces={overhead}
		heading={t.detail.airspacesOverhead}
		groundFt={airport.elevFt}
	/>

	{#snippet ad2Field(label: string, text: string)}
		<div class="ad2-item">
			<div class="ad2-cat">{label}</div>
			<div class="ad2-val" lang={lang}>{formatAipRemark(text, lang)}</div>
		</div>
	{/snippet}

	{#if ad2}
		<section class="block ad2">
			<button
				type="button"
				class="ad2-head"
				aria-expanded={ad2Expanded}
				onclick={() => (ad2Expanded = !ad2Expanded)}
			>
				<span class="chev" class:open={ad2Expanded} aria-hidden="true"></span>
				<h3>{airport.type === 'heliport' ? t.detail.heliportInfo : t.detail.aerodromeInfo}</h3>
			</button>
			{#if ad2Expanded}
				<div class="ad2-body">
					{#if ad2.site}{@render ad2Field(t.detail.situation, ad2.site)}{/if}
					{#if ad2.hours}{@render ad2Field(t.detail.workingHours, ad2.hours)}{/if}
					{#if ad2.arp}{@render ad2Field(t.detail.referencePoint, ad2.arp)}{/if}

					{#if ad2.fireCat || ad2.services.length > 0}
						<h4 class="cat-head">{t.detail.services}</h4>
						{#if ad2.fireCat}{@render ad2Field(t.detail.rffsCategory, ad2.fireCat)}{/if}
						{#each ad2.services as it, i (it.cat + '|' + i)}
							{@render ad2Field(serviceLabel(it.cat), it.text)}
						{/each}
					{/if}

					{#if ad2.passenger.length > 0}
						<h4 class="cat-head">{t.detail.passengerFacilities}</h4>
						{#each ad2.passenger as it, i (it.cat + '|' + i)}
							{@render ad2Field(passengerLabel(it.cat), it.text)}
						{/each}
					{/if}

					{#if ad2.directory.length > 0}
						<h4 class="cat-head">
							{airport.type === 'heliport' ? t.detail.heliportData : t.detail.directoryData}
						</h4>
						{#each ad2.directory as it, i (it.cat + '|' + i)}
							{@render ad2Field(directoryLabel(it.cat), directoryValue(it.cat, it.text))}
						{/each}
					{/if}

					{#if ad2.contact.length > 0}
						<h4 class="cat-head">{t.detail.contact}</h4>
						{#each ad2.contact as it, i (it.cat + '|' + i)}
							{@render ad2Field(contactLabel(it.cat), it.text)}
						{/each}
					{/if}
				</div>
			{/if}
		</section>
	{/if}

	{#if referencedByPosition.length > 0}
		<section class="block">
			<NotamGroup title={t.detail.referencedByPosition} items={referencedByPosition} />
		</section>
	{/if}
</div>

<style>
	.content {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.name {
		font-size: 15px;
		font-weight: 600;
	}

	.block h3 {
		margin: 0 0 6px;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	/* Action strip under the name: compact chart links + the fly-to
	 * crosshair in one wrapping row; the collapsible all-charts list keeps
	 * its own line inside the strip. */
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
	}

	/* A chart with an offline copy: the same pill, marked so a pilot knows
	   it opens with no network. The dot is the accent, not a colour of its
	   own, since the pill is already the link colour. */
	.act.stored::after {
		content: '';
		display: inline-block;
		width: 4px;
		height: 4px;
		margin-left: 4px;
		border-radius: 50%;
		background: var(--accent);
	}

	/* A stored plate cut from a superseded AIRAC cycle. It still opens, so
	   the marker changes rather than disappearing; the wording rides in the
	   title and the aria-label, colour never carrying the meaning alone. */
	.act.stored.superseded::after {
		background: var(--danger);
	}

	.act {
		display: inline-flex;
		align-items: center;
		padding: 3px 9px;
		font: inherit;
		font-size: 12px;
		color: var(--accent);
		text-decoration: none;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 999px;
		cursor: pointer;
	}

	.act:hover {
		border-color: var(--accent);
	}

	.act:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.act-fly {
		padding: 3px 7px;
		color: var(--text-muted);
	}

	.act-fly:hover {
		color: var(--accent);
	}

	.actions .chart-list {
		flex: 1 1 100%;
		margin-top: 0;
	}

	/* Collapsed "Affecting NOTAMs" head: the NotamGroup chevron idiom on
	 * the section's own h3, count pill beside it; the expanded body keeps
	 * the raw-card presentation unchanged. */
	.notams-head {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 0;
		color: inherit;
		text-align: left;
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.notams-head h3 {
		margin: 0;
	}

	.notams-head .chev {
		flex: none;
		width: 0;
		height: 0;
		border-left: 5px solid var(--text-muted);
		border-top: 4px solid transparent;
		border-bottom: 4px solid transparent;
		transition: transform 0.12s ease;
	}

	.notams-head .chev.open {
		transform: rotate(90deg);
	}

	.notams-head:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.notams-head .count {
		padding: 0 6px;
		font-size: 11px;
		font-weight: 700;
		color: var(--text-muted);
		background: var(--surface-2);
		border-radius: 999px;
	}

	.notams-body {
		margin-top: 6px;
	}

	/* Eight-column runway tables (per-direction LDA/TORA/TODA/ASDA)
	 * exceed the detail panel's typical width. Confine the
	 * horizontal scroll to the table's wrapper so the rest of the
	 * panel doesn't get a stray bottom scrollbar. */
	.runways-wrap {
		overflow-x: auto;
	}

	.runways {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}

	.runways th {
		text-align: left;
		font-weight: 600;
		color: var(--text-muted);
		border-bottom: 1px solid var(--border);
		padding: 3px 4px;
	}

	.runways td {
		padding: 3px 4px;
		border-bottom: 1px solid var(--border);
		vertical-align: top;

		/* Runway names and declared-distance pairs both embed a
		 * newline so the two thresholds stack vertically; pre-line
		 * preserves the break, collapses other whitespace. */
		white-space: pre-line;
		line-height: 1.15;
	}

	.runways .num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	/* Runway detail chevron: a trailing column that opens the per-runway
	 * expander (the AD 2.14 lighting breakdown + affecting NOTAMs) below the
	 * table, keeping the declared-distance columns for the width. */
	.detail-col {
		width: 1%;
		white-space: nowrap;
	}

	.rwy-detail-btn {
		display: inline-flex;
		padding: 4px 2px;
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.rwy-detail-btn .chev {
		width: 0;
		height: 0;
		border-left: 5px solid var(--text-muted);
		border-top: 4px solid transparent;
		border-bottom: 4px solid transparent;
		transition: transform 0.12s ease;
	}

	.rwy-detail-btn.open .chev {
		transform: rotate(90deg);
	}

	.rwy-detail-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.rwy-lit-plain {
		margin-bottom: 8px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.rwy-lighting {
		display: flex;
		flex-wrap: wrap;
		gap: 18px;
		margin-bottom: 8px;
	}

	.rwy-lgt-qfu {
		margin-bottom: 3px;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
	}

	.rwy-lgt {
		display: grid;
		grid-template-columns: max-content 1fr;
		column-gap: 10px;
		row-gap: 2px;
		margin: 0;
		font-size: 12px;
	}

	.rwy-lgt dt {
		color: var(--text-muted);
	}

	.rwy-lgt dd {
		margin: 0;
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.tag {
		padding: 2px 7px;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: #fff;
		border-radius: 999px;
	}

	/* Closed / abandoned: the neutral status fill, which is already the app's
	   badge for a permanent state (the PERM NOTAM chip). NOT the map's closed
	   ink: that is the near-black chart ink, which sinks into the night
	   surface. */
	.tag--closed {
		background: var(--status-neutral);
	}

	.tag--cap {
		background: var(--status-active);
	}

	.tag--restricted {
		background: var(--status-warn);
	}

	.tag--military {
		background: #4a5a6e;
	}

	.tag--joint {
		background: #42698c;
	}

	.tag--vfr {
		background: #2e7bbf;
	}

	.tag--ifr {
		background: #6b5dd3;
	}

	/* Count chip on a runway row that has affecting NOTAMs; the tooltip
	 * lists them all, clicking unfolds their compact rows under the table. */
	.rwy-chip {
		margin-left: 6px;
		padding: 0 6px;
		font: inherit;
		font-size: 11px;
		font-weight: 700;
		color: var(--text-muted);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 999px;
		cursor: pointer;
	}

	.rwy-chip:hover {
		color: var(--accent);
		border-color: var(--accent);
	}

	.rwy-chip.open {
		color: var(--accent-text);
		background: var(--accent);
		border-color: var(--accent);
	}

	.rwy-chip:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	/* The unfolded NOTAM rows of the expanded runway chip. */
	.rwy-expand {
		margin-top: 6px;
	}

	.rwy-expand-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		text-transform: uppercase;
	}

	/* Sub-heading inside "Affecting NOTAMs" when an ident collision splits
	 * the list into aerodrome-owned and FIR-filed groups (UAAA). */
	.owner-head {
		margin: 8px 0 4px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		text-transform: uppercase;
	}

	/* Category sub-heading inside the AD-2 "Aerodrome information" body;
	 * sentence-case so it reads as an inner tier under the block heading. */
	.cat-head {
		margin: 4px 0 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
	}

	/* AD-2 "Aerodrome information": a collapsed-by-default block (situation,
	 * operating hours, services, passenger facilities, operator contact). */
	.ad2-head {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 0;
		color: inherit;
		text-align: left;
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.ad2-head h3 {
		margin: 0;
	}

	.ad2-head .chev {
		flex: none;
		width: 0;
		height: 0;
		border-left: 5px solid var(--text-muted);
		border-top: 4px solid transparent;
		border-bottom: 4px solid transparent;
		transition: transform 0.12s ease;
	}

	.ad2-head .chev.open {
		transform: rotate(90deg);
	}

	.ad2-head:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.ad2-body {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-top: 10px;
	}

	.ad2-item {
		font-size: 13px;
	}

	.ad2-cat {
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
	}

	.ad2-val {
		white-space: pre-line;
		overflow-wrap: break-word;
		line-height: 1.4;
	}

	.empty {
		margin: 0;
		font-size: 12px;
		color: var(--text-muted);
	}

	.ext {
		color: var(--accent);
		text-decoration: none;
	}

	.ext:hover {
		text-decoration: underline;
	}

	.ext:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.chart-list {
		margin-top: 2px;
	}

	.chart-list summary {
		font-size: 12px;
		color: var(--text-muted);
		cursor: pointer;
	}

	.chart-family {
		margin: 6px 0 0;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
	}

	.chart-list ul {
		margin: 1px 0 0;
		padding: 0;
		list-style: none;
	}

	.chart-list li {
		display: flex;
		gap: 6px;
		padding: 1px 0;
		font-size: 12px;
	}

	.chart-list .ext {
		flex: 0 0 auto;
		min-width: 34px;
	}

	.chart-title {
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
