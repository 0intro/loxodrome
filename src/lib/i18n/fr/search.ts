/* Miroir français de ../en/search.ts. "Indicateur OACI" est l'indicateur
 * d'emplacement (Doc 7910); IATA reste invariant; "NOTAM" est invariable
 * (usage SIA). */

import type { Messages } from '../en';
import { plural } from './plural';

export const search = {
	hint: 'Recherchez un aérodrome par indicateur OACI, code IATA, nom ou ville.',
	loadError: (err: string) => `Impossible de charger les aérodromes\u202f: ${err}`,
	loading: 'Chargement des aérodromes…',
	noMatches: 'Aucun résultat.',
	palette: {
		actions: 'Actions',
		airports: 'Aérodromes',
		chartHidden: 'Carte masquée',
		chartShown: 'Carte affichée',
		hint: 'Recherchez un aérodrome, une aide de radionavigation, un NOTAM ou une action.',
		loading: 'Chargement des données aéronautiques…',
		moreAirports: (n: number) => `${n} de plus dans l’onglet Aérodromes…`,
		navaids: 'Aides de radionavigation et points',
		noMatches: 'Aucun résultat.',
		notams: 'NOTAM',
		placeholder: 'Indicateur OACI, balise, NOTAM ou action…',
		surfaceOnScreen: 'À l’écran',
		title: 'Recherche',
	},
	placeholder: 'Indicateur OACI, IATA, nom ou ville…',
	showingMatches: (p: { shown: number; total: number }) =>
		`${p.shown} ${plural(p.shown, 'résultat affiché', 'résultats affichés')} sur ${p.total}.`,
	title: 'Recherche d’aérodromes',
} satisfies Messages['search'];
