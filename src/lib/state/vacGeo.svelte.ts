/* The VAC panel georeference: lazily loaded, slot-picked, fail-soft.
 *
 * The adCharts.svelte.ts chartSet pattern, with two differences the data
 * forces: an ident carries several panels rather than one row, and the map
 * layer asks by AREA rather than by ident. The set is 724 rows, so the area
 * query is a scan; an index would be machinery for a list that fits in a
 * cache line's worth of cache lines.
 *
 * Nothing here fetches a plate. This module knows only WHERE each panel
 * goes; offline/docFetch.ts gets the bytes and state/vacPanels renders
 * them. */

import {
	FR_VACGEO_NEXT_URL,
	FR_VACGEO_URL,
	loadFrVacGeo,
	PANEL_ZOOM_CEILING,
	PANEL_ZOOM_SLACK,
	panelContains,
	type VacPanel,
	type VacPanelKind,
} from '$lib/data/vacgeo';
import { loadFrVacGeoMeta, loadFrVacGeoNextMeta, pickActiveDataset } from '$lib/data/meta';

export const vacGeoState = $state<{
	loaded: boolean;
	loading: boolean;
	error: string | null;
	/** Aerodromes with at least one placed panel, for the Layers tab. */
	aerodromes: number;
}>({ loaded: false, loading: false, error: null, aerodromes: 0 });

// Plain, non-reactive: the load flag above is the reactive signal, the
// house idiom for a dataset whose rows never change after they arrive.
let panels: VacPanel[] | null = null;
let promise: Promise<VacPanel[]> | null = null;

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Load the dataset once. Idempotent; a failure clears the promise so a
 *  later toggle retries rather than leaving the layer permanently empty. */
export function ensureVacGeo(): Promise<VacPanel[]> {
	if (panels) {
		return Promise.resolve(panels);
	}
	if (promise) {
		return promise;
	}
	vacGeoState.loading = true;
	vacGeoState.error = null;
	promise = (async () => {
		const [meta, nextMeta] = await Promise.all([
			loadFrVacGeoMeta().catch(() => null),
			loadFrVacGeoNextMeta().catch(() => null),
		]);
		const { url } = pickActiveDataset(
			meta?.effective ?? null,
			nextMeta?.effective ?? null,
			FR_VACGEO_URL,
			FR_VACGEO_NEXT_URL,
			// A one-shot timestamp passed by value, the chartSet idiom.
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
			new Date(),
		);
		const rows = await loadFrVacGeo(url);
		panels = rows;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- counted once, discarded
		const idents = new Set(rows.map((p) => p.ident));
		vacGeoState.aerodromes = idents.size;
		vacGeoState.loaded = true;
		vacGeoState.loading = false;
		return rows;
	})().catch((e: unknown) => {
		vacGeoState.error = message(e);
		vacGeoState.loading = false;
		promise = null;
		throw e;
	});
	return promise;
}

/** Every placed panel of one aerodrome, which the detail panel can say so. */
export function vacPanelsForIdent(ident: string): VacPanel[] {
	void vacGeoState.loaded;
	const key = ident.toUpperCase();
	return panels?.filter((p) => p.ident === key) ?? [];
}

export interface VacArea {
	south: number;
	west: number;
	north: number;
	east: number;
}

