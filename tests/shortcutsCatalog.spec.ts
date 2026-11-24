/* The "?" map's row for Enter on a focused grip. It said Enter cycled the
 * mobile sheet through peek, half and full, a three-detent sheet the phone
 * pane replaced. The pane's handle switches between two detents, half and
 * full height upright and the two PHONE_LANDSCAPE_FRACS widths in
 * landscape (SurfaceShell cycleDetent), and the desktop dock grip answers
 * only the arrows and Home. */
import { describe, expect, it } from 'vitest';
import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';
import { PHONE_LANDSCAPE_FRACS } from '$lib/surfaces';

/** The text of the grip group's row for `key`, the group found by its
 *  English title and read at the same place in either catalog. */
function gripRow(groups: typeof en.shortcuts.groups, key: string): string {
	const at = en.shortcuts.groups.findIndex((g) => g.title.startsWith('Panel and dock edges'));
	expect(at).toBeGreaterThanOrEqual(0);
	const row = groups[at].rows.find((r) => r.keys.includes(key));
	expect(row, key).toBeDefined();
	return row!.text;
}

describe("the grip's Enter row", () => {
	it('names the two detents of the phone pane, in both languages', () => {
		expect(PHONE_LANDSCAPE_FRACS).toHaveLength(2);
		const e = gripRow(en.shortcuts.groups, 'Enter');
		expect(e).toContain('half and full height');
		expect(e).toContain('narrow and wide');
		expect(e).not.toMatch(/peek/i);
		const f = gripRow(fr.shortcuts.groups, 'Entrée');
		expect(f).toContain('demi-hauteur et pleine hauteur');
		expect(f).toContain('étroit et large');
		expect(f).not.toMatch(/aperçu/i);
	});
});
