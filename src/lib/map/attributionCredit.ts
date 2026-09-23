import type L from 'leaflet';

/* The map corner's credit: said once, then folded away.
 *
 * What shapes this is the OpenStreetMap Foundation's own attribution
 * guideline (adopted 2021-06-25), the strictest of the licences the corner
 * carries and so the one that governs the box. For a browsable map "the
 * credit should typically appear in a corner of the map"; it may then
 * fade or collapse "automatically on map interaction such as panning,
 * clicking, or zooming" or "automatically after five seconds"; and once
 * collapsed "the user must still be able to find the licence information if
 * they look for it, for example from an '(i)' button in the corner of the map
 * or an 'About' option in a menu". The guideline settles the repeat case in
 * the same breath: attribution presented at startup "does not need to be
 * presented to the user every time the user looks at or interacts with the
 * application".
 *
 * The About modal IS that standing place, in both apps and off a menu row:
 * its Base maps section lists the five tile providers with their licences,
 * and its chart-layer section is generated from the registry, so a layer
 * credits itself there the moment it publishes. The corner therefore owes the
 * pilot one reading and no more, which is what gets it out of a cockpit
 * display for the rest of the flight.
 *
 * What re-arms it is the credit's own TEXT, not a list of call sites. Any
 * layer may carry an attribution and Leaflet rewrites this control's content
 * when one attaches or leaves, so watching the element is what guarantees
 * that whatever the corner says, it says for its five seconds first; a call
 * list would silently miss the next layer that carries one, and an unsaid
 * credit is the single failure this module exists to prevent. Comparing the
 * text is the other half: Leaflet rewrites on every add and remove, identical
 * string or not, so a chart re-stack that changes nothing must not flash a
 * credit that was already read.
 */

/** The guideline's own figure, and the reason it is not a taste knob. */
export const CREDIT_HOLD_MS = 5000;

/** Set on Leaflet's own control; app.css fades the box out under it. */
const FOLDED = 'credit-folded';

/**
 * Show the attribution control whenever its credit changes, fold it five
 * seconds later or at the first pan / zoom / click, whichever comes first.
 * Returns the teardown.
 */
export function armAttributionCredit(map: L.Map): () => void {
	const el = map.attributionControl?.getContainer();
	if (!el) {
		return () => undefined;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let said = '';

	const fold = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		el.classList.add(FOLDED);
	};

	const show = (): void => {
		said = el.textContent ?? '';
		el.classList.remove(FOLDED);
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		timer = setTimeout(fold, CREDIT_HOLD_MS);
	};

	const watch = new MutationObserver(() => {
		if ((el.textContent ?? '') !== said) {
			show();
		}
	});
	watch.observe(el, { childList: true, characterData: true, subtree: true });

	// i18n-ignore: Leaflet event names, not display text
	const gestures = 'dragstart zoomstart click';
	map.on(gestures, fold);
	show();

	return () => {
		watch.disconnect();
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		map.off(gestures, fold);
	};
}
