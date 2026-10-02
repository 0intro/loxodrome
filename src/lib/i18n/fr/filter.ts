/* Miroir français de ../en/filter.ts. Du / Au suivent la convention SIA
 * (DU:/AU:); les codes VFR / IFR / IV, F/G, ASFC et la ligne Q restent
 * invariants. */

import type { Messages } from '../en';
import { plural } from './plural';

export const filter = {
	chipClearAria: (name: string) => `Effacer le filtre\u202f: ${name}`,
	chipEditTip: 'Régler ce filtre',
	flightRulesLegend: 'Règles de vol',
	flightRulesNote:
		'Le VFR masque les NOTAM uniquement IFR, l’IFR masque les NOTAM uniquement VFR. S’appuie sur le qualificatif trafic de la ligne Q. Les NOTAM concernant les deux régimes (IV) et les NOTAM non classés restent toujours affichés.',
	hiddenByFilters: (n: number) =>
		`${n} NOTAM ${plural(n, 'masqué', 'masqués')} par les filtres.`,
	kindAreas: 'Zones',
	kindLegend: 'Type',
	kindPositions: 'Positions',
	kindQline: 'Positions ligne Q',
	modeAll: 'Toutes',
	modeRoute: 'Route',
	modeRouteTip: 'Suivre les règles de vol de votre route. Choisir Toutes, VFR ou IFR les fixe.',
	noNotams: 'Les filtres propres aux NOTAM apparaissent une fois les NOTAM analysés.',
	noneInPeriod: (n: number) => `Aucun NOTAM dans la période. ${n} hors période.`,
	open: 'Filtres',
	outsideFetch: (n: number) => `${n} NOTAM hors de la région récupérée.`,
	outsidePeriod: (n: number) => `Hors période (${n})`,
	outsidePeriodNote:
		'Conservés dans la liste et consultables\u202f; la carte ne trace que la période.',
	routeChipTip:
		'Uniquement les NOTAM situés dans le couloir de vos routes. Se règle ici ou dans l’onglet Route.',
	routeLegend: 'Couloir de la route',
	routeOnlyTip:
		'Ne garder que les NOTAM situés dans le couloir d’une route, à la largeur réglée dans l’onglet Route\u202f: zones, positions et rayons sont testés contre la trajectoire, les NOTAM valables pour toute une FIR gardés pour les FIR traversées. L’onglet Route porte la même option.',
	scopeNote:
		'Ces filtres ne concernent que le briefing NOTAM. La période et les niveaux, dans la barre d’outils, valent pour toute la carte.',
	setByRoute: 'Définies par votre route',
	showAll: 'Tout afficher',
	showAllTip:
		'Lève tous les filtres qui masquent des NOTAM dans la liste et sur la carte, bande de niveaux comprise. La période reste inchangée.',
	showOutside: (n: number) => plural(n, 'L’afficher', 'Les afficher'),
	showing: (p: { shown: number; total: number }) =>
		`${p.shown} NOTAM ${plural(p.shown, 'affiché', 'affichés')} sur ${p.total}.`,
} satisfies Messages['filter'];
