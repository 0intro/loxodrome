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
	/* Les destinations de la barre du téléphone et les sections des pages
	   (PhoneNavBar / PhonePages). Cinq libellés sur 392 px: un mot court. */
	map: 'Carte',
	brief: 'Briefing',
	plan: 'Plan',
	flight: 'Vol',
	nearest: 'Proches',
	search: 'Recherche',
	supaip: 'SUP AIP',
	preparation: 'Préparation',
	log: 'Log',
	profile: 'Profil',
	flightSection: 'Vol',
	alerts: 'Alertes',
	replay: 'Relecture',
} satisfies Messages['tabs'];
