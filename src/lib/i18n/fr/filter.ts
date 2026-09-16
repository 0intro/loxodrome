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
	noNotams: 'Les filtres propres aux NOTAM apparaissent une fois les NOTAM analysés.',
	open: 'Filtres',
	outsidePeriod: (n: number) => `Hors période (${n})`,
	outsidePeriodNote:
		'Conservés dans la liste et consultables\u202f; la carte ne trace que la période.',
	scopeNote:
		'Ces filtres ne concernent que le briefing NOTAM. La période et les niveaux, dans la barre d’outils, valent pour toute la carte.',
	setByRoute: 'Définies par votre route',
	showAll: 'Tout afficher',
	showing: (p: { shown: number; total: number }) =>
		`${p.shown} NOTAM ${plural(p.shown, 'affiché', 'affichés')} sur ${p.total}.`,
} satisfies Messages['filter'];
