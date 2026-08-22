/* The workspace surface registry: which large views exist, where each one is
 * allowed to sit, and how a stored choice resolves at a given viewport.
 *
 * A "surface" is one of the app's large views (a vertical profile, the nav
 * log, a workbook). A "placement" is where it renders. Docked placements are
 * furniture beside the map; overlay placements cover it. The rule that picks
 * a surface's opening placement is data, not taste: map-coupled surfaces dock
 * (the pilot needs the map beside the chart), everything else fills the space
 * between the side panels. Which EDGE a dock takes follows the surface's own
 * shape, defaultDockEdge. Full screen is never a default; it hides the
 * toolbar and the sidebar, so it stays an explicit, remembered choice.
 *
 * Pure and Svelte-free on purpose: the resolution rules are unit-tested in
 * tests/surfaces.spec.ts, and the reactive slots live in
 * $lib/state/workspace.svelte.ts. Locale-free too, per docs/i18n.md: labels
 * are the caller's business.
 */

export type SurfaceId =
	| 'about'
	| 'mapProfile'
	| 'airspaceProfile'
	| 'navlog'
	| 'routeProfile'
	| 'navProfile'
	| 'flightPrep'
	| 'aircraftEditor'
	| 'flights';

export type Placement = 'dock-bottom' | 'dock-right' | 'page' | 'full' | 'dialog';

/** Which of the three workspace slots a placement claims. */
export type Slot = 'dockBottom' | 'dockRight' | 'overlay';

/** The edge a dock placement hugs; null for the overlay placements. */
export type DockEdge = 'bottom' | 'right';

export interface SurfaceDef {
	id: SurfaceId;
	/** Placements the user may choose for this surface. */
	placements: readonly Placement[];
	/** True when the surface is read against the map (charts, logs, the live
	 *  aircraft position), which is what makes docking its default. */
	mapCoupled: boolean;
	/** The edge a map-coupled surface docks to when it opens. Bottom unless
	 *  the surface's own shape wants height rather than width: the profiles
	 *  are wide, short charts on a horizontal distance axis, where the nav log
	 *  is a table that grows downwards a row per leg. Ignored by the surfaces
	 *  that do not default to a dock. */
	defaultDockEdge?: DockEdge;
	/** Smallest usable WIDTH in px, from the surface's own content floor (a
	 *  grid min-width, the narrowest its columns reflow to). It floors a side
	 *  dock, the one placement whose width the app controls, and the surfaces
	 *  whose content cannot reflow below it publish it as their body's
	 *  min-width so they scroll instead of clipping. */
	minWidthPx: number;
	/** Smallest usable HEIGHT in px for a bottom dock: enough to be worth
	 *  docking rather than a sliver of header. */
	minDockHeightPx: number;
	/** Opening dock size as a fraction of the stage along the dock axis,
	 *  before the minimum and the 90% ceiling clamp it. */
	defaultDockFrac: number;
}

const DEFS: readonly SurfaceDef[] = [
	{
		id: 'routeProfile',
		placements: ['dock-bottom', 'dock-right', 'page', 'full'],
		mapCoupled: true,
		minWidthPx: 420,
		minDockHeightPx: 180,
		defaultDockFrac: 0.4,
	},
	{
		id: 'navProfile',
		placements: ['dock-bottom', 'dock-right', 'page', 'full'],
		mapCoupled: true,
		minWidthPx: 420,
		minDockHeightPx: 180,
		defaultDockFrac: 0.4,
	},
	{
		// The airspace stack over a point picked on the map.
		id: 'mapProfile',
		placements: ['dock-bottom', 'dock-right', 'page', 'full'],
		mapCoupled: true,
		minWidthPx: 300,
		minDockHeightPx: 200,
		defaultDockFrac: 0.4,
	},
	{
		// The same chart over a detail panel's own airspaces. A separate
		// surface, not a second instance: the two answer different questions
		// and each has to be addressable on its own.
		id: 'airspaceProfile',
		placements: ['dock-bottom', 'dock-right', 'page', 'full'],
		mapCoupled: true,
		minWidthPx: 300,
		minDockHeightPx: 200,
		defaultDockFrac: 0.4,
	},
	{
		// Docked right: the log is a table growing a row per leg, so it reads
		// down a tall column, where the profiles read across a wide one. The
		// grid is min-width 760px and cannot reflow narrower (eight fixed
		// columns plus the two notes columns), so the side dock rests at a
		// floor wide enough to show it whole: 760 + 32 body padding + 16 for
		// the vertical scrollbar the rows bring + 1 border, rounded up. Under
		// that the log opens already scrolling sideways, which is the one
		// thing a nav log must not do.
		id: 'navlog',
		placements: ['dock-bottom', 'dock-right', 'page', 'full'],
		mapCoupled: true,
		defaultDockEdge: 'right',
		minWidthPx: 812,
		minDockHeightPx: 200,
		defaultDockFrac: 0.4,
	},
	{
		id: 'flightPrep',
		placements: ['page', 'full', 'dock-right'],
		mapCoupled: false,
		minWidthPx: 460,
		minDockHeightPx: 260,
		defaultDockFrac: 0.5,
	},
	{
		id: 'aircraftEditor',
		placements: ['page', 'full'],
		mapCoupled: false,
		minWidthPx: 560,
		minDockHeightPx: 260,
		defaultDockFrac: 0.5,
	},
	{
		// The flights library: a browsing table, not a map companion, so it
		// opens as a page like the workbooks; the side dock stays available
		// for reading a filed flight beside its replay.
		id: 'flights',
		placements: ['page', 'full', 'dock-right'],
		mapCoupled: false,
		minWidthPx: 700,
		minDockHeightPx: 260,
		defaultDockFrac: 0.5,
	},
	{
		id: 'about',
		placements: ['dialog'],
		mapCoupled: false,
		minWidthPx: 320,
		minDockHeightPx: 260,
		defaultDockFrac: 0.5,
	},
] as const;