/** The VAC panels to draw for a view: the sheets of ONE aerodrome, the one
 * the middle of the view is on.
 *
 * The obvious rule, "draw every sheet whose own scale suits this zoom",
 * makes a quilt. Over the Paris basin at zoom 10 it tiles a dozen approach
 * sheets across the whole screen, each cut off at its own frame, at
 * different scales and orientations, with the base map showing through the
 * gaps and the aerodrome actually being looked at buried among the others.
 * It is unreadable, and it is not what a VAC is for: the chart answers a
 * question about one aerodrome, not about a region.
 *
 * So the view's own centre picks the aerodrome. In flight with follow mode
 * on that is the aircraft, which is exactly right; planning, it is the
 * middle of what is being looked at, which is also right. Nothing draws
 * when the centre is on no sheet at all, and moving off an aerodrome puts
 * the map back rather than leaving a chart hanging.
 *
 * Within that aerodrome, at most one sheet per family, and the family
 * whose scale is nearest this zoom always draws. The others join it only
 * while the zoom is inside their own window, which is what makes the
 * approach sheet hand over to the landing sheet and then to the ground
 * chart as the aircraft closes.
 *
 * The floor below sits a zoom level under printed size. A sheet arriving
 * at half its engraved size is not yet a chart to read: its 5 pt lettering
 * is four pixels tall. It is a chart to SEE COMING, which is the thing a
 * floor at printed size took away, since an overlay that appears only once
 * you are on top of the aerodrome cannot tell you the aerodrome is there.
 * The map underneath stays the better answer for the detail until a level
 * later, and it shows through nothing: the sheet is opaque, so what the
 * floor really decides is when the chart is worth covering the map with.
 *
 * The ceiling moves with the floor, and by the same level, so that
 * widening the window cannot take a sheet AWAY. The two interact through
 * the nearest-scale rule: admitting the ground chart a level earlier makes
 * it the nearest sheet at that zoom, and with the old ceiling that evicted
 * the landing sheet, replacing four kilometres of chart with a patch a
 * kilometre wide. Both bounds move together, and every sheet that draws at
 * a given zoom today still draws there.
 *
 * Reading vacGeoState.loaded makes a caller in a $derived or an $effect
 * re-run when the dataset lands. */
/** Which sheet of one aerodrome sits over which, most detailed on top: its
 *  larger scale is the closer answer for the ground they share.
 *
 *  The three nest exactly, the ground chart inside the landing sheet inside
 *  the approach one, so whichever is underneath is hidden ENTIRELY and not
 *  merely overlapped. Lognes engraves its ground chart for zoom 15 and its
 *  landing sheet for zoom 12; with the landing sheet on top the ground
 *  chart could never be seen at all, which is the one thing it is for. */
const KIND_ON_TOP: Record<VacPanelKind, number> = { APP: 0, ATT: 1, GMC: 2 };

/** How much of the view the chart being read must still cover to keep the
 *  lead once the middle has moved off it. */
const HOLD_SHARE = 0.2;

/** Of two editions of one sheet, is `p` the one to draw at this zoom? The
 *  nearer scale wins; a tie goes to the aerodrome's own plate over the
 *  helistation one, then to the earlier page, so the choice is the same
 *  answer every pass and never the dataset's order.
 *
 *  `reachable` ranks an edition by whether it ANSWERS FOR THIS PLACE (over
 *  the middle of the view, merely on screen, or neither) and is passed for
 *  the aerodrome the reader asked for by name, for that one alone. The two
 *  editions of a sheet are nested rather than equal, and the coarse one can
 *  cover a great deal more ground: Le Bourget's approach sheet twelve times
 *  more, Cannes' landing sheet fifteen. Over that outer ring the finer
 *  edition does not cover the ground clicked and can be off the screen
 *  altogether, so the row named a field and then brought up a chart that was
 *  not over it, or nothing at all: the pass could not honour the pin and
 *  MapView dropped it on the spot. Swept over the corpus at zooms 9 to 15,
 *  that was every chart row for Le Bourget, Cannes, Nice and Toulouse near
 *  the edge of their coarse sheets.
 *
 *  It is not passed for the automatic pick, which must stay a function of
 *  the scale alone. Deciding THAT from the viewport is what drew CDG's
 *  coarse landing sheet at three and a half times its size north of Chelles
 *  and then swapped it for the finer one as the map panned up. The
 *  difference is that a pin is a gesture: it names one field, it is shown
 *  live under the pointer as a preview before it is set, and the reader can
 *  see which sheet answered. */
function betterEdition(
	p: VacPanel,
	best: VacPanel,
	zoom: number,
	nativeZoomOf: (p: VacPanel) => number,
	reachable: ((p: VacPanel) => number) | null,
): boolean {
	if (reachable) {
		const rp = reachable(p);
		const rb = reachable(best);
		if (rp !== rb) {
			return rp > rb;
		}
	}
	const dp = Math.abs(nativeZoomOf(p) - zoom);
	const db = Math.abs(nativeZoomOf(best) - zoom);
	if (dp !== db) {
		return dp < db;
	}
	if (p.section !== best.section) {
		return p.section < best.section;
	}
	return p.page < best.page;
}

