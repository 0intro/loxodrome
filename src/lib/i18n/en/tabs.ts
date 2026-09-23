/* Sidebar tab-rail labels (Sidebar.svelte renders them via t.tabs, keyed by
 * tab id). The rail is --rail-w wide; keep labels short in both languages. */

export const tabs = {
	aircraft: 'Aircraft',
	airports: 'Airports',
	settings: 'Settings',
	layers: 'Layers',
	navigation: 'Navigation',
	notams: 'NOTAMs',
	route: 'Route',
	weather: 'Weather',
	/* The phone's bar destinations and page sections (PhoneNavBar /
	   PhonePages; docs/workspace-surfaces.md "Phones"). The bar is five
	   labels across a 392 px screen, so each is one short word. */
	map: 'Map',
	brief: 'Brief',
	plan: 'Plan',
	flight: 'Flight',
	nearest: 'Nearest',
	search: 'Search',
	supaip: 'SUP AIP',
	preparation: 'Preparation',
	log: 'Log',
	profile: 'Profile',
	flightSection: 'Flight',
	alerts: 'Alerts',
	replay: 'Replay',
};
