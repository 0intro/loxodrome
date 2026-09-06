<script lang="ts">
	import type { Notam } from '$lib/notam/types';
	import { t } from '$lib/state/i18n.svelte';
	import { notamSections } from '$lib/notam';
	import { rtbaZoneActivations } from '$lib/notam/rtba';
	import { formatActivationWindow } from '$lib/format/datetime';
	import { display } from '$lib/state/display.svelte';
	import { ui, toggleNotamQRadius, navigateToAirport } from '$lib/state/ui.svelte';
	import {
		airspacesForNotam,
		airspacesReferencedByNotam,
		activatesAirspaces,
		isActiveTrigger,
		notamTriggers,
		notamTriggeredBy,
		notamReferenceLinks,
	} from '$lib/state/notamLinks.svelte';
	import { extractRunwayDesignators } from '$lib/notam/runwayRefs';
	import { notamOwner } from '$lib/state/notam.svelte';
	import { arpAirportsForNotam } from '$lib/state/notamAirportLinks.svelte';
	import { obstaclesForNotam, isObstacleQCode } from '$lib/state/notamObstacleLinks.svelte';
	import { navaidsForNotam, isNavaidQCode } from '$lib/state/notamNavaidLinks.svelte';
	import { activatesSupZones } from '$lib/state/supaipLinks.svelte';
	import { ensureObstacles, ensureNavaids, airportByIdent, dataState } from '$lib/state/data.svelte';
	import { isFrequencyChangeCondition } from '$lib/notam/qcode';
	import { freqReplacement, parseFreqAssignments, singleFreq } from '$lib/notam/freqChange';
	import { formatFreqMHz } from '$lib/format/radio';

	import StatusHeader from './notam/StatusHeader.svelte';
	import ReferenceLinks from './notam/ReferenceLinks.svelte';
	import AirspaceList from './notam/AirspaceList.svelte';
	import AirspaceProfile from './notam/AirspaceProfile.svelte';
	import TriggerList from './notam/TriggerList.svelte';
	import ObstaclesList from './notam/ObstaclesList.svelte';
	import NavaidsList from './notam/NavaidsList.svelte';
	import LocationValidity from './notam/LocationValidity.svelte';
	import Description from './notam/Description.svelte';
	import AipSupChips from './notam/AipSupChips.svelte';
	import SupZoneList from './notam/SupZoneList.svelte';
	import Coordinates from './notam/Coordinates.svelte';

	interface Props {
		notam: Notam;
	}
	let { notam }: Props = $props();

	// Lazy-load the obstacle / navaid datasets when this NOTAM is about one, so
	// the "Affected obstacles" / "Affected navaids" lists populate (and the map
	// layer builds, enabling row hover / selection highlight) even when those
	// layers were never enabled. Q-code-gated so unrelated NOTAMs don't pull the
	// large obstacle dataset. Airspaces already load once a briefing exists;
	// airports default-on.
	$effect(() => {
		const q = notam.qCode;
		if (isObstacleQCode(q)) {
			void ensureObstacles().catch(() => {});
		}
		if (isNavaidQCode(q)) {
			void ensureNavaids().catch(() => {});
		}
	});

	const sections = $derived(notamSections(notam));
	// The parser splits the id off the body; rejoin them for the raw view.
	const rawNotam = $derived(`${notam.id}\n${notam.fullContent}`);

	// Aerodromes this NOTAM anchors its position to ("RDL 194/0.25NM ARP
	// LFPZ") without being filed under them: typically a FIR-owned obstacle
	// NOTAM near a field. Resolved against the loaded airports; the chip
	// navigates to the aerodrome panel.
	const arpAirports = $derived(arpAirportsForNotam(notam));

	// Runway designators an aerodrome-owned NOTAM scopes itself to ("RWY
	// 03/21", "PISTES 23 ET 29"); display-only pills, gated on aerodrome
	// ownership so an en-route NOTAM naming some field's runway does not
	// render a misleading row.
	const citedRunways = $derived(
		notamOwner(notam).kind === 'aerodrome'
			? extractRunwayDesignators(sections.E ?? '')
			: [],
	);

	// Airspaces this NOTAM explicitly references: named in its E) text (TMA /
	// CTA / CTR / SIV, e.g. "TMA SEINE HOURS OF OPS") or cited by special-use
	// designator ("LF-R45 LIMITES MODIFIEES" without an activation Q-code); a
	// stated relationship distinct from the geometric "In airspaces" /
	// location list. Shown regardless of the layer toggles.
	const referencedAirspaces = $derived(airspacesReferencedByNotam(notam));

	// Structured view of a frequency-change NOTAM (Q-code CF / ME): the parsed
	// assignments (aerodrome services) or the single new value (FIS/SIV), so the
	// panel states what moved, not just the raw E) text. Aerodrome changes link
	// their A) airport (whose Frequencies panel now shows the override); a SIV
	// change is reached through "Affected airspaces" above. null when not a
	// frequency change or nothing parsed.
	const freqChange = $derived.by(() => {
		if (!isFrequencyChangeCondition(notam.qCode)) {
			return null;
		}
		const e = sections.E ?? '';
		const assignments = parseFreqAssignments(e);
		// FIS/SIV change: a stated new/old pair ("READ <new> INSTEAD OF <old>"),
		// else a lone new value.
		let single: string | null = null;
		let was: string | null = null;
		if (assignments.length === 0) {
			const repl = freqReplacement(e);
			if (repl) {
				single = repl.freq;
				was = repl.was;
			} else {
				single = singleFreq(e);
			}
		}
		if (assignments.length === 0 && single === null) {
			return null;
		}
		// airportByIdent reads a plain (non-reactive) index: track the load
		// flag (the selectedObstacle idiom) so the aerodrome chips fill in
		// once the airports dataset arrives.
		const airports =
			assignments.length > 0 && dataState.airportsLoaded
				? notam.icaoCodes.filter((c) => airportByIdent(c.toUpperCase()) !== null)
				: [];
		return { assignments, single, was, airports };
	});
	// All airspaces this NOTAM geometrically crosses, altitude filtered,
	// regardless of the airspace layer toggles (the profile shows these and
	// applies the global all-vs-on-map toggle itself). The "In airspaces" list
	// additionally drops the named ones (their own section above) and
	// aerial-activity zones, which are small, numerous recreational areas
	// (paragliding / parachute / balloon / glider sites) that flood the list
	// without being meaningful "airspaces the NOTAM is in".
	const allTouching = $derived(airspacesForNotam(notam));
	const inAirspaces = $derived(
		allTouching.filter(
			(a) =>
				a.category !== 'activity' &&
				!referencedAirspaces.some((n) => n.key === a.key),
		),
	);

	// Identity-based link: airspaces this NOTAM activates by name match.
	// Independent of the geometric "in airspaces" list; listed first because
	// "activates X" is a stronger semantic than "happens to sit inside Y".
	const activatedAirspaces = $derived(activatesAirspaces(notam));
	// Per-zone activation windows for an RTBA NOTAM, keyed by airspace id, shown
	// against each row of the "Activates" list. Empty for non-RTBA NOTAMs, so the
	// chip simply doesn't render.
	const rtbaWindows = $derived.by(() => {
		const m: Record<string, string> = {};
		for (const z of rtbaZoneActivations(notam)) {
			// A zone can list several windows (a morning and an evening slot); show
			// them all, comma-joined, rather than letting the last overwrite.
			const w = formatActivationWindow(z.start, z.end);
			m[z.airspaceId] = m[z.airspaceId] ? `${m[z.airspaceId]}, ${w}` : w;
		}
		return m;
	});

	// Obstacles this NOTAM affects (Q-code OB/OL/PO + proximity within ~300m
	// of any of the NOTAM's coords, OR a text-mention of an SIA obstacle
	// reference number). No validity-window filter so a lapsed NOTAM still
	// shows the obstacle it once affected; the map cue uses the
	// active-now variant.
	const affectedObstacles = $derived(obstaclesForNotam(notam));

	// Navaids this NOTAM affects (Q-code N-series / I-series + proximity
	// within ~1.5 km of any of the NOTAM's coords, OR a text-mention of the
	// navaid ident). No validity-window filter, like obstacles above.
	const affectedNavaids = $derived(navaidsForNotam(notam));

	// SUP AIP zones this NOTAM activates (forward link, "named zone else all").
	// qCode-gated, no time filter; fills in once the lazily-loaded SUP dataset
	// arrives (AipSupChips below triggers that load for any SUP-citing NOTAM).
	const activatedSupZones = $derived(activatesSupZones(notam));

	// Cross-NOTAM relations: NOTAMR predecessor + REF NOTAM cross-references
	// + reverse direction. See relations.ts and notamLinks.svelte.ts.
	const refs = $derived(notamReferenceLinks(notam));

	// Triggers <-> triggered relation, bridged by shared AIP SUP number.
	// For a framework (TRIGGER NOTAM body + restricted-area qCode), triggeredBy
	// lists the loaded activation NOTAMs that bring it into force; for an
	// activation NOTAM (QR_CA / QR_GA family), triggers lists the loaded
	// framework NOTAMs it activates. The status-row badge is independent: it
	// flags any activation NOTAM whose body names a target, regardless of
	// whether the target is in the loaded set.
	const triggeredBy = $derived(notamTriggeredBy(notam));
	const triggers = $derived(notamTriggers(notam));
	const isTrigger = $derived(isActiveTrigger(notam));

	// Per-NOTAM toggle to draw a Q) line centre + radius (NM) circle on the map;
	// the index comes from the open detail. Position / area NOTAMs (red markers /
	// polygons) always offer it (manual-only). Q-line-fallback NOTAMs auto-draw
	// their circle on selection (the Display tab's global toggle), so they expose
	// the toggle only when that auto circle is suppressed: the global toggle is
	// off, or the affected airspaces replaced it.
	const notamIndex = $derived(ui.detail?.kind === 'notam' ? ui.detail.index : -1);
	const qRadiusNM = $derived(notam.qualifier?.radius ?? null);
	const qRadiusShown = $derived(ui.qRadiusIndex === notamIndex);
	const isQlineFallback = $derived(notam.coordinates[0]?.type === 'qualifierLine');
	const affectedReplaces = $derived(
		display.affectedAirspaces && referencedAirspaces.length > 0,
	);
	const showQRadiusToggle = $derived(
		qRadiusNM != null &&
			(!isQlineFallback || !display.qlineRadius || affectedReplaces),
	);
