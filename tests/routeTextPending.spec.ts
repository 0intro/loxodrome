/* Text typed in the route field before the airports load is parked with the
 * history serial it was typed at, and the notice under the field says the
 * datasets are loading. When the history has moved by the time they land
 * (an undo, an edit on the map or the list), the parked text is dropped,
 * and its notice went on standing: a red "Datasets still loading" under the
 * field after the data had loaded (or a stale "Could not find" from the
 * navaids' park) until the next edit. The field's own effect runs here over
 * stand-ins for the state it reads (tests/helpers/componentCode.ts). */

import { describe, expect, it, vi } from 'vitest';
import { componentCode, run } from './helpers/componentCode';

const field = componentCode('src/lib/components/tabs/route/RouteTextField.svelte');

interface Parked {
	pendingText: string | null;
	pendingSerial: number;
	buildErr: 'loading' | string[] | null;
}

/** The datasets land with `parked` waiting and the history at `serial`. */
function land(parked: Parked, serial: number): { after: Parked; applyRouteText: ReturnType<typeof vi.fn> } {
	const applyRouteText = vi.fn();
	const effect = run<() => Parked>(
		{
			dataState: { airportsLoaded: true, navaidsLoaded: true },
			routeHistory: { serial },
			untrack: (fn: () => unknown) => fn(),
			applyRouteText,
			parked,
		},
		`let pendingText = parked.pendingText;
		let pendingSerial = parked.pendingSerial;
		let buildErr = parked.buildErr;
		const effect = ${field.callback('$effect', 'pendingSerial')};
		return () => {
			effect();
			return { pendingText, pendingSerial, buildErr };
		};`,
	);
	return { after: effect(), applyRouteText };
}

describe('text parked while the datasets load', () => {
	it('is replayed once they land, the history where it was', () => {
		const { after, applyRouteText } = land({ pendingText: 'LFPN LFPT', pendingSerial: 4, buildErr: 'loading' }, 4);
		expect(applyRouteText).toHaveBeenCalledWith('LFPN LFPT');
		expect(after.pendingText).toBeNull();
	});

	it('is dropped with the notice it raised once the history has moved', () => {
		const notices: Parked['buildErr'][] = ['loading', ['PMN']];
		for (const buildErr of notices) {
			const { after, applyRouteText } = land({ pendingText: 'LFPN PMN', pendingSerial: 4, buildErr }, 6);
			expect(applyRouteText).not.toHaveBeenCalled();
			expect(after).toEqual({ pendingText: null, pendingSerial: 4, buildErr: null });
		}
	});
});
