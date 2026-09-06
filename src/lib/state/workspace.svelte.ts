/* Where every large view currently sits: the three workspace slots and the
 * live dock sizes.
 *
 * Three slots, so a bottom-docked profile, a right-docked nav log and a
 * dialog can be up at once: `dockBottom`, `dockRight` and `overlay` (the
 * page / full / dialog placements). Opening a surface claims the slot its
 * placement names and closes whatever held it; moving a surface vacates its
 * old slot first, so a surface is never in two.
 *
 * This is the single arbitration point. The modals it replaces arbitrated
 * implicitly, through a full-screen backdrop plus a hand-kept acyclic graph
 * of open() calls closing each other; docked surfaces leave the sidebar
 * live, so that no longer holds and the decision has to be explicit and in
 * one place.
 *
 * The placement rules themselves are pure in $lib/surfaces.ts; this module
 * owns only the reactive slots, the px sizes and the localStorage round trip.
 */

import {
	type DockEdge,
	type Placement,
	type SurfaceId,
	SURFACE_IDS,
	clampDockPx,
	dockEdgeOf,
	keepsMapVisible,
	minDockPx,
	resolvePlacement,
	slotFor,
	surfaceDef,
} from '$lib/surfaces';
import { readItem, removeItem, writeItem } from './persist';
import { closeDetail, ui } from './ui.svelte';

const PREFIX = 'loxodrome:surface';

/** Feeds workspace.openSeq; see frontmostSurface. */
let nextSeq = 1;

function placementKey(id: SurfaceId): string {
	return `${PREFIX}:${id}:placement`;
}

function sizeKey(id: SurfaceId, edge: DockEdge): string {
	return `${PREFIX}:${id}:size-${edge}`;
}

export const workspace = $state<{
	dockBottom: SurfaceId | null;
	dockRight: SurfaceId | null;
	overlay: SurfaceId | null;
	/** Effective placement of each open surface; absent means closed. */
	placement: Partial<Record<SurfaceId, Placement>>;
	/** Open-ness on its own, written wherever `placement` is. It exists
	 *  BECAUSE it is coarser: an effect that only cares whether a surface is
	 *  up must not also wake every time it is docked, paged or maximised.
	 *  Re-writing `true` over `true` is an equal write, so it notifies
	 *  nobody, where re-writing the placement string does. The two are
	 *  pinned equivalent by tests/surfaces.spec.ts. */
	open: Partial<Record<SurfaceId, true>>;
	/** Monotonic claim order, so "which surface is in front" has an answer
	 *  when two docks are up (a bare Ctrl+P has to pick one). */
	openSeq: Partial<Record<SurfaceId, number>>;
	/** Live dock size in px along each edge, 0 when that slot is empty. */
	dockPx: Record<DockEdge, number>;
	/** The stage box in px, published by $lib/ui/stageRect.ts. */
	stage: { w: number; h: number };
}>({
	dockBottom: null,
	dockRight: null,
	overlay: null,
	placement: {},
	open: {},
	openSeq: {},
	dockPx: { bottom: 0, right: 0 },
	stage: { w: 0, h: 0 },
});

/** The placement a surface renders in, or null when it is closed. Reads
 *  state, so it tracks like a derived inside $derived / $effect, and it
 *  tracks the PLACEMENT: a caller that only wants open-ness wants isOpen. */
export function placementOf(id: SurfaceId): Placement | null {
	return workspace.placement[id] ?? null;
}

export function isOpen(id: SurfaceId): boolean {
	return workspace.open[id] === true;
}

/** True when the surface is up in a placement that leaves the map beside it,
 *  so following one of its links needs nobody to move out of the way. */
export function surfaceKeepsMapVisible(id: SurfaceId): boolean {
	const placement = placementOf(id);
	return placement !== null && keepsMapVisible(placement);
}

/** The surface holding a dock edge, or null. */
export function dockSurface(edge: DockEdge): SurfaceId | null {
	return edge === 'bottom' ? workspace.dockBottom : workspace.dockRight;
}

/** Open a surface in its remembered placement (or its default), narrowed to
 *  what this stage can seat. */
export function openSurface(id: SurfaceId): void {
	const stored = readItem(placementKey(id));
	place(id, resolvePlacement(surfaceDef(id), stored, ui.isMobile, workspace.stage.w));
}

export function closeSurface(id: SurfaceId): void {
	vacate(id);
	delete workspace.placement[id];
	delete workspace.open[id];
	delete workspace.openSeq[id];
}

/** The surface a user-initiated print should take: the one covering the
 *  most, then the most recently opened dock. */
export function frontmostSurface(): SurfaceId | null {
	if (workspace.overlay !== null) {
		return workspace.overlay;
	}
	const docks = [workspace.dockBottom, workspace.dockRight].filter(
		(id): id is SurfaceId => id !== null,
	);
	return docks.sort((a, b) => (workspace.openSeq[b] ?? 0) - (workspace.openSeq[a] ?? 0))[0] ?? null;
}

/** Move an open surface to another placement and remember the choice. The
 *  stored value is the user's pick, not the phone-collapsed rendering, so
 *  the same session on a wide window comes back to what they chose. */