const BY_ID = new Map<SurfaceId, SurfaceDef>(DEFS.map((d) => [d.id, d]));

export function surfaceDef(id: SurfaceId): SurfaceDef {
	const def = BY_ID.get(id);
	if (!def) {
		// i18n-ignore: programmer diagnostic for a SurfaceId with no registry row, never rendered (docs/i18n.md rule 7)
		throw new Error(`unknown surface ${id}`);
	}
	return def;
}

export const SURFACE_IDS: readonly SurfaceId[] = DEFS.map((d) => d.id);

/** The placement a surface opens in before the user has chosen one:
 *  docked when the map is part of reading it, the page between the side
 *  panels when the surface allows it, else the centred dialog. */
export function defaultPlacement(def: SurfaceDef): Placement {
	if (def.mapCoupled) {
		return def.defaultDockEdge === 'right' ? 'dock-right' : 'dock-bottom';
	}
	return def.placements.includes('page') ? 'page' : 'dialog';
}

/** How a placement renders on a phone, where there is no room beside the map
 *  and no in-flow sidebar to preserve. */
export function mobilePlacement(placement: Placement): Placement {
	switch (placement) {
		case 'dock-right':
			return 'dock-bottom';
		case 'page':
		case 'dialog':
			return 'full';
		default:
			return placement;
	}
}

/** The narrowest strip of map worth splitting with: enough to still fly
 *  against, a leg and its surrounding airspace in view, not just the
 *  aircraft. Below it a side dock is not sharing the stage with the map, it
 *  is taking it, and the surface is better off at the bottom with the whole
 *  width. */
const MIN_MAP_STRIP_PX = 350;

/** True when the stage can seat a side dock at this surface's width floor and
 *  still leave a map. False at an unmeasured stage, which is not a judgement:
 *  see resolvePlacement, which only narrows a placement it can measure. */
export function fitsSideDock(def: SurfaceDef, stageW: number): boolean {
	return stageW > 0 && stageW - def.minWidthPx >= MIN_MAP_STRIP_PX;
}

/** The placement to render: the stored choice when the registry still allows
 *  it, else the default, collapsed for the viewport. A collapse that lands
 *  outside the allowed set (a stored dock-right on a surface that only docks
 *  right) falls back to the collapsed default, so a stale stored value can
 *  never render a surface nowhere.
 *
 *  `stageW` is optional because only a RESOLVED placement is narrowed by it,
 *  never an interactive move: a stage too narrow for a side dock is a reason
 *  not to open there by default, not a reason to refuse the switcher. Left
 *  out (or 0, before the first measurement) nothing narrows. */
export function resolvePlacement(
	def: SurfaceDef,
	stored: string | null,
	isMobile: boolean,
	stageW = 0,
): Placement {
	const chosen = allowed(def, stored) ?? defaultPlacement(def);
	if (!isMobile) {
		return chosen === 'dock-right' && stageW > 0 && !fitsSideDock(def, stageW)
			? narrowed(def, chosen)
			: chosen;
	}
	const collapsed = phoneFitted(def, mobilePlacement(chosen), stageW);
	if (collapsed === chosen || def.placements.includes(collapsed)) {
		return collapsed;
	}
	return phoneFitted(def, mobilePlacement(defaultPlacement(def)), stageW);
}

/** How much wider than the stage a surface's content floor may be and still
 *  be worth docking. A phone bottom dock and a full-screen surface are the
 *  same WIDTH, so the dock buys a split view rather than room: worth it while
 *  the surface shows most of its content, not when the strip is a keyhole.
 *  The nav log's 812px grid against a 414px phone shows half its columns in
 *  40% of the height, where full screen at least gives the whole table; a
 *  profile's 420px floor is the phone's own width and reads fine under the
 *  map, which is the split worth keeping. */
