/* Pins the phone's page state (state/ui.svelte.ts): the desktop tab to page
 * mapping every select* entry point takes on a phone, the bar's toggle, the
 * never-toggling showTab a file import relies on, and revealMap. Also what
 * the phone's one fit button fits (state/phoneNav.svelte.ts fitMap), which
 * its label reads (tests/phoneChrome.spec.ts). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitMap, fitTargetsRoute } from '$lib/state/phoneNav.svelte';
import { mapState } from '$lib/state/map.svelte';
import { addWaypoint, clearAllRoutes } from '$lib/state/route.svelte';
import {
	closePage,
	openPage,
	pageOf,
	revealMap,
	selectTab,
	showTab,
	ui,
	type SidebarTab,
} from '$lib/state/ui.svelte';

const fits = vi.hoisted(() => ({ route: 0, notams: 0 }));
vi.mock('$lib/map/navLayer', () => ({ rearmFollow: () => {}, recenterNav: () => {} }));
vi.mock('$lib/map/notamLayer', () => ({
	fitToNotams: () => {
		fits.notams += 1;
	},
}));
vi.mock('$lib/components/tabs/route/fitRoute', () => ({
	fitRoute: () => {
		fits.route += 1;
	},
}));

afterEach(() => {
	ui.isMobile = false;
	ui.page = null;
	ui.pageSection = {};
	ui.sidebarCollapsed = false;
	ui.activeTab = 'route';
});

describe('pageOf', () => {
	it('maps every desktop tab onto a page, the content tabs onto a section', () => {
		expect(pageOf('notams')).toEqual({ page: 'brief', section: 'notams' });
		expect(pageOf('weather')).toEqual({ page: 'brief', section: 'weather' });
		expect(pageOf('route')).toEqual({ page: 'plan', section: 'route' });
		expect(pageOf('aircraft')).toEqual({ page: 'plan', section: 'aircraft' });
		expect(pageOf('airports')).toEqual({ page: 'airports', section: 'search' });
		// Named like every other: without one the page comes up on whichever
		// section was last used. It is raised for a trace file, so the Trace
		// section, the one that shows the trace (the Flight section hid it).
		expect(pageOf('navigation')).toEqual({ page: 'flight', section: 'trace' });
		expect(pageOf('layers')).toEqual({ page: 'layers' });
		expect(pageOf('settings')).toEqual({ page: 'settings' });
	});
});

describe('the page state on a phone', () => {
	it('selectTab opens the page on the section, and toggles it away', () => {
		ui.isMobile = true;
		selectTab('notams');
		expect(ui.page).toBe('brief');
		expect(ui.pageSection.brief).toBe('notams');
		selectTab('weather');
		expect(ui.page).toBe('brief');
		expect(ui.pageSection.brief).toBe('weather');
		selectTab('weather');
		expect(ui.page).toBeNull();
		// The section is remembered for the next open.
		expect(ui.pageSection.brief).toBe('weather');
	});

	it('showTab never toggles: a second import lands on the page it is already on', () => {
		ui.isMobile = true;
		showTab('route');
		showTab('route');
		expect(ui.page).toBe('plan');
		expect(ui.pageSection.plan).toBe('route');
	});

	it('openPage without a section keeps the one the page was left on', () => {
		ui.isMobile = true;
		openPage('plan', 'aircraft');
		closePage();
		openPage('plan');
		expect(ui.pageSection.plan).toBe('aircraft');
	});

	it('revealMap closes the page on a phone and touches nothing on the desktop', () => {
		ui.isMobile = true;
		openPage('airports');
		revealMap();
		expect(ui.page).toBeNull();
		ui.isMobile = false;
		ui.sidebarCollapsed = false;
		revealMap();
		expect(ui.sidebarCollapsed).toBe(false);
	});

	it('leaves the desktop sidebar alone', () => {
		const tabs: SidebarTab[] = ['notams', 'route'];
		for (const tab of tabs) {
			selectTab(tab);
			expect(ui.activeTab).toBe(tab);
			expect(ui.sidebarCollapsed).toBe(false);
		}
		expect(ui.page).toBeNull();
	});
});

describe("the phone's fit button", () => {
	beforeEach(() => {
		clearAllRoutes();
		mapState.map = {} as never;
		fits.route = 0;
		fits.notams = 0;
	});

	afterEach(() => {
		mapState.map = null;
		clearAllRoutes();
	});

	it('fits the route from its second waypoint, the NOTAMs before it', () => {
		addWaypoint(48, 2);
		expect(fitTargetsRoute()).toBe(false);
		fitMap();
		expect(fits).toEqual({ route: 0, notams: 1 });
		addWaypoint(48, 2.6);
		expect(fitTargetsRoute()).toBe(true);
		fitMap();
		expect(fits).toEqual({ route: 1, notams: 1 });
	});
});
