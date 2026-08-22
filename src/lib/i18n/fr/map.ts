/* Miroir français de ../en/map.ts. "NOTAM" est invariable au pluriel;
 * SUP AIP et SIGMET sont des sigles invariants. */

import type { Messages } from '../en';
import { plural } from './plural';

export const map = {
	addWaypoint: 'Ajouter un point ici',
	addWaypointTip:
		'Ajouter un point de cheminement ici (accroché à un aérodrome ou une balise proche)',
	airportsHeading: (n: number) => `Aérodromes (${n})`,
	airspacesHeading: (n: number) => `Espaces aériens (${n})`,
	altitudeProfile: (n: number) =>
		`Profil d’altitude (${n} ${plural(n, 'espace', 'espaces')})`,
	altitudeProfileTip: 'Afficher le profil d’altitude des espaces aériens en ce point',
	copyCoords: 'Copier les coordonnées',
	copyCoordsTip: 'Copier ces coordonnées dans le presse-papiers',
	insertWaypoint: 'Insérer un point ici',
	insertWaypointTip:
		'Insérer un point de cheminement sur ce segment (accroché à un aérodrome ou une balise proche)',
	navaidsHeading: (n: number) => `Aides de radionavigation (${n})`,
	notamCount: (n: number) => `${n} NOTAM`,
	notamsHeading: (n: number) => `NOTAM (${n})`,
	obstaclesHeading: (n: number) => `Obstacles (${n})`,
	profilePoint: 'Point du profil d’altitude (faire glisser pour déplacer)',
	removeWaypoint: 'Supprimer le point',
	removeWaypointNamed: (name: string) => `Supprimer le point ${name}`,
	removeWaypointTip: 'Supprimer ce point de la route',
	sigmetsHeading: (n: number) => `SIGMET (${n})`,
	stationsHeading: (n: number) => `Stations METAR (${n})`,
	supaipHeading: (n: number) => `SUP AIP (${n})`,
	unserviceable: 'Hors service',
	zoomIn: 'Zoom avant',
	zoomOut: 'Zoom arrière',
} satisfies Messages['map'];
