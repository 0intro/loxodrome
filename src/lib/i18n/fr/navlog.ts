/* Miroir français de ../en/navlog.ts. "Vent de face" / "vent arrière" suit
 * le vocabulaire aéronautique français usuel; les abréviations OACI Doc 8400
 * (Alt, MSA, MC, MH, ETE, ETO, ATO, TAS, AMSL, ISA, W/V) et les unités (ft,
 * NM, kt) restent invariantes, les infobulles les épellent (glossaire).
 * Le cycle de modèle est le "réseau" (vocabulaire Météo-France, comme dans
 * l'onglet Météo) et les époques "14:05Z 4 juil." gardent la forme compacte
 * Zulu; leg = segment, waypoint = point (compact). */

import type { Messages } from '../en';
import { plural } from './plural';

export const navlog = {
	addWaypoints: 'Ajoutez au moins deux points pour construire un log de navigation.',
	airportFreqs: 'Fréquences d’aérodrome',
	airportFreqsTip:
		'Liste les fréquences COM publiées de chaque aérodrome de la route (TWR, GND, ATIS, A/A, …) sous sa bannière de report dans le log de navigation, avec tout NOTAM de changement de fréquence actif appliqué.',
	airspace: 'Espace aérien',
	airspacesUnavailable: 'Espaces aériens indisponibles (échec du chargement du jeu de données).',
	atoTip: 'Heure réelle de passage au point',
	classATip: 'Plancher de la classe A supérieure (rester en dessous en VFR)',
	columnsAria: 'Contenu du log de navigation',
	columnsTip:
		'Contenu optionnel du log de navigation\u202f: fréquences d’aérodrome / en route, radiales VOR',
	cumTip: 'Distance cumulée depuis le départ (NM)',
	enrouteFreqs: 'Fréquences en route',
	enrouteFreqsTip:
		'Liste les fréquences de contrôle et FIS de chaque segment (classe A IFR, B, C, D, classe E IFR, SIV, RMZ) sous son point dans le log de navigation, sous les fréquences d’aérodrome, et les enregistre dans le fichier de route.',
	enter: 'Entrée',
	etoLiveTip: 'Estimée à la vitesse sol actuelle, recalée à chaque point passé',
	etoTip: 'Heure estimée de passage au point',
	forecastFallback: 'prévision',
	freqEditAria: 'Modifier les fréquences du point',
	freqEditTip:
		'Modifier les fréquences (une ligne vide trace le séparateur pointillé, vider le champ rétablit la liste automatique)',
	freqClosedTip: (id: string) => `Retirée par NOTAM ${id}`,
	freqManualTip: 'Fréquences forcées manuellement pour ce point',
	freqResetAria: 'Rétablir les fréquences automatiques',
	freqResetTip: 'Rétablir les fréquences automatiques',
	freqTextAria: 'Fréquences du point',
	frequency: 'Fréquence',
	hdrAltTip:
		'Altitude de croisière planifiée (ft), en niveau de vol au-dessus de l’altitude de transition',
	hdrDistTip: 'Distance du segment (NM)',
	hdrEteTip: 'Durée estimée en route, air calme (ce segment)',
	hdrEteWTip: 'Durée estimée en route, corrigée du vent (ce segment)',
	hdrMcTip: 'Route magnétique',
	hdrMhTip: 'Cap magnétique',
	hdrMsaTip: 'Altitude minimale de sécurité (ft)',
	hdrRemTip: 'Distance restante jusqu’à destination (NM)',
	leave: 'Sortie',
	levelWarnTip: 'Niveau non conforme à la règle semi-circulaire pour cette route magnétique',
	loadingAirspaces: 'Chargement des espaces aériens…',
	noAirspaceCrossed:
		'Aucune traversée d’espace contrôlé, de SIV ou de zone aux altitudes planifiées.',
	notes: 'Notes',
	printAllAria: 'Imprimer toutes les routes (planchette A5)',
	printAllTip: 'Imprimer toutes les routes, deux fiches A5 par A4 paysage',
	printRouteAria: 'Imprimer cette route',
	printRouteTip: 'Imprimer cette route (A4 portrait)',
	radialFoot:
		'Radiales magnétiques (WMM)\u202f; les valeurs publiées peuvent différer d’environ un degré (époque de calage de la station).',
	radialTip: 'Affichage VOR et radiale magnétique',
	scheduleEteTip:
		'Durée estimée en route, corrigée du vent là où un vent se résout (air calme sinon)',
	scheduleHeading: 'Séquence radio et espaces aériens',
	showOnMap: (label: string) => `Afficher ${label} sur la carte`,
	total: 'Total',
	totalEteTip: 'Durée totale estimée en route',
	vorRadials: 'Radiales VOR',
	vorRadialsTip:
		'Affiche la bannière de radiale VOR dans les notes de chaque point\u202f: la station à afficher (indicatif et fréquence) et la radiale magnétique QDR ou QDM du segment qui le quitte.',
	waypoint: 'Point',
	waypointNotesAria: 'Notes du point',
	windAvgHead: (kt: number) => `en moyenne ${kt} kt de face`,
	windAvgTail: (kt: number) => `en moyenne ${kt} kt arrière`,
	windDelta: (signedMin: string) => `vent ${signedMin} min`,
	windSummaryBeyond: (p: { legs: number; reach: string }) =>
		`Prévision jusqu’à ${p.reach}, ${p.legs} ${plural(p.legs, 'segment', 'segments')} au-delà`,
	windSummaryBeyondNoReach: (legs: number) =>
		`${legs} ${plural(legs, 'segment', 'segments')} au-delà de l’horizon de prévision`,
	windSummaryForecast: (p: { model: string; run: string | null; from: string; to: string | null }) =>
		`Vents ${p.model}${p.run ? `, réseau ${p.run}` : ''}, valides ${p.from}${p.to ? ` à ${p.to}` : ''}`,
	windSummaryManual: (wv: string) => `Vent ${wv} manuel`,
	windSummaryOutOfRange: (days: number) =>
		`Départ au-delà de la portée des prévisions (${days} jours)`,
	windSummaryOverridden: (n: number) => `, ${n} ${plural(n, 'segment forcé', 'segments forcés')}`,
	windSummaryPerLeg: 'Vents manuels par segment',
	windSummaryQuota: 'Quota de prévisions épuisé',
	windSummaryRateLimited: 'Limite de débit atteinte, nouvel essai en cours',
	windSummaryTip: 'Source du vent utilisée pour les colonnes MH et ETE/W',
	windSummaryUnavailable: 'Prévision indisponible',
	windTip: (wv: string) => `Vent ${wv}`,
	windTipAboveTop: ' (au-dessus du plafond de la prévision, vent du niveau le plus haut affiché)',
	windTipBelowGround: ' (vent à 10 m, niveau sous le relief)',
	windTipForecast: (model: string) => `Prévision ${model}`,
	windTipLevel: (ft: number) => `${ft} ft AMSL`,
	windTipLevelTemp: (p: { tempC: number; isaDev: string }) => `, ${p.tempC} °C (ISA ${p.isaDev})`,
	windTipManual: 'Vent manuel global',
	windTipManualBeyondHorizon: 'Vent manuel global, l’horizon de prévision n’atteint pas ce segment',
	windTipManualUnavailable: 'Vent manuel global, prévision indisponible',
	windTipOverride: 'Forçage manuel pour ce segment',
	windTipRunValid: (p: { run: string; valid: string }) => `Réseau ${p.run}, valide ${p.valid}`,
	windTipShear: (kt: number) => `Cisaillement vertical ${kt} kt par 1000 ft`,
	windTipTas: (kt: number) => `TAS ${kt} kt, corrigée de la température`,
	windTipValid: (valid: string) => `Valide ${valid}`,
	wmmExpiredTip:
		'Validité du WMM2025 échue le 31 décembre 2029\u202f; les valeurs magnétiques utilisent la déclinaison figée à 2030.0.',
} satisfies Messages['navlog'];
