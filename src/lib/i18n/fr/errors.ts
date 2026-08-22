/* Miroir français de ../en/errors.ts. Les diagnostics de transport (HTTP,
 * err.message amont) ne passent jamais ici (docs/i18n.md règle 10). */

import type { Messages } from '../en';

export const errors = {
	autorouterRateLimit: 'Trop de requêtes NOTAM pour le moment. Patientez quelques secondes et réessayez.',
	corridorEmpty: 'Aucun aérodrome ni FIR dans le couloir\u202f; élargissez le rayon ou prolongez la route.',
	datasetLoading: (p: { file: string; bbox: string }) =>
		`${p.file} non chargé\u202f; attendez la fin du chargement des données avant une récupération. (vue ${p.bbox})`,
	filterFloorAboveCeiling: 'Le plancher ne doit pas dépasser le plafond.',
	filterFloorCeilingNumbers: 'Le plancher et le plafond doivent être des nombres.',
	filterFromAfterTo: 'La date de début ne doit pas dépasser la date de fin.',
	filterInvalidDateTime: 'Date ou heure invalide.',
	filterPickBothDates: 'Choisissez une date de début et une date de fin.',
	filterPickFromDate: 'Choisissez une date de début.',
	filterPickToDate: 'Choisissez une date de fin.',
	mapNotReady: 'Carte pas encore prête. Patientez un instant et réessayez.',
	needTwoWaypoints: 'Ajoutez au moins deux points de cheminement pour récupérer les NOTAM d’une route.',
	openMeteoRateLimit: (min: number) =>
		`Limite de débit Open-Meteo atteinte, nouvel essai dans ${min} min.`,
	proxyBusy: (sec: number) => `Service saturé pour le moment, réessayez dans ${sec} s.`,
	proxyNotConfigured: 'Configurez d’abord l’URL du proxy.',
	sofiaCause: {
		busy: 'Le service est saturé pour le moment.',
		cancelled: 'Arrêt avant la récupération de cette route.',
		malformed: 'SOFIA-Briefing a renvoyé une réponse que cette version ne sait pas lire.',
		noAerodrome:
			'SOFIA-Briefing ne traite qu’une route entre aérodromes\u202f; celle-ci n’en comporte aucun.',
		notDeployed: 'Le proxy ne dessert pas encore les briefings SOFIA.',
		proxy: 'Le proxy a renvoyé une erreur.',
		refused: 'SOFIA-Briefing a rejeté la requête.',
		timeout: 'Le délai de la requête a été dépassé.',
		unreachable: 'Le proxy n’a pas pu être joint.',
		upstream: 'SOFIA-Briefing n’a pas répondu.',
	},
	viewportEmpty: (p: { bbox: string; airports: number; airspaces: number }) =>
		`Aucun aérodrome ni FIR dans cette vue\u202f; déplacez la carte vers une région avec des aérodromes. (vue ${p.bbox}\u202f; ${p.airports} aérodromes / ${p.airspaces} espaces chargés)`,
	viewportTooLarge: (p: { hDeg: string; wDeg: string; maxDeg: number }) =>
		`Vue trop étendue (${p.hDeg}° × ${p.wDeg}°). Maximum ${p.maxDeg}° de côté. Zoomez sur une région.`,
} satisfies Messages['errors'];
