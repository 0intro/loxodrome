/* Miroir français de ../en/search.ts. "Indicateur OACI" est l'indicateur
 * d'emplacement (Doc 7910); IATA reste invariant; "NOTAM" est invariable
 * (usage SIA). */

import type { Messages } from '../en';
import { plural } from './plural';

export const search = {
	hint: 'Recherchez un aérodrome par indicateur OACI, code IATA, nom ou localité. Les plus proches d’abord.',
	/* La section Proches de la page Aérodromes (nav/nearest.ts)\u202f: la liste
	   de déroutement lue depuis la position. */
	nearest: 'Aérodromes les plus proches',
	nearestHint: (nm: number) =>
		`Les aérodromes à moins de ${nm} NM de l’aéronef, du plus proche au plus lointain, avec la fréquence à appeler et la piste la plus longue.`,
	nearestNoPose: 'Pas encore de position\u202f: démarrez un vol, ou relisez une trace, pour lister les aérodromes autour de l’aéronef.',
	nearestNone: (nm: number) => `Aucun aérodrome à moins de ${nm} NM.`,
	/* Le groupe de l’onglet Aérodromes pour une localité que nomme la
	   recherche, la localité en lien après lui. */
	nearestTown: 'Aérodromes les plus proches\u202f:',
	loadError: (err: string) => `Impossible de charger les aérodromes\u202f: ${err}`,
	loading: 'Chargement des aérodromes…',
	noMatches: 'Aucun résultat.',
	otherMatches: 'Autres résultats',
	palette: {
		actions: 'Actions',
		airports: 'Aérodromes',
		airspaces: 'Espaces aériens',
		chartHidden: 'Carte masquée',
		chartShown: 'Carte affichée',
		countries: 'Pays',
		countryAerodromes: (count: string, n: number) => `${count} ${plural(n, 'aérodrome', 'aérodromes')}`,
		hint: 'Recherchez un aérodrome, une aide de radionavigation, un espace aérien, une localité, une position, un pays, un NOTAM ou une action.',
		loading: 'Chargement des données aéronautiques…',
		moreAirports: (n: number) => `${n} de plus dans l’onglet Aérodromes…`,
		navaids: 'Aides de radionavigation et points',
		noMatches: 'Aucun résultat.',
		notams: 'NOTAM',
		placeholder: 'Indicateur OACI, balise, localité, espace aérien, coordonnées ou NOTAM…',
		position: 'Position',
		scopeAll: 'Recherche complète\u202f: tous les pays dotés de données nationales.',
		scopeNone: 'Aérodromes seulement, d’après la liste mondiale.',
		scopeSome: (names: string) => `Recherche complète\u202f: ${names}. Ailleurs, aérodromes seulement.`,
		searchAll: 'Chercher dans tous les pays',
		searchAllLoading: 'Chargement de tous les pays…',
		searchAllTip: 'Charge les balises, les aérodromes et les localités de tous les pays, environ trois mégaoctets',
		surfaceOnScreen: 'À l’écran',
		towns: 'Localités',
		title: 'Recherche',
	},
	fuelFilter: 'Carburant',
	fuelFilterTip:
		'N’afficher que les aérodromes publiant ce carburant. France seulement, seule AIP qui l’indique.',
	placeholder: 'Indicateur OACI, IATA, nom ou localité…',
	showingMatches: (p: { shown: number; total: number }) =>
		`${p.shown} ${plural(p.shown, 'résultat affiché', 'résultats affichés')} sur ${p.total}.`,
	title: 'Recherche d’aérodromes',
} satisfies Messages['search'];