export function setPlacement(id: SurfaceId, placement: Placement): boolean {
	// Remember only what actually took: an eviction the incumbent refuses
	// leaves the surface where it was, and storing the placement anyway meant
	// its next open landed somewhere nobody chose.
	const moved = movePlacement(id, placement);
	if (moved) {
		writeItem(placementKey(id), placement);
	}
	return moved;
}

/** Move without remembering: for a placement change mid-gesture, where only
 *  where the drag is released is the user's actual choice. False when the
 *  surface is closed or the target slot's occupant refused to go. */
export function movePlacement(id: SurfaceId, placement: Placement): boolean {
	// A drag whose surface closed mid-gesture must not resurrect it on
	// pointerup; only openSurface opens.
	if (!isOpen(id)) {
		return false;
	}
	return place(id, ui.isMobile ? resolvePlacement(surfaceDef(id), placement, true) : placement);
}

/* Close handlers, registered by SurfaceShell while a surface is open, so an
 * eviction takes the same path as that surface's own X. It matters because a
 * close can refuse: the aircraft editor asks before discarding unsaved edits,
 * and with the surfaces non-modal its slot can now be claimed from a sidebar
 * that stays live behind it. A plain closeSurface would have thrown the edits
 * away silently. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a callback registry, never rendered
const closers = new Map<SurfaceId, () => void>();

export function registerSurfaceClose(id: SurfaceId, close: () => void): () => void {
	closers.set(id, close);
	return () => {
		if (closers.get(id) === close) {
			closers.delete(id);
		}
	};
}

/** Close a surface the way its own X would, so a close that asks first (the
 *  aircraft editor's unsaved-edits confirm) still gets to. Falls back to a
 *  plain close before the shell has registered. */
export function requestCloseSurface(id: SurfaceId): void {
	const close = closers.get(id);
	if (close) {
		close();
	} else {
		closeSurface(id);
	}
}

/** Ask the surface holding a slot to go. False when it refused, in which case
 *  the caller leaves the workspace exactly as it was. */
function evict(incumbent: SurfaceId): boolean {
	requestCloseSurface(incumbent);
	return !isOpen(incumbent);
}

/** The surfaces a placement cannot share the stage with.
 *
 *  A page takes the whole stage, so it and a dock are mutually exclusive.
 *  Both halves of that follow from what the two placements are FOR. A dock
 *  means "split with the map": it exists to sit beside the map, and a page
 *  is what replaces the map, so a dock left standing under one is docked to
 *  nothing, splitting two surfaces against each other in a layout the system
 *  never offered. And a page that only takes the leftover box is not a page:
 *  giving it the remainder let a nav log at its width floor squeeze a
 *  "maximised" profile to 258px, under the 420px minimum every dock is
 *  clamped to, so the maximise control made a chart smaller than any dock is
 *  allowed to be.
 *
 *  Full screen and the dialog are not in this: they cover the docks rather
 *  than competing with them, and dismissing one brings the layout back. */
function conflictingOccupants(id: SurfaceId, placement: Placement): SurfaceId[] {
	const others = (ids: (SurfaceId | null)[]): SurfaceId[] =>
		ids.filter((held): held is SurfaceId => held !== null && held !== id);
	if (placement === 'page') {
		return others([workspace.dockBottom, workspace.dockRight]);
	}
	if (dockEdgeOf(placement) !== null) {
		const overlay = workspace.overlay;
		return others([overlay !== null && workspace.placement[overlay] === 'page' ? overlay : null]);
	}
	return [];
}

function place(id: SurfaceId, placement: Placement): boolean {
	const slot = slotFor(placement);
	const incumbent = workspace[slot];
	if (incumbent !== null && incumbent !== id && !evict(incumbent)) {
		return false;
	}
	// evict() ran the incumbent's own close handler, which is arbitrary code
	// and may have placed something here in the meantime; re-read rather than
	// overwriting a slot whose occupant would then render with no slot.
	const after = workspace[slot];
	if (after !== null && after !== id && !evict(after)) {
		return false;
	}
	// The slot is settled; now clear anything the placement cannot share the
	// stage with. Deliberately after the slot, since only the overlay slot can
	// hold a surface whose close refuses (the aircraft editor's dirty confirm)
	// and nothing that can hold a conflicting slot does.
	for (const conflict of conflictingOccupants(id, placement)) {
		if (!evict(conflict)) {
			return false;
		}
	}
	vacate(id);
	workspace[slot] = id;
	workspace.placement[id] = placement;
	workspace.open[id] = true;
	if (workspace.openSeq[id] === undefined) {
		workspace.openSeq[id] = nextSeq++;
	}
	const edge = dockEdgeOf(placement);
	if (edge) {
		workspace.dockPx[edge] = openingDockPx(id, edge);
	}
	// A page takes the map's whole box and renders UNDER the detail panel
	// (app.css: .at-page is z 1090, the panel 1092), which is the one overlay
	// that insets for the docks and cannot for a page. The panel covered the
	// surface's own header, its close included, and a paged surface answers
	// Escape only from inside, so there was no way out but to notice the panel.
	// The panel is the MAP's answer and a page is what replaces the map: the
	// mirror of leaveForDetail, which steps a profile aside for the same
	// reason. Full screen and the dialog are not in this; they cover the panel
	// themselves, so closing it there would drop a selection for nothing.
	if (placement === 'page') {
		closeDetail();
	}
	return true;
}

