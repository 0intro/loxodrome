/* The Route tab's two width boxes each draw a band on the map while one
 * holds the focus (the NOTAM-fetch corridor, the minimum-altitude corridor),
 * taken off again on blur. A tab torn down under a focused box gets no blur
 * in Firefox (a dropped trace file switches the tab, Firefox fires nothing
 * on a removed element), so the tab takes both previews off as it goes. Its
 * teardown runs here over a stand-in for the route settings
 * (tests/helpers/componentCode.ts). */

import { describe, expect, it } from 'vitest';
import { componentCode, run } from './helpers/componentCode';

const tab = componentCode('src/lib/components/tabs/RouteTab.svelte');

describe('the Route tab torn down', () => {
	it('takes both corridor previews off the map', () => {
		const routeSettings = { corridorPreview: true, minAltCorridorPreview: true };
		const teardown = run<() => void>({ routeSettings }, `return ${tab.callback('onDestroy', 'corridorPreview')};`);
		teardown();
		expect(routeSettings).toEqual({ corridorPreview: false, minAltCorridorPreview: false });
	});
});
