/* Miroir français de ../en/input.ts. "NOTAM" est invariable au pluriel;
 * SOFIA-Briefing et autorouter sont des noms de produits, invariants. */

import type { Messages } from '../en';
import { plural } from './plural';

export const input = {
	backToList: 'Retour à la liste des NOTAM',
	autorouterLink: 'autorouter ↗',
	autorouterLinkTip: 'Ouvrir autorouter.aero dans un nouvel onglet',
	clear: 'Effacer',
	covEmpty: 'Aucun aérodrome ni FIR en vue\u202f; déplacez la carte vers une région peuplée.',
	covFirOnly:
		'Couverture FIR seule\u202f; pas de CTR, SUA ni polygones de classe pour cette région.',
	covInView: (p: { a: number; f: number }) =>
		`${p.a} ${plural(p.a, 'aérodrome', 'aérodromes')} + ${p.f} FIR en vue.`,
	covLoading: 'Chargement des données…',
	covOverCap: (max: number) =>
		`Seuls les ${max} aérodromes les plus proches seront interrogés (chacun peut renvoyer plusieurs NOTAM\u202f; les FIR sont toujours incluses).`,
	covSkipped: (n: number) =>
		`${n} ${plural(n, 'aérodrome ignoré', 'aérodromes ignorés')} (sans indicateur OACI).`,
	covViewportTooLarge: (max: number) =>
		`Vue trop étendue\u202f; zoomez à ${max}° ou moins de côté.`,
	displayOnMap: 'Afficher sur la carte',
	fetchTipReady: 'Récupérer les NOTAM des aérodromes et FIR actuellement en vue',
	fetched: (p: { n: number; time: string }) =>
		`${p.n} NOTAM ${plural(p.n, 'récupéré', 'récupérés')} à ${p.time}.`,
	fetching: 'Récupération…',
	periodNotCovered: (p: { until: string }) => `Ce briefing ne couvre que jusqu’à ${p.until}.`,
	periodNotCoveredTip:
		'Un briefing de route couvre environ 24 heures à compter du début de la période demandée, alors que la période consultée va au-delà. Les NOTAM prenant effet après cet instant n’ont jamais été récupérés. Relancez la récupération avec la période réglée sur la partie ultérieure pour la briefer.',
	launchFetch: 'Récupérer cette vue',
	launchFetchDesc: 'Demander à autorouter les NOTAM des aérodromes et FIR en vue.',
	launchPaste: 'Coller ou ouvrir un fichier',
	launchRoute: 'NOTAM de la route',
	launchRouteDesc:
		'Tracez une route dans l’onglet Route et récupérez les NOTAM le long de son couloir.',
	load: 'Charger des NOTAM',
	paste: 'Coller',
	pastePlaceholder: 'Collez des NOTAM ici, directement depuis SOFIA-Briefing ou autorouter.',
	plotted: (n: number) => `${n} NOTAM ${plural(n, 'affiché', 'affichés')}.`,
	sofiaLink: 'SOFIA-Briefing ↗',
	sofiaLinkTip:
		'Ouvrir SOFIA-Briefing (SIA) dans un nouvel onglet\u202f; copiez un briefing, puis Coller ici',
	upload: 'Importer',
} satisfies Messages['input'];
