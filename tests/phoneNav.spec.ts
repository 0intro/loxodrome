/* Pins the phone's page state (state/ui.svelte.ts): the desktop tab to page
 * mapping every select* entry point takes on a phone, the bar's toggle, the
 * never-toggling showTab a file import relies on, and revealMap. */

import { afterEach, describe, expect, it } from 'vitest';
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
		expect(pageOf('navigation')).toEqual({ page: 'flight' });
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