/** Would `over` hide `under` completely if drawn above it?
 *
 *  Only an axis-aligned panel covers its own envelope. A ground-movement
 *  chart is ROTATED, so its bounds are the box around a tilted quad and the
 *  corners of that box are map rather than chart; taking one for a cover
 *  would drop a sheet that is plainly visible beside it. */
function coversWholly(over: VacPanel, under: VacPanel): boolean {
	if (over.aff[1] !== 0 || over.aff[2] !== 0) {
		return false;
	}
	return (
		over.south <= under.south &&
		over.north >= under.north &&
		over.west <= under.west &&
		over.east >= under.east
	);
}

/** Every chart whose page covers this position, most detailed first.
 *
 *  From the DATASET and ungated by what is drawn, which is what the
 *  right-click menu asks of every layer: it lists airspaces and SUP AIP the
 *  same way, so the full stack over a point stays one right-click away with
 *  every checkbox off. It is also the only route to a sheet that is not
 *  drawn because another covers it entirely. */
export function vacPanelsAt(lat: number, lon: number): VacPanel[] {
	void vacGeoState.loaded;
	if (!panels) {
		return [];
	}
	return panels
		.filter((p) => panelContains(p, lat, lon))
		.sort((a, b) => KIND_ON_TOP[b.kind] - KIND_ON_TOP[a.kind] || a.ident.localeCompare(b.ident));
}

