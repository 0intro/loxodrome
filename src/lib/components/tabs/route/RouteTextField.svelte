<script lang="ts">
	/* The route text field: one input mirroring the active route (two-way),
	 * tokenised live with caret tracking so the autocomplete completes the
	 * token the caret sits in (mid-route edits included), keyboard menu
	 * navigation, hover-highlight of suggestions on the map, and the
	 * build-error notice. Resolution lives in resolveWaypointToken;
	 * reconciliation (preserving alt / notes) in setRouteFromText. */
	import { tick } from 'svelte';
	import Icon from '../../Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { inputValue } from '$lib/ui/dom';
	import { mapState } from '$lib/state/map.svelte';
	import { clearHover, hoverFeature } from '$lib/map/selectionHighlight';
	import { activeRoute, routes, serializeRoute, setRouteFromText } from '$lib/state/route.svelte';
	import { looksLikeCoordToken } from '$lib/route/coordToken';
	import {
		waypointSearch,
		searchWaypoints,
		resolveWaypointToken,
		hitIdent,
		hitSubtitle,
		type WaypointHit,
	} from '$lib/state/waypointSearch.svelte';
	import { dataState, ensureAirports, ensureNavaids } from '$lib/state/data.svelte';
	import { fitRoute } from './fitRoute';

	// Build problems are stored as data ('loading' or the unresolved tokens)
	// and translated at render, so a locale switch re-words a standing notice
	// (docs/i18n.md rule 7).
	let buildErr = $state<'loading' | string[] | null>(null);
	const buildError = $derived(
		buildErr === 'loading'
			? t.route.datasetsLoading
			: buildErr && buildErr.length > 0
				? t.route.couldNotFind(buildErr.join(', '))
				: '',
	);
	let routeText = $state('');
	let fieldFocused = $state(false);
	// Caret offset in the route field. The autocomplete completes the token the
	// caret sits in (not always the last one), so editing a waypoint in the middle
	// of the route suggests for THAT waypoint, not the route's last / first.
	let caret = $state(0);
	// Set when a pick fills a token, so the menu stays closed afterwards instead of
	// reopening for the next token; cleared by the next caret move / keystroke.
	let menuSuppressed = $state(false);
	let routeInputEl: HTMLInputElement | undefined;
	// Keyboard row selection in the autocomplete (-1 = none); the field + menu
	// wrapper anchors the focusout close and the active-row scroll.
	let acIndex = $state(-1);
	let addFieldEl: HTMLDivElement | undefined;
	// Set when onRouteKeydown consumed a menu-navigation key, so the
	// caret-tracking keyup that follows cannot undo what it did (unsuppress
	// the menu Escape just closed, reset the row the arrows just moved).
	let acKeyHandled = false;

	// The token the caret is in (the waypoint being edited) and its [start, end).
	const activeToken = $derived(tokenAt(routeText, caret));

	// Order suggestions closest to the fix just before the one being edited (you
	// fly from it): resolve the token left of the caret, else fall back to the
	// route's last waypoint, then the map centre on an empty route.
	const searchRef = $derived.by(() => {
		const left = lastToken(routeText.slice(0, activeToken.start).replace(/\s+$/, ''));
		const anchor = left ? resolveWaypointToken(left) : null;
		if (anchor) {
			return { lat: anchor.lat, lon: anchor.lon };
		}
		const wps = activeRoute().waypoints;
		if (wps.length > 0) {
			const w = wps[wps.length - 1];
			return { lat: w.lat, lon: w.lon };
		}
		return { lat: mapState.center.lat, lon: mapState.center.lng };
	});
	const search = $derived(searchWaypoints(searchRef));

	// The autocomplete query follows the caret's token, so it tracks where you are
	// editing; empty (menu hidden) unless the field is focused and airports have
	// loaded (during the load applyRouteText shows the "loading" notice instead).
	$effect(() => {
		waypointSearch.query =
			fieldFocused &&
			dataState.airportsLoaded &&
			!menuSuppressed &&
			!looksLikeCoordToken(activeToken.token)
				? activeToken.token
				: '';
	});
	// Text typed before the airport / navaid datasets finish loading; applied
	// once they do, so idents resolve without needing another keystroke.
	let pendingText: string | null = null;

	/** The in-progress (last) token drives the autocomplete; a trailing
	 *  separator means there is none. */
	function lastToken(text: string): string {
		if (/\s$/.test(text)) {
			return '';
		}
		const toks = text.split(/\s+/).filter(Boolean);
		return toks[toks.length - 1] ?? '';
	}

	/** The token the caret at `pos` sits in (the run of non-separator chars
	 *  containing or ending at it) with its [start, end) bounds, an empty token when
	 *  the caret is on a separator. Splits on whitespace only (not commas), so a
	 *  coordinate token like "N48,8200/E2,62000" stays whole under the caret. */
	function tokenAt(text: string, pos: number): { token: string; start: number; end: number } {
		const isSep = (c: string): boolean => /\s/.test(c);
		let start = pos;
		while (start > 0 && !isSep(text[start - 1])) {
			start--;
		}
		let end = pos;
		while (end < text.length && !isSep(text[end])) {
			end++;
		}
		return { token: text.slice(start, end), start, end };
	}

	/** A signature of the route's waypoint coordinates; changes when a waypoint is
	 *  added, removed or moved. Used to re-fit the map only when typing actually
	 *  changed the resolved route, not on every keystroke. */
	function routeCoordSig(): string {
		return activeRoute().waypoints.map((w) => `${w.lat.toFixed(4)},${w.lon.toFixed(4)}`).join('|');
	}

	/** Parse the field into the route live: the field mirrors the route (two-way).
	 *  Resolution lives in resolveWaypointToken; reconciliation (preserving
	 *  alt / notes) lives in setRouteFromText. */
	function applyRouteText(text: string): void {
		routeText = text;
		if (!dataState.airportsLoaded) {
			pendingText = text;
			buildErr = 'loading';
			return;
		}
		// The token at the caret is the one still being edited (the autocomplete
		// query is driven off it); don't flag it as unresolved, only committed ones.
		// A half-typed coordinate ("N48," before the slash) is split on its comma by
		// tokenizeRoute into fragments that resolve to nothing; suppress those too so
		// building a coord mid-token doesn't flash "Couldn't find".
		const active = tokenAt(text, caret).token.toUpperCase();
		const inCoord = looksLikeCoordToken(active);
		const before = routeCoordSig();
		const { unresolved } = setRouteFromText(text, resolveWaypointToken);
		const errs = unresolved.filter((tok) => {
			const tu = tok.toUpperCase();
			return tu !== active && !(inCoord && active.includes(tu));
		});
		buildErr = errs.length ? errs : null;
		// A committed token that failed to resolve may be a navaid ident whose
		// dataset is still loading (airports usually land first): park the text
		// so the dataset effect below re-applies it once the navaids arrive,
		// keeping the notice up in the meantime.
		if (errs.length > 0 && !dataState.navaidsLoaded) {
			pendingText = text;
		}
		// Keep the route framed as it is built: re-fit when typing changed the
		// resolved waypoints (a fix added / removed), never mid-ident.
		if (routeCoordSig() !== before) {
			fitRoute();
		}
	}

	function onRouteInput(e: Event): void {
		syncCaret(e);
		applyRouteText(inputValue(e));
	}

	/** Track the caret so the autocomplete follows it on clicks and arrow keys, not
	 *  only while typing. */
	function syncCaret(e: Event): void {
		if (acKeyHandled && e instanceof KeyboardEvent) {
			// The keyup of a consumed menu-navigation key: the caret did not
			// move (its keydown was prevented / menu-only), skip the resets.
			acKeyHandled = false;
			return;
		}
		const el = e.target as HTMLInputElement;
		caret = el.selectionStart ?? el.value.length;
		menuSuppressed = false;
		acIndex = -1;
	}

	/** Keyboard navigation for the autocomplete menu: ArrowDown / ArrowUp walk
	 *  the rows (wrapping), Enter picks the active row, Escape closes the menu
	 *  until the next caret move / keystroke. Inert while the menu is closed,
	 *  so the arrows keep moving the caret then. */
	function onRouteKeydown(e: KeyboardEvent): void {
		const hits = search.results;
		if (menuSuppressed || waypointSearch.query.trim() === '' || hits.length === 0) {
			return;
		}
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			acKeyHandled = true;
			acIndex = e.key === 'ArrowDown' ? (acIndex + 1) % hits.length : (acIndex - 1 + hits.length) % hits.length;
			// Keep the active row in view once the list overflows the menu.
			void tick().then(() => {
				addFieldEl?.querySelectorAll('.row')[acIndex]?.scrollIntoView({ block: 'nearest' });
			});
		} else if (e.key === 'Enter' && acIndex >= 0 && acIndex < hits.length) {
			e.preventDefault();
			acKeyHandled = true;
			onPickHit(hits[acIndex]);
		} else if (e.key === 'Escape') {
			acKeyHandled = true;
			menuSuppressed = true;
			acIndex = -1;
		}
	}

	/** Click an autocomplete row: replace the token under the caret with the chosen
	 *  ident (so it edits the waypoint you are on, mid-route included), put the caret
	 *  at the start of the next token, and keep the field focused. */
	function onPickHit(hit: WaypointHit): void {
		const ident = hitIdent(hit);
		const { start, end } = tokenAt(routeText, caret);
		const tail = routeText.slice(end);
		// A trailing space only when picking at the very end; mid-route the existing
		// separator is kept.
		const sep = tail === '' ? ' ' : '';
		const next = routeText.slice(0, start) + ident + sep + tail;
		// Land the caret past the ident and its following separator, so the menu
		// closes (the active token is empty) and the next ident is ready to type.
		let pos = start + ident.length + sep.length;
		if (sep === '' && pos < next.length && /[\s,]/.test(next[pos])) {
			pos += 1;
		}
		caret = pos;
		menuSuppressed = true;
		applyRouteText(next);
		// applyRouteText resets the input value (one-way bound), moving the DOM caret
		// to the end; restore it once the update flushes.
		void tick().then(() => {
			routeInputEl?.focus();
			routeInputEl?.setSelectionRange(pos, pos);
		});
	}

	/** While a suggestion row is hovered, flash its airport / navaid on the map,
	 *  but only when it is in the current viewport: highlighting an off-screen
	 *  feature would show nothing, and we don't pan on hover. */
	function hoverHit(hit: WaypointHit): void {
		const m = mapState.map;
		if (!m) {
			return;
		}
		const lat = hit.kind === 'airport' ? hit.airport.lat : hit.navaid.lat;
		const lon = hit.kind === 'airport' ? hit.airport.lon : hit.navaid.lon;
		if (!m.getBounds().contains([lat, lon])) {
			return;
		}
		if (hit.kind === 'airport') {
			hoverFeature('airport', hit.airport.ident);
		} else {
			hoverFeature('navaid', hit.navaid.id);
		}
	}

	// Mirror the active route into the add field whenever the user isn't editing
	// it (map clicks / drags, list reorder / delete and renames reflect into the
	// text). Switching the active route force-refreshes the field even if focused,
	// so the text always reflects the route the panel shows, and clears any stale
	// build error / pending text from the route just left.
	let lastActiveId = routes.activeId;
	$effect(() => {
		const s = serializeRoute();
		const switched = routes.activeId !== lastActiveId;
		if (switched) {
			lastActiveId = routes.activeId;
			buildErr = null;
			pendingText = null;
		}
		if (!fieldFocused || switched) {
			routeText = s;
		}
	});

	// Once the datasets load, apply any text typed during the load. Navaids
	// can land after airports, so track both flags: the first apply gives
	// early feedback once airports are in, and applyRouteText re-parks the
	// text while unresolved idents may still be navaids on their way.
	$effect(() => {
		void dataState.navaidsLoaded;
		if (dataState.airportsLoaded && pendingText !== null) {
			const parked = pendingText;
			pendingText = null;
			applyRouteText(parked);
		}
	});
