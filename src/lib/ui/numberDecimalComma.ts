/* A typed or pasted decimal comma in a number box becomes a dot: one
 * document-level listener for every box, current and future (the wheel guard's
 * and the step anchor's pattern).
 *
 * The app's aviation values keep the point-decimal notation in both languages
 * (docs/i18n.md), but a number box parses a comma by engine and locale, and the
 * worst case was silent: Chromium under an English locale DROPS a typed comma,
 * so "2,25" became 225, a mass, an arm or a fuel figure a hundred times too
 * large with no sign of it. Firefox rejects the comma in a box marked English
 * (the value empties) and takes it in a French one; Chromium under a French
 * locale takes it. Turned into a dot before the box sees it, a comma reads the
 * same everywhere, and a French pilot types as they write.
 *
 * The dot goes in through the editing command, the one insertion a number box
 * offers (it has no selection API), which fires the box's own `input` as typing
 * does. A pasted figure holding a comma and no dot is read the French way, its
 * spaces dropped where they group thousands (\s takes the narrow and the
 * no-break ones too), and a spreadsheet cell's trailing line break with them;
 * one holding both marks is left to the box. Spaces elsewhere make no figure
 * ("0,205 500"), so that paste takes nothing, rather than the 0.205500 their
 * removal would read. A block of cells (a tab or a line break inside) goes to
 * a table, which spreads it over its boxes ($lib/ui/gridPaste); any other box
 * takes none of it, as Chromium would run its figures together ("2,25\n3,5"
 * read 22535). Capture phase, so nothing below can hide the event;
 * idempotent, so an HMR re-run cannot stack listeners. */

let installed = false;

function isNumberBox(target: EventTarget | null): target is HTMLInputElement {
	return target instanceof HTMLInputElement && target.type === 'number';
}

/** A figure whose spaces group the thousands of its whole part (1 156,66). */
const GROUPED_COMMA = /^-?\d{1,3}(\s\d{3})+,\d*$/;

/** A pasted figure in the point-decimal notation, or null to leave it alone:
 *  no comma, both marks, or spaces that group nothing. */
export function pastedDecimal(text: string): string | null {
	const s = text.trim();
	if (!s.includes(',') || s.includes('.') || (/\s/.test(s) && !GROUPED_COMMA.test(s))) {
		return null;
	}
	return s.replace(/\s/g, '').replace(/,/g, '.');
}

/** Does a box spread a pasted block over its table ($lib/ui/gridPaste)? */
function inGrid(box: HTMLInputElement): boolean {
	return box.dataset.row !== undefined && box.dataset.col !== undefined;
}

function insert(text: string): void {
	// Deprecated, yet the only insertion a number box offers, and it fires the
	// box's own input event.
	document.execCommand('insertText', false, text);
}

export function installNumberDecimalComma(): void {
	if (installed || typeof document === 'undefined') {
		return;
	}
	installed = true;
	document.addEventListener(
		'beforeinput',
		(e) => {
			if (!isNumberBox(e.target) || e.isComposing || e.inputType !== 'insertText' || e.data === null || !e.data.includes(',')) {
				return;
			}
			e.preventDefault();
			insert(e.data.replace(/,/g, '.'));
		},
		true,
	);
	document.addEventListener(
		'paste',
		(e) => {
			if (!isNumberBox(e.target)) {
				return;
			}
			// One cell copied from a spreadsheet ends with a line break.
			const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/[\r\n]+$/, '');
			if (/[\t\r\n]/.test(text)) {
				if (!inGrid(e.target)) {
					e.preventDefault();
				}
				return;
			}
			if (!text.includes(',') || text.includes('.')) {
				return;
			}
			e.preventDefault();
			const figure = pastedDecimal(text);
			if (figure !== null) {
				insert(figure);
			}
		},
		true,
	);
}