function vacate(id: SurfaceId): void {
	if (workspace.dockBottom === id) {
		workspace.dockBottom = null;
		workspace.dockPx.bottom = 0;
	}
	if (workspace.dockRight === id) {
		workspace.dockRight = null;
		workspace.dockPx.right = 0;
	}
	if (workspace.overlay === id) {
		workspace.overlay = null;
	}
}

function stagePx(edge: DockEdge): number {
	return edge === 'bottom' ? workspace.stage.h : workspace.stage.w;
}

function openingDockPx(id: SurfaceId, edge: DockEdge): number {
	const def = surfaceDef(id);
	const stored = parseInt(readItem(sizeKey(id, edge)) ?? '', 10);
	const remembered = Number.isFinite(stored) && stored > 0 ? stored : null;
	const stage = stagePx(edge);
	if (stage <= 0) {
		// Before the first stage measurement (an open during boot): take the
		// remembered size as-is; setStageSize re-clamps it on the first frame.
		return remembered ?? minDockPx(def, edge);
	}
	return clampDockPx(def, edge, stage, remembered ?? Math.round(stage * def.defaultDockFrac));
}

/** Live drag: follow the pointer, held only to the surface's floor and the
 *  stage itself. Deliberately looser than the resting clamp, so the panel
 *  keeps tracking the grip past its ceiling and up to the maximise
 *  threshold instead of stalling under the finger. */
export function setDockPx(edge: DockEdge, px: number): void {
	const id = dockSurface(edge);
	if (!id) {
		return;
	}
	const stage = stagePx(edge);
	if (stage <= 0) {
		workspace.dockPx[edge] = Math.round(px);
		return;
	}
	const floor = Math.min(minDockPx(surfaceDef(id), edge), stage);
	workspace.dockPx[edge] = Math.max(floor, Math.min(stage, Math.round(px)));
}

/** Drag release: hold the size to the resting range, keep it and remember it
 *  for this surface and edge. */
export function commitDockPx(edge: DockEdge, px: number): void {
	const id = dockSurface(edge);
	if (!id) {
		return;
	}
	const stage = stagePx(edge);
	if (stage <= 0) {
		// Nothing to clamp against yet, so keep the value on screen but do not
		// remember it: openingDockPx would read back a size no stage produced.
		workspace.dockPx[edge] = Math.round(px);
		return;
	}
	workspace.dockPx[edge] = clampDockPx(surfaceDef(id), edge, stage, px);
	writeItem(sizeKey(id, edge), String(workspace.dockPx[edge]));
}

/** Forget a remembered dock size and go back to the surface's own share of
 *  the stage. A drag is remembered for good, so without this the default is
 *  reachable only by clearing storage. */
export function resetDockPx(edge: DockEdge): void {
	const id = dockSurface(edge);
	if (!id) {
		return;
	}
	removeItem(sizeKey(id, edge));
	workspace.dockPx[edge] = openingDockPx(id, edge);
}

/** Publish the measured stage box and re-clamp the open docks to it, so a
 *  window that shrinks below a dock's size does not leave the map at zero. */
export function setStageSize(w: number, h: number): void {
	if (workspace.stage.w === w && workspace.stage.h === h) {
		// Nothing moved, so nothing to re-clamp; bailing also keeps this off
		// the back of a live drag, whose whole point is to pass the ceiling.
		return;
	}
	workspace.stage.w = w;
	workspace.stage.h = h;
	for (const edge of ['bottom', 'right'] as const) {
		const id = dockSurface(edge);
		const stage = stagePx(edge);
		if (id && stage > 0) {
			workspace.dockPx[edge] = clampDockPx(surfaceDef(id), edge, stage, workspace.dockPx[edge]);
		}
	}
}

/** Re-place every open surface for the current viewport, called when
 *  ui.isMobile flips. A phone has one dock and no page, so a desktop pair
 *  can collapse onto the same slot.
 *
 *  Nothing here may prompt: this runs inside the matchMedia handler, i.e. on
 *  a device rotation, and an eviction would pop the aircraft editor's
 *  unsaved-edits confirm out of nowhere - and refusing it left the other
 *  surface in a placement its own switcher could not offer, with no way
 *  back. So a surface already resolved where it is stays put, and one whose
 *  target slot is taken closes ITSELF rather than evicting the incumbent. */
export function reflowSurfaces(): void {
	for (const id of SURFACE_IDS) {
		if (!isOpen(id)) {
			continue;
		}
		const target = resolvePlacement(
			surfaceDef(id),
			readItem(placementKey(id)),
			ui.isMobile,
			workspace.stage.w,
		);
		if (placementOf(id) === target) {
			continue;
		}
		const incumbent = workspace[slotFor(target)];
		if (incumbent !== null && incumbent !== id) {
			closeSurface(id);
			continue;
		}
		place(id, target);
	}
}