</script>

<div
	class="add-field"
	bind:this={addFieldEl}
	onfocusout={(e) => {
		// Close only when focus leaves the field + menu compound, so tabbing
		// from the input into a suggestion row keeps the menu open (the wind
		// editor's focusout convention); a pick or an outside click closes.
		const next = e.relatedTarget as Node | null;
		if (!next || !addFieldEl?.contains(next)) {
			fieldFocused = false;
		}
	}}
>
	<input
		class="search"
		type="text"
		autocapitalize="characters"
		spellcheck="false"
		enterkeyhint="search"
		placeholder={t.route.addFieldPlaceholder}
		value={routeText}
		bind:this={routeInputEl}
		oninput={onRouteInput}
		onclick={syncCaret}
		onkeydown={onRouteKeydown}
		onkeyup={syncCaret}
		onselect={syncCaret}
		onfocus={(e) => {
			fieldFocused = true;
			// The autocomplete ranks airports and navaids together, and
			// searchWaypoints gates on the loaded flags, so the hits fill in
			// as each dataset arrives. Asked for HERE rather than at the tab's
			// mount: navaids for ten countries is most of a cold boot's
			// traffic, and nothing needs them until someone types a waypoint.
			void ensureAirports().catch(() => {});
			void ensureNavaids().catch(() => {});
			syncCaret(e);
		}}
	/>
	{#if fieldFocused && waypointSearch.query.trim() !== ''}
		<div class="hit-menu">
			{#if search.total === 0}
				<p class="muted no-hit">{t.route.noMatch(waypointSearch.query)}</p>
			{:else}
				<ul class="hit-list">
					{#snippet searchHitItem(hit: WaypointHit, i: number)}
						<li>
							<button
								class="row"
								class:active={i === acIndex}
								onmousedown={(e) => e.preventDefault()}
								onmouseenter={() => hoverHit(hit)}
								onmouseleave={clearHover}
								onclick={() => onPickHit(hit)}
							>
								<span class="row-text">
									<span class="row-id">
										{hitIdent(hit)}
										{#if hit.kind === 'airport' && hit.airport.type === 'closed'}
											<span class="closed-chip" title={t.detail.closedTip}
												>{t.detail.closedTag}</span
											>
										{/if}
									</span>
									<span class="row-desc">{hitSubtitle(hit)}</span>
								</span>
								<Icon name="route" size={15} />
							</button>
						</li>
					{/snippet}
					{#each search.results as hit, i (hit.kind + (hit.kind === 'airport' ? hit.airport.ident : hit.navaid.id))}
						{@render searchHitItem(hit, i)}
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>
{#if buildError}
	<p class="muted build-error" role="alert">{buildError}</p>
{/if}

<style>
	/* Positioning context for the autocomplete overlay so it never pushes the
	 * action buttons below it (which used to eat the first click on them). */
	.add-field {
		position: relative;
		margin-top: 4px;
	}

	/* Floating autocomplete menu: an overlay below the field, so opening / closing
	 * it leaves the rest of the panel (and the action buttons) in place. */
	.hit-menu {
		position: absolute;
		top: calc(100% + 3px);
		right: 0;
		left: 0;
		z-index: 30;
		padding: 4px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: 0 6px 18px rgb(0 0 0 / 22%);
		max-height: 320px;
		overflow-y: auto;
	}

	.no-hit {
		margin: 4px 6px;
	}

	.hit-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 9px;
		width: 100%;
		padding: 7px 8px;
		text-align: left;
		color: var(--text);
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius);
		cursor: pointer;
	}

	.row:hover,
	.row.active {
		background: var(--surface-2);
		border-color: var(--border);
	}

	.row-text {
		display: flex;
		flex: 1;
		min-width: 0;
		flex-direction: column;
	}

	.row-id {
		font-weight: 600;
	}

	.row-desc {
		font-size: 12px;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row :global(svg) {
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	.muted {
		font-size: 13px;
		color: var(--text-muted);
	}

	.build-error {
		margin-top: 6px;
		color: var(--danger);
	}
</style>