export function vacPanelsIn(
	area: VacArea,
	kinds: readonly VacPanelKind[],
	zoom: number,
	nativeZoomOf: (p: VacPanel) => number,
	/** The aerodromes drawn last time, most relevant first. Each keeps its
	 *  place while any of its panels is still on screen. Empty on the first
	 *  call. */
	held: readonly string[] = [],
	opts: {
		/** How far under its printed size a sheet may still be drawn. */
		zoomSlack?: number;
		/** How far past it the best-scaled sheet may still be drawn. */
		zoomCeiling?: number;
		/** What a panel will cost to draw, in whatever unit the budget is
		 *  in. The caller owns this because the price is a bitmap and the
		 *  rasteriser's own cap belongs with the rasteriser. */
		costOf?: (p: VacPanel) => number;
		/** How much of that the whole view may spend. */
		budget?: number;
		/** An aerodrome the reader has asked for by name, which leads
		 *  whatever the view is centred on. */
		pinned?: string | null;
	} = {},
): VacPanel[] {
	const zoomSlack = opts.zoomSlack ?? PANEL_ZOOM_SLACK;
	const zoomCeiling = opts.zoomCeiling ?? PANEL_ZOOM_CEILING;
	const costOf = opts.costOf ?? (() => 0);
	const budget = opts.budget ?? Infinity;
	const pinned = opts.pinned ?? null;
	void vacGeoState.loaded;
	if (!panels || kinds.length === 0) {
		return [];
	}
	const cLat = (area.south + area.north) / 2;
	const cLon = (area.west + area.east) / 2;
	const kx = Math.cos((cLat * Math.PI) / 180);
	const inView = (p: VacPanel): boolean =>
		p.south <= area.north && p.north >= area.south && p.west <= area.east && p.east >= area.west;
	const inCentre = (p: VacPanel): boolean =>
		p.south <= cLat && cLat <= p.north && p.west <= cLon && cLon <= p.east;
	/** How well an edition answers for the field the reader named: over the
	 *  middle of the view, merely on screen, or neither. */
	const pinReach = (p: VacPanel): number => (inCentre(p) ? 2 : inView(p) ? 1 : 0);
	/** How much of the view this panel covers, nought to one. */
	const share = (p: VacPanel): number => {
		const w = Math.max(0, Math.min(p.east, area.east) - Math.max(p.west, area.west));
		const h = Math.max(0, Math.min(p.north, area.north) - Math.max(p.south, area.south));
		const view = (area.north - area.south) * (area.east - area.west);
		return view > 0 ? (w * h) / view : 0;
	};

	// ONE EDITION of each sheet, and the SCALE picks it.
	//
	// A large field files its plate in both Atlas products and the
	// helistation one repeats it: Nice's landing sheet is in the set seven
	// times, Bastia's three, CDG's twice at zoom 11.2 and 12.0. They are
	// the same ground rather than pieces of it, so at most one can be
	// drawn (of the 733 ident-and-kind groups only 35 hold more than one
	// panel, and just one pair of those is less than nine tenths the same
	// box), and the only question is which.
	//
	// It must not be the viewport that answers it. The picks below run
	// over the panels IN VIEW, which is a cost rule, and it was choosing
	// editions: north of Chelles at zoom 13, CDG's coarser landing sheet
	// was the only one of the two the screen reached, so it was drawn
	// across the top of it at three and a half times its size, and panning
	// up to read it brought the finer one into view, which won the
	// nearest-scale test and replaced it. The chart could not be read at
	// all. Deciding by scale draws the coarse edition where it IS the
	// nearer one, two levels down, and never as an accident of where the
	// map happens to be.
	//
	// A tie keeps the aerodrome's own plate ahead of the helistation one
	// and then the earlier page, so Nice's six repeats are one sheet.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local index, not state
	const editions = new Map<string, VacPanel>();
	for (const p of panels) {
		if (!kinds.includes(p.kind)) {
			continue;
		}
		const key = `${p.ident}|${p.kind}`;
		const best = editions.get(key);
		const reachable = p.ident === pinned ? pinReach : null;
		if (best === undefined || betterEdition(p, best, zoom, nativeZoomOf, reachable)) {
			editions.set(key, p);
		}
	}
	const wanted = [...editions.values()];
	// The middle of the view picks the aerodrome, and where nothing is
	// under the middle the sheets ON SCREEN answer instead.
	//
	// It is one question either way, "which chart is this ground on", put
	// to the middle first because that is where the eye is. Requiring an
	// answer there made the overlay vanish a whole screen early: a sheet
	// wider than the window is read by panning across it, and the gaps
	// between the Paris basin's approach sheets are narrower than a
	// screen, so a centre that has slipped a kilometre past Le
	// Plessis-Belleville's eastern edge is still looking at the chart. The
	// early return also cut the hold below short, since a panel one has
	// panned off the edge of is exactly the one worth keeping.
	const under = wanted.filter(inCentre);
	if (under.length === 0 && !wanted.some(inView)) {
		return [];
	}

	// The aerodrome is chosen BEFORE any zoom test, and the zoom then only
	// decides which of its sheets to draw. Filtering by zoom first would
	// let the choice fall through to whichever neighbour's sheet happens
	// to be legible: over Lognes at zoom 11, where Lognes' own sheets are
	// all too small to read, that put Orly's approach chart across the
	// screen. The answer there is no chart, not another aerodrome's.
	const offset = (p: VacPanel): number =>
		Math.hypot((p.south + p.north) / 2 - cLat, ((p.west + p.east) / 2 - cLon) * kx);
	const byDistance = (list: readonly VacPanel[]): VacPanel[] =>
		[...list].sort((a, b) => offset(a) - offset(b) || nativeZoomOf(b) - nativeZoomOf(a));
	// The chosen field's sheets, one per family (`wanted` holds a single
	// edition of each, by scale, above). A sheet off the screen entirely
	// is not an answer to a question asked by area, and it is not free
	// either: every panel returned is fetched out of its plate and
	// rasterised at screen scale.
	const sheetsOf = (ident: string): VacPanel[] => {
		const picks = wanted.filter(
			(p) => p.ident === ident && inView(p) && zoom >= nativeZoomOf(p) - zoomSlack,
		);
		if (picks.length === 0) {
			return [];
		}
		let nearest = picks[0];
		for (const p of picks) {
			if (Math.abs(nativeZoomOf(p) - zoom) < Math.abs(nativeZoomOf(nearest) - zoom)) {
				nearest = p;
			}
		}
		return picks
			.filter((p) => p === nearest || zoom <= nativeZoomOf(p) + zoomCeiling)
			.sort((a, b) => KIND_ON_TOP[b.kind] - KIND_ON_TOP[a.kind]);
	};

	// The chart being READ keeps the choice, and it keeps it while it is
	// still ON SCREEN rather than while the view centre is still on it.
	//
	// Picking the nearest panel centre answers "what is here", which is
	// the right question until you are reading a chart and the wrong one
	// after. A sheet is often wider than the screen at a legible zoom, so
	// panning across it IS how it is read, and the centre leaves it long
	// before the chart does: Creteil's approach panel is 3.1 km across, so
	// sliding right to see its eastern half put the centre onto Chelles'
	// panel and the chart vanished with half of it still on the screen.
	// The Paris basin is blanketed by overlapping approach sheets, so
	// there is no gap to fall into either.
	//
	// Holding while visible costs one thing, and it is the right price: a
	// chart you have panned away from lingers until it leaves the screen.
	// It cannot linger longer than that.
	const order: string[] = [];
	const consider = (ident: string): void => {
		if (!order.includes(ident)) {
			order.push(ident);
		}
	};
	// Only the chart that WAS leading may keep the lead, and only while it
	// is still a chart you could be reading: under the middle of the view,
	// or filling enough of the screen to be what you are looking at. The
	// rest of the held list orders the neighbours below it and never
	// promotes one.
	//
	// Both bounds were paid for. Letting any held sheet lead let a former
	// neighbour inherit the front. Holding for as long as a panel merely
	// touched the screen was unbounded: panning from Le Touquet to Calais
	// kept Le Touquet's chart on top the whole way, on a tenth of the view
	// at the edge, while Calais sat under the middle covering forty per
	// cent of it. And holding only while the middle is ON the panel is too
	// short, because a sheet wider than the screen is READ by panning off
	// its edge, which is where this hold came from.
	//
	// The share separates them and it was measured, not chosen: panning
	// east across Creteil's approach chart, the sheet being read holds 46,
	// 41, 37, 32, 28 and 23 per cent of the view over six steps, while Le
	// Touquet at Calais is down to 10.
	// A pin is an instruction, not a hold, so it leads without having to
	// earn its place under the middle of the view or across a fifth of the
	// screen. Everything else follows from being the leader: the zoom slack,
	// the best-sheet exemption, and a budget that is only spent after it.
	if (pinned !== null && wanted.some((p) => p.ident === pinned && inView(p))) {
		consider(pinned);
	}
	// The share bounds the hold across the screen; the sheet's own CEILING
	// bounds it across the zoom, and it has to, because zooming in only ever
	// grows the share. A chart the view has zoomed past is no longer the
	// chart being read, it is a blow-up of one: Chelles' approach sheet is
	// engraved for zoom 10, and held on the way in it covered Lognes at zoom
	// 15 at thirty times its size, with Lognes' own ground chart, engraved
	// for exactly that zoom and under the middle of the view, never drawn.
	// The field under the middle answers then, which is the ordering below.
	//
	// One panel has to pass BOTH: the held field keeps the lead on a sheet
	// that is still on screen in the reading sense and still near its own
	// size. Losing the hold costs nothing where nothing better answers, the
	// walk below reaching the same field through the middle of the view or
	// the screen, with the same best-sheet exemption once it leads.
	const lastLead = held[0];
	if (
		lastLead !== undefined &&
		wanted.some(
			(p) =>
				p.ident === lastLead &&
				(inCentre(p) || share(p) >= HOLD_SHARE || under.length === 0) &&
				inView(p) &&
				zoom <= nativeZoomOf(p) + zoomCeiling,
		)
	) {
		consider(lastLead);
	}
	// The middle of the view is asked first and the rest of the screen
	// after it, both nearest first. Asking ONLY the middle blanked a third
	// of all views: the candidates were the panels containing the centre,
	// so when none of those had a sheet legible at this zoom the answer was
	// nothing at all, however many legible charts lay around it. Sliding
	// 1.5 km north of Le Bourget put the centre inside one landing panel
	// engraved for zoom 13 and took five legible landing charts off the map.
	for (const p of byDistance(under)) {
		consider(p.ident);
	}
	for (const p of byDistance(wanted.filter(inView))) {
		consider(p.ident);
	}

	// A field with nothing legible to show does not get to answer for the
	// screen. Returning empty at the first candidate let one small sheet
	// blank the map: at zoom 11 east of Le Plessis-Belleville the nearest
	// panel is a hospital helipad 9 km away whose approach sheet wants
	// zoom 12.4, and it silenced every approach chart in the basin.
	//
	// The fall-through stops where the middle of the view has an answer of
	// its own. Over Lognes at a zoom where Lognes' sheets are thumbnails,
	// Orly's chart covers the same ground and IS legible, and putting it
	// across a map centred on Lognes is the fault this whole ordering
	// exists to prevent. So a centre that is ON a panel is answered by
	// that field or by nothing; only a centre in the gaps looks further.
	let chosen: string | null = null;
	let drawn: VacPanel[] = [];
	for (const ident of order) {
		drawn = sheetsOf(ident);
		if (drawn.length > 0) {
			chosen = ident;
			break;
		}

	}
	if (chosen === null) {
		return [];
	}

	// Then the neighbours, STACKED rather than filtered.
	//
	// Hiding a chart because a nearer one covers part of its ground was the
	// first rule, and it made charts vanish from the middle of the screen
	// while panning: the test ran in distance-from-centre order, so moving
	// the centre changed which panels survived it. Over Lognes at zoom 12,
	// sliding east dropped Saint-Cyr and then Coulommiers with both still
	// wholly on screen.
	//
	// Where two charts cover the same ground, drawing both and letting the
	// more relevant one sit on top is the truer answer anyway. The seam is
	// the upper chart's own neatline, a real edge of a real document, and a
	// mosaic of overlapping sheets is how paper charts read on a table.
	//
	// What bounds the set now is COST, which is what the overlap rule was
	// really doing without saying so. Drawing every sheet in view is not
	// affordable: 112 MB of bitmap over Creteil at zoom 13 and 121 MB over
	// Lognes at zoom 12, each panel a separate plate to fetch. So panels
	// are taken NEAREST FIRST until the budget is spent, which drops the
	// farthest, at the edge of the view where a chart is least missed and
	// is mostly off screen already.
	//
	// A neighbour reads at the same size as the leader, so it answers to
	// the same floor; what keeps the quilt away is the budget. It still
	// does not get the exemption that keeps the best-scaled sheet however
	// far past its size the view goes: that belongs to the chart being
	// read.
	// The sheets already drawn keep their places ahead of any newcomer, so
	// what the budget turns away is a chart that was not there a moment ago
	// rather than one being read. Without it the marginal panel changes
	// hands as the distances reorder, and a sheet at the edge of the budget
	// blinks while panning exactly as the hidden ones used to.
	const rank = (p: VacPanel): number => {
		const i = held.indexOf(p.ident);
		return i < 0 ? held.length : i;
	};
	let spent = 0;
	for (const p of drawn) {
		spent += costOf(p);
	}
	const others = wanted
		.filter(
			(p) =>
				p.ident !== chosen &&
				zoom >= nativeZoomOf(p) - zoomSlack &&
				zoom <= nativeZoomOf(p) + zoomCeiling &&
				inView(p),
		)
		.sort(
			(a, b) =>
				rank(a) - rank(b) || offset(a) - offset(b) || nativeZoomOf(b) - nativeZoomOf(a),
		);

	for (const p of others) {
		// One sheet per aerodrome among the neighbours: a second sheet of
		// the same field sits on its own first one, which is the quilt in
		// miniature and buys no ground.
		if (drawn.some((q) => q.ident === p.ident)) {
			continue;
		}
		// Nor a sheet that would be drawn entirely under one already
		// taken. Stacking answers what to do where charts OVERLAP; a chart
		// wholly inside another is not overlapped, it is invisible, and it
		// still costs a plate to fetch and a bitmap to hold. Swept over
		// every aerodrome at eight zooms, 498 panels were drawn where
		// nothing of them could be seen, 1.6 GB of bitmap.
		if (drawn.some((q) => coversWholly(q, p))) {
			continue;
		}
		const c = costOf(p);
		if (spent + c > budget) {
			continue;
		}
		spent += c;
		drawn.push(p);
	}
	return drawn;
}



/** Reset for tests. */
export function resetVacGeoForTest(): void {
	panels = null;
	promise = null;
	vacGeoState.loaded = false;
	vacGeoState.loading = false;
	vacGeoState.error = null;
	vacGeoState.aerodromes = 0;
}
