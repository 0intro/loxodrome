/* The document print flows' shared setup: while one of them prints a
 * portaled document of its own (the nav-log kneeboard, the flight-prep /
 * dossier pack, the weather briefing, the NOTAM bulletin), tag <html> with
 * the flow's isolation classes and install its @page: A4 landscape at a zero
 * margin, every document carrying its margins as its own padding. A print
 * dialog's Margins control overrides an @page margin (Firefox's under every
 * preset but "Default") and leaves a padding alone. The style element is
 * appended last, so the injected @page wins over any static portrait one at
 * equal cascade; exactly one such job runs at a time (the flows gate on
 * their own printing state), which is what keeps the one-@page contract of
 * docs/workspace-surfaces.md. Returns the teardown; the callers' $effects
 * return it directly so class and style leave together with the mode. */
import { type PageOrientation, pageOrientation } from './print';

const DOCUMENT_PAGE =
	// i18n-ignore: injected print CSS, not user-visible text
	'@media print { @page { size: A4 landscape; margin: 0; } }';

/** What the document flows hand `printPage`. Read off the CSS above rather
 *  than written out again, so the sheet Android is asked for cannot drift
 *  from the one these documents are laid out on (print.ts). */
export const DOCUMENT_ORIENTATION: PageOrientation = pageOrientation(DOCUMENT_PAGE);

export function installDocumentPageCss(classNames: string[]): () => void {
	const el = document.documentElement;
	for (const c of classNames) {
		el.classList.add(c);
	}
	const pageStyle = document.createElement('style');
	pageStyle.textContent = DOCUMENT_PAGE;
	document.head.appendChild(pageStyle);
	return () => {
		for (const c of classNames) {
			el.classList.remove(c);
		}
		pageStyle.remove();
	};
}
