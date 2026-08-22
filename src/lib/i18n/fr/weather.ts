/* Miroir français de ../en/weather.ts. Les codes météorologiques (VRB, FEW,
 * SCT, BKN, OVC, catégories VFR/IFR, ISA) et les noms de modèles et de
 * produits (AROME, ICON, GFS, UKMO, Open-Meteo, Météo-France, TEMSI, WINTEM,
 * SOFIA) restent invariants; le cycle d’un modèle est le "réseau"
 * (vocabulaire Météo-France). */

import type { Messages } from '../en';
import type { WeatherGroup } from '$lib/weather/metar';
import { WIND_MODELS, type WindModelId } from '$lib/weather/openMeteo';
import { plural } from './plural';

/* Libellé canonique du registre des modèles (le motif de ../en/weather.ts):
 * des noms de produits invariants, lus dans le registre pour ne jamais en
 * diverger; seul le choix automatique d'Open-Meteo ('Best match') se
 * traduit. */
const windModelLabel = (id: WindModelId): string =>
	WIND_MODELS.find((m) => m.id === id)?.label ?? id;

export const weather = {
	advisoriesBy:
		'Avis du NOAA Aviation Weather Center, monde entier. Cliquer sur une ligne ouvre son panneau de détail et cadre la zone sur la carte.',
	advisoriesWorldwide: (n: number) => `${n} avis dans le monde`,
	altitudesNote:
		'Les altitudes sont AMSL, interpolées entre les niveaux de pression. Les barbules s’estompent là où le niveau passe sous le relief (le vent à 10 m s’affiche alors) ou au-dessus du plafond de la prévision (le vent du niveau le plus haut s’affiche).',
	animateAria: 'Animer l’heure de prévision',
	autoByRegion: 'Auto selon la région',
	barb: {
		calm: 'Calme',
		degTrue: (ddd: string) => `${ddd}° vrai`,
		fadedNote: 'vent à 10 m (niveau sous le relief)',
		aboveTopNote: 'au-dessus du plafond de la prévision, vent du niveau le plus haut affiché',
	},
	barbLegendAria: 'Légende des barbules',
	catalogFetched: (age: string) => `Catalogue récupéré ${age}, les liens expirent avec lui.`,
	chartLabel: (p: { chart: string; deadline: string }) => `${p.chart}, validité ${p.deadline}`,
	chartZoneAria: 'Zone de la carte',
	custom: 'Personnalisé',
	dateTimeLegend: 'Date et heure (UTC)',
	downloadPdfTip: 'Télécharger le PDF depuis aviation.meteo.fr',
	feet: 'Pieds',
	fetchFailed: 'Échec de récupération\u202f:',
	hazards: {
		ICE: 'Givrage',
		MTW: 'Ondes orographiques',
		OTHER: 'Autre',
		TC: 'Cyclone tropical',
		TS: 'Orages',
		TURB: 'Turbulence',
		VA: 'Cendres volcaniques',
	},
	isobars: 'Isobares MSLP (4 hPa)',
	isobarsTip:
		'Isobares de la pression au niveau de la mer toutes les 4 hPa, tracées sous les barbules. Activer l’option ajoute le champ de pression à la récupération.',
	isothermAtLevel: 'Isotherme au niveau choisi',
	isothermTempAria: 'Température de l’isotherme (degrés Celsius)',
	level: 'Niveau',
	liveWeatherDisabled:
		'La météo en direct est désactivée dans l’onglet Réglages, aucune donnée de vent n’est donc récupérée.',
	liveWeatherOff: 'Météo en direct désactivée.',
	loadingAdvisories: 'Chargement des avis.',
	loadingCatalog: 'Chargement du catalogue de cartes.',
	loadingStations: 'Chargement des stations.',
	loadingWx: 'Chargement de la météo.',
	metar: {
		agoHM: (h: number, mm: string) => `il y a ${h} h ${mm}`,
		agoMin: (min: number) => `il y a ${min} min`,
		calm: 'calme',
		gustingKt: (kt: number) => `rafales ${kt} kt`,
		orMore: (text: string) => `${text} ou plus`,
	},
	metarStationsLegend: 'Stations METAR',
	model: 'Modèle',
	modelLine: (p: { model: string; days: number }) =>
		`${p.model}, prévisions jusqu’à ${p.days} ${plural(p.days, 'jour', 'jours')}`,
	modelRun: (run: string) => `réseau ${run}`,
	nearestMetar: (p: { id: string; dist: string }) =>
		`METAR le plus proche, ${p.id}, à ${p.dist}`,
	nearestUnavailable: 'Recherche de la station la plus proche indisponible.',
	noAdvisories: 'Aucun avis actif dans la fenêtre du filtre.',
	noCharts: 'Aucune carte publiée pour cette zone.',
	noStation50: 'Aucune station METAR à moins de 50 NM.',
	noStationAt: (id: string) => `Aucune station METAR à ${id}.`,
	now: 'Maintenant',
	openMeteoCredit: 'Données météo par Open-Meteo.com',
	pauseAnimation: 'Suspendre l’animation',
	playAnimation: 'Lancer l’animation',
	printBrief: 'Imprimer le briefing météo',
	printBriefEmpty: 'Rien à imprimer pour le vol prévu.',
	printBriefTip:
		'Imprimer la partie météo du dossier de vol\u202f: METAR / TAF, puis les cartes TEMSI et WINTEM pertinentes pour le vol prévu (nécessite la météo en direct et une route)',
	refresh: 'Actualiser',
	refreshWxTip: 'Actualiser le METAR et le TAF maintenant',
	refreshedAgo: (age: string) => `actualisation ${age}`,
	searchingNearest: 'Recherche de la station la plus proche.',
	showSigmets: 'Afficher les zones SIGMET sur la carte',
	showStations: 'Afficher les stations METAR sur la carte',
	showWindBarbs: 'Afficher les barbules de vent sur la carte',
	showing: (time: string) => `Heure affichée\u202f: ${time}.`,
	sigmet: {
		above: (level: string) => `au-dessus du ${level}`,
		below: (level: string) => `sous le ${level}`,
	},
	sigmetUntil: (hhmm: string) => `jusqu’à ${hhmm} UTC`,
	sofiaCreditAnd: 'et',
	sofiaCreditPre: 'Cartes de Météo-France via',
	station: {
		noCategory: 'Sans catégorie',
		visibility: (v: string) => `Visibilité ${v}`,
		wind: (v: string) => `Vent ${v}`,
	},
	stationCount: (n: number) => `${n} ${plural(n, 'station', 'stations')}`,
	stationsHidden: 'Stations masquées.',
	stationsNote:
		'Les points de station portent le vent OBSERVÉ en barbules plus petites, sous les grandes barbules de prévision. Cliquer sur une station ouvre son panneau dédié avec le METAR et le TAF décodés.',
	surface10m: 'Surface (10 m)',
	tafValid: (span: string) => `TAF, validité ${span}`,
	title: 'Météo',
	updating: 'Mise à jour.',
	valid: 'Validité',
	validDateAria: 'Date de validité (UTC)',
	validTimeAria: 'Heure de validité (UTC)',
	windModels: {
		arome_france: windModelLabel('arome_france'),
		arpege_europe: windModelLabel('arpege_europe'),
		best_match: 'Meilleur modèle (Open-Meteo)',
		ecmwf_ifs025: windModelLabel('ecmwf_ifs025'),
		gfs_seamless: windModelLabel('gfs_seamless'),
		icon_seamless: windModelLabel('icon_seamless'),
		meteofrance_seamless: windModelLabel('meteofrance_seamless'),
		ukmo_seamless: windModelLabel('ukmo_seamless'),
	},
	windsAloftLegend: 'Vents en altitude',
	wx: (g: WeatherGroup): string => {
		if (!g.descriptor && g.phenomena.length === 0) {
			return g.raw;
		}
		// +FC est le code OMM de la tornade / trombe marine (contact avec la
		// surface); FC seul reste le nuage en entonnoir (en altitude).
		if (g.intensity === '+' && !g.descriptor && g.phenomena.length === 1 && g.phenomena[0] === 'FC') {
			return 'tornade ou trombe marine';
		}
		const PH: Record<string, string> = {
			DZ: 'bruine', RA: 'pluie', SN: 'neige', SG: 'neige en grains', IC: 'cristaux de glace',
			PL: 'granules de glace', GR: 'grêle', GS: 'grésil', UP: 'précipitation inconnue',
			BR: 'brume', FG: 'brouillard', FU: 'fumée', VA: 'cendres volcaniques', DU: 'poussière étendue',
			SA: 'sable', HZ: 'brume sèche', PY: 'embruns', PO: 'tourbillons de poussière', SQ: 'grains',
			FC: 'nuage en entonnoir', SS: 'tempête de sable', DS: 'tempête de poussière',
		};
		const CHASSE: Record<string, string> = {
			SN: 'chasse-neige',
			SA: 'chasse-sable',
			DU: 'chasse-poussière',
		};
		const phenom = g.phenomena.map((p) => PH[p] ?? p).join(' et ');
		// Adjectifs postposés et épicènes ("pluie faible", "grésil intense"):
		// "forte" antéposée fausserait l'accord des phénomènes masculins.
		const withInt = (s: string): string =>
			g.intensity === '-' ? `${s} faible` : g.intensity === '+' ? `${s} intense` : s;
		let phrase: string;
		switch (g.descriptor) {
			case 'TS':
				phrase = phenom ? `orage avec ${withInt(phenom)}` : withInt('orage');
				break;
			case 'SH':
				phrase = phenom ? `${withInt('averse')} de ${phenom}` : withInt('averses');
				break;
			case 'FZ':
				phrase =
					g.phenomena.length === 1 && g.phenomena[0] === 'FG'
						? 'brouillard givrant'
						: `${withInt(phenom)} se congelant`;
				break;
			case 'MI':
				phrase = `${phenom} mince`;
				break;
			case 'PR':
				phrase = `${phenom} partiel`;
				break;
			case 'BC':
				phrase = `bancs de ${phenom}`;
				break;
			case 'DR':
				phrase =
					g.phenomena.length === 1 && g.phenomena[0] in CHASSE
						? `${CHASSE[g.phenomena[0]]} basse`
						: `${phenom} basse`;
				break;
			case 'BL':
				phrase =
					g.phenomena.length === 1 && g.phenomena[0] in CHASSE
						? `${CHASSE[g.phenomena[0]]} élevée`
						: `${phenom} élevée`;
				break;
			default:
				phrase = withInt(phenom);
		}
		return g.intensity === 'VC' ? `${phrase} à proximité` : phrase;
	},
	wxUnavailable: 'Météo indisponible (voir le bouton Actualiser).',
	zone: 'Zone',
	zoomInStations: 'Zoomez pour charger les stations (la vue couvre trop de tuiles de récupération).',
} satisfies Messages['weather'];
