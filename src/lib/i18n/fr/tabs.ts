/* Miroir français de ../en/tabs.ts. "NOTAM" est invariable en français
 * (usage officiel SIA); "Aérodromes" est le libellé le plus large du rail
 * (--rail-w est dimensionné pour lui). */

import type { Messages } from '../en';

export const tabs = {
	aircraft: 'Aéronefs',
	airports: 'Aérodromes',
	settings: 'Réglages',
	layers: 'Couches',
	navigation: 'Navigation',
	notams: 'NOTAM',
	route: 'Route',
	weather: 'Météo',
} satisfies Messages['tabs'];