const PHONE_DOCK_WIDTH_TOLERANCE = 1.5;

/** Full screen instead of a phone bottom dock for a surface the stage is far
 *  too narrow for. Resolution only, like the desktop side-dock narrowing: the
 *  stored choice is untouched, an interactive move passes no stageW, and a
 *  surface without `full` keeps its dock. */
function phoneFitted(def: SurfaceDef, placement: Placement, stageW: number): Placement {
	if (placement !== 'dock-bottom' || stageW <= 0 || !def.placements.includes('full')) {
		return placement;
	}
	return def.minWidthPx > stageW * PHONE_DOCK_WIDTH_TOLERANCE ? 'full' : placement;
}

/** A side dock the stage cannot seat becomes a bottom one, which has the
 *  whole stage width; the stored choice is untouched, so a wider window comes
 *  back to it. Surfaces that cannot dock at the bottom keep what they had:
 *  the clamp still holds them to the stage. */
function narrowed(def: SurfaceDef, chosen: Placement): Placement {
	return def.placements.includes('dock-bottom') ? 'dock-bottom' : chosen;
}

function allowed(def: SurfaceDef, stored: string | null): Placement | null {
	const hit = def.placements.find((p) => p === stored);
	return hit ?? null;
}

export function slotFor(placement: Placement): Slot {
	switch (placement) {
		case 'dock-bottom':
			return 'dockBottom';
		case 'dock-right':
			return 'dockRight';
		default:
			return 'overlay';
	}
}

export function dockEdgeOf(placement: Placement): DockEdge | null {
	switch (placement) {
		case 'dock-bottom':
			return 'bottom';
		case 'dock-right':
			return 'right';
		default:
			return null;
	}
}

/** True for the placements that own the whole screen and take the modal
 *  treatment: backdrop, focus trap, aria-modal, a history entry. The page
 *  placement is deliberately not one of them, since the side panels stay on
 *  screen and must stay reachable. */
export function isModalPlacement(placement: Placement): boolean {
	return placement === 'full' || placement === 'dialog';
}

/** True when the placement leaves the map on screen beside the surface. Only
 *  the docks do: a page takes the map's own box, and full screen and the
 *  dialog cover it. What it decides is whether a surface has to get out of
 *  the way when the user follows one of its links to a detail panel. */
export function keepsMapVisible(placement: Placement): boolean {
	return dockEdgeOf(placement) !== null;
}

/** The largest a dock may rest at: 90% of the stage, so the map always keeps
 *  a strip. A drag may pass it, which is what maximises the surface. */
export function dockCeilingPx(stagePx: number): number {
	return Math.max(1, Math.round(stagePx * 0.9));
}

/** A dock size in px held to the surface's content floor and to the ceiling
 *  above, whatever the drag or the window does. */
/** The surface's own floor along a dock axis: its minimum width for a side
 *  dock, its minimum height for a bottom one. */
export function minDockPx(def: SurfaceDef, edge: DockEdge): number {
	return edge === 'bottom' ? def.minDockHeightPx : def.minWidthPx;
}

export function clampDockPx(
	def: SurfaceDef,
	edge: DockEdge,
	stagePx: number,
	px: number,
): number {
	const ceiling = dockCeilingPx(stagePx);
	const floor = Math.min(minDockPx(def, edge), ceiling);
	return Math.max(floor, Math.min(ceiling, Math.round(px)));
}

/** What a released drag on a dock's grip means: a size, or the whole stage. */
export type DockRelease = { kind: 'page' } | { kind: 'size'; px: number };

/** Dragged past the resting ceiling, the strip of map left is too thin to be
 *  a map, so the surface takes the whole area as a page: the divider gesture
 *  runs continuously from docked to maximised. Surfaces with no page
 *  placement just stop at the ceiling. */
export function dockRelease(
	def: SurfaceDef,
	edge: DockEdge,
	stagePx: number,
	px: number,
): DockRelease {
	if (stagePx > 0 && px > dockCeilingPx(stagePx) && def.placements.includes('page')) {
		return { kind: 'page' };
	}
	return { kind: 'size', px: clampDockPx(def, edge, stagePx, px) };
}

/** The same gesture from the other end: dragging a paged surface's top edge
 *  down hands the space back to the map, so it becomes a bottom dock at the
 *  height it was released at. Released near the top it stays a page. */
export function pageRelease(def: SurfaceDef, stagePx: number, px: number): DockRelease {
	if (!def.placements.includes('dock-bottom') || stagePx <= 0 || px > dockCeilingPx(stagePx)) {
		return { kind: 'page' };
	}
	return { kind: 'size', px: clampDockPx(def, 'bottom', stagePx, px) };
}
