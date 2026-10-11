/* Use-action that mirrors a form control's live value into the content
 * attribute the browser paints from when it builds the static clone used for
 * printing. Svelte writes the *property* (value / checked / selectedIndex);
 * the print clone is a cloneNode-style copy that carries only attributes and
 * renders each control from its *content attribute* (value / checked /
 * <option selected>), which Svelte never sets, so a programmatically-filled
 * field prints blank in Gecko (Firefox, the user's browser). Chromium paints
 * the live property and is unaffected, but the reflection is inert there too.
 *
 * On screen the reflection cannot disturb the field: assigning the property
 * sets the control's dirty value/checkedness flag, after which the content
 * attribute is only the default and no longer drives rendering. The <select>
 * marks the currently-selected option, so even if setting the attribute makes
 * the element "ask for a reset" it re-selects that same option, leaving the
 * on-screen choice unchanged.
 *
 * Pass the same expression already bound to value / checked / the select
 * value. The attribute is derived from the parameter, not read back from the
 * node, so it stays correct regardless of when Svelte applies the property.
 *
 * Usage: <input type="number" value={n} use:printValue={n} ... />
 */

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** What a bound value / checked expression can resolve to. */
type PrintableValue = string | number | boolean | null | undefined;

export function printValue(
	node: FormControl,
	value: PrintableValue,
): { update: (v: PrintableValue) => void } {
	function reflect(v: PrintableValue): void {
		if (node instanceof HTMLSelectElement) {
			const want = v == null ? '' : String(v);
			for (const opt of node.options) {
				opt.toggleAttribute('selected', opt.value === want);
			}
		} else if (node instanceof HTMLInputElement && (node.type === 'checkbox' || node.type === 'radio')) {
			node.toggleAttribute('checked', Boolean(v));
		} else if (node instanceof HTMLTextAreaElement) {
			node.defaultValue = v == null ? '' : String(v);
		} else {
			node.setAttribute('value', v == null ? '' : String(v));
		}
	}
	reflect(value);
	return { update: reflect };
}