</script>

<div class="content">
	<StatusHeader {notam} {isTrigger} />

	<!-- The NOTAM's own words come first, the way AirportDetail was
	     reordered around what a pilot opened it for. "RWY 07/25 CLSD" had
	     been sitting below up to eight derived link lists and a full
	     airspace column chart; those explain the NOTAM and belong under
	     it. D) rides with E) because a schedule is part of what it says,
	     the runway pills because they are a one-glance read of the same
	     text, and LocationValidity because where and when is the rest of
	     the sentence. -->
	<Description {notam} {sections} />

	{#if citedRunways.length > 0}
		<section class="block">
			<h3>{t.detail.runways}</h3>
			<div class="rwy-pills">
				{#each citedRunways as d (d)}
					<span class="rwy-pill">RWY {d}</span>
				{/each}
			</div>
		</section>
	{/if}

	<LocationValidity {notam} />

	<ReferenceLinks {refs} />

	<AirspaceList
		title={t.notam.activates}
		airspaces={activatedAirspaces}
		showId
		windows={rtbaWindows}
	/>

	<AirspaceList title={t.notam.affectedAirspaces} airspaces={referencedAirspaces} />

	{#if arpAirports.length > 0}
		<section class="block fc">
			<h3>{t.notam.referencedAerodromes}</h3>
			<div class="fc-airports">
				{#each arpAirports as a (a.ident)}
					<button
						class="fc-chip"
						onclick={() => navigateToAirport(a.ident)}
						title={t.notam.arpChipTip}
					>{a.ident}</button>
				{/each}
			</div>
		</section>
	{/if}

	{#if freqChange}
		<section class="block fc">
			<h3>{t.notam.freqChange}</h3>
			{#if freqChange.assignments.length > 0}
				<ul class="fc-list">
					{#each freqChange.assignments as a, i (a.label + '|' + a.freq + '|' + i)}
						<li>
							<span class="fc-svc">{a.label}</span>
							<span class="fc-freq">{formatFreqMHz(a.freq)}</span>
							{#if a.was}<span class="fc-was"><s>{formatFreqMHz(a.was)}</s></span>{/if}
						</li>
					{/each}
				</ul>
			{:else if freqChange.single}
				<p class="fc-single">
					{formatFreqMHz(freqChange.single)} MHz
					{#if freqChange.was}<span class="fc-was"><s>{formatFreqMHz(freqChange.was)}</s></span>{/if}
				</p>
			{/if}
			{#if freqChange.airports.length > 0}
				<div class="fc-airports">
					{#each freqChange.airports as ident (ident)}
						<button
							class="fc-chip"
							onclick={() => navigateToAirport(ident)}
							title={t.detail.openAirportTip}
						>{ident}</button>
					{/each}
				</div>
			{/if}
		</section>
	{/if}

	<TriggerList
		title={t.notam.triggers}
		items={triggers}
		linkTitle={t.notam.openFrameworkTip}
	/>
	<TriggerList
		title={t.notam.triggeredBy}
		items={triggeredBy}
		linkTitle={t.notam.openActivationTip}
	/>

	<ObstaclesList obstacles={affectedObstacles} />

	<NavaidsList navaids={affectedNavaids} />

	<AirspaceProfile airspaces={allTouching} {notam} />

	{#if display.showInAirspaces}
		<AirspaceList title={t.notam.inAirspaces} airspaces={inAirspaces} />
	{/if}

	<SupZoneList title={t.notam.activatesSupZones} zones={activatedSupZones} />

	<AipSupChips {notam} />

	<Coordinates {notam} />

	{#if showQRadiusToggle && qRadiusNM != null}
		<button
			type="button"
			class="q-radius"
			onclick={() => toggleNotamQRadius(notamIndex)}
		>
			{qRadiusShown ? t.notam.hideQRadius(qRadiusNM) : t.notam.showQRadius(qRadiusNM)}
		</button>
	{/if}

	<details class="raw">
		<summary>{t.notam.rawNotam}</summary>
		<pre lang="en">{rawNotam}</pre>
	</details>
</div>

<style>
	.content {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.fc-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 12px;
	}

	.fc-list li {
		display: flex;
		gap: 8px;
		align-items: baseline;
	}

	.fc-svc {
		font-weight: 600;
	}

	.fc-freq {
		font-variant-numeric: tabular-nums;
		font-weight: 700;
	}

	.fc-was {
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.fc-single {
		margin: 0;
		font-variant-numeric: tabular-nums;
		font-weight: 700;
	}

	.fc-airports {
		margin-top: 6px;
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	/* Display-only runway pills for an aerodrome NOTAM's cited designators. */
	.rwy-pills {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.rwy-pill {
		padding: 1px 7px;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 999px;
	}

	.fc-chip {
		padding: 1px 8px;
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		color: var(--accent);
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 999px;
		cursor: pointer;
	}

	.fc-chip:hover {
		border-color: var(--accent);
	}

	.fc-chip:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.q-radius {
		align-self: flex-start;
		padding: 0;
		font: inherit;
		font-size: 12px;
		color: var(--accent);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.q-radius:hover {
		text-decoration: underline;
	}

	.q-radius:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.raw summary {
		cursor: pointer;
		font-size: 12px;
		color: var(--text-muted);
	}

	.raw pre {
		margin: 6px 0 0;
		padding: 8px 10px;
		font-size: 11px;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
</style>
