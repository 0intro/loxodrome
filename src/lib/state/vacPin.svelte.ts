/* The chart the reader asked for by name.
 *
 * Which VAC sheet leads the stack is otherwise a heuristic: the aerodrome
 * under the middle of the view, held while it still fills a fifth of the
 * screen. That is right most of the time and wrong exactly when it matters,
 * with a chart you want lying under one you do not. A pin says "this one".
 *
 * Its own module because two places set it and neither owns the other: the
 * map click, in MapView, and the right-click menu, which reaches its state
 * directly rather than through props. Session-only, like every other
 * selection: a pin is about the chart in front of you now.
 *
 * It is an IDENT, the panel selector's own unit, so an aerodrome's sheets
 * come up together in the order they always have, the ground chart over the
 * landing sheet over the approach one. */

export const vacPin = $state<{ ident: string | null; preview: string | null }>({
	ident: null,
	preview: null,
});

/** What the stack should lead with: a chart being pointed at wins over the
 *  one pinned, and gives it back the moment the pointer leaves. */
export function leadingChart(): string | null {
	return vacPin.preview ?? vacPin.ident;
}

/** Show a chart while the reader points at its row in the right-click menu,
 *  the way hovering an airspace row lights that airspace up. Null puts the
 *  stack back.
 *
 *  A preview is not a pin: it is never persisted, and whatever clears it has
 *  to be something that CANNOT be missed. A row can stop existing under a
 *  still pointer, and an element removed under one fires no mouseleave, so
 *  the menu closing clears this rather than the row leaving alone. That is
 *  the same reason featureHover.svelte.ts asserts its hover from an effect
 *  instead of writing it through. */
export function previewVacChart(ident: string | null): void {
	vacPin.preview = ident;
}

/** Bring a chart to the top, or let go of it if it is already the one
 *  pinned: the gesture that sets a pin is the one that clears it, so there
 *  is nothing to find in a menu to undo it. */
export function pinVacChart(ident: string): void {
	vacPin.ident = vacPin.ident === ident ? null : ident;
}

/** Let go, without asking which. Called when the selection could not honour
 *  the pin at all, so panning away or zooming out past legibility ends it. */
export function clearVacPin(): void {
	vacPin.ident = null;
}
