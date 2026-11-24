/* Miroir français de ../en/briefing.ts. « Briefing » suit l'usage de
 * SOFIA-Briefing, et l'activité réelle du RTBA les mots de la plaquette du SIA
 * (« Les horaires d’activité réelle sont diffusés chaque jour à partir de
 * 17h »). */

import type { Messages } from '../en';
import { plural } from './plural';

export const briefing = {
	aerodromes: (list: string) => `NOTAM d’aérodrome non récupérés\u202f: ${list}`,
	age: (age: string) => `NOTAM récupérés ${age}`,
	ageByHand: (age: string) => `Bulletin chargé ${age}`,
	agePaper: (time: string) => `NOTAM récupérés à ${time}`,
	agePaperByHand: (time: string) => `Bulletin chargé à ${time}`,
	byHand: (time: string) => `Bulletin collé ou ouvert à ${time}. Vérifiez qu’il couvre ce vol.`,
	byHandBare: (time: string) => `Bulletin collé ou ouvert à ${time}.`,
	covers: (span: string) => `Couvre ${span}`,
	coversTip: (p: { before: boolean; after: boolean }) =>
		`${
			p.before && p.after
				? 'La période de la carte commence avant ce briefing et va au-delà\u202f: les NOTAM en vigueur hors de lui manquent sur la carte.'
				: p.before
					? 'La période de la carte commence avant ce briefing\u202f: les NOTAM en vigueur avant lui manquent sur la carte.'
					: 'La période de la carte va au-delà de ce briefing\u202f: les NOTAM qui prennent effet après lui manquent sur la carte.'
		} Une période comprise dedans montre la carte telle que briefée.`,
	dotLabel: (p: { tab: string; text: string }) => `${p.tab}\u202f: ${p.text}`,
	failedShow: 'Pourquoi\u202f?',
	fetch: 'Récupérer les NOTAM',
	fetched: (p: { source: string; time: string; age: string }) => `NOTAM\u202f: ${p.source} ${p.time}, ${p.age}`,
	fetchedPaper: (p: { source: string; time: string; span: string }) => `NOTAM\u202f: ${p.source} ${p.time}, pour ${p.span}`,
	fetchedPaperBare: (p: { source: string; time: string }) => `NOTAM\u202f: ${p.source} ${p.time}`,
	fetching: 'Récupération…',
	fold: 'Masquer jusqu’à ce que le briefing change',
	newSince: (p: { n: number; time: string }) =>
		`${p.n} ${plural(p.n, 'nouveau', 'nouveaux')} NOTAM depuis ${p.time}`,
	none: 'Aucun briefing NOTAM pour ce vol',
	paperMore: (n: number) => `L’onglet NOTAM en indique ${n} ${plural(n, 'autre', 'autres')}.`,
	period: (p: { briefed: string; flight: string }) => `Le briefing couvre ${p.briefed}, le vol ${p.flight}`,
	printFetches: 'L’impression commence par récupérer le briefing.',
	readsAip: {
		fuel: 'Carburant tel que l’AIP le publie.',
		navlog: 'Fréquences telles que l’AIP les publie.',
		perf: 'Pistes et distances déclarées telles que l’AIP les publie.',
	},
	readsBriefing: {
		fuel: 'Carburant tel que ce briefing le donne.',
		navlog: 'Fréquences telles que ce briefing les donne.',
		perf: 'Pistes et distances déclarées telles que ce briefing les donne.',
	},
	refresh: 'Actualiser',
	remind: 'Me prévenir',
	remindTip: 'Recevoir une notification quand l’activité est diffusée',
	reminderChannel: 'Rappels du briefing NOTAM',
	reminderRefused: 'Les notifications sont désactivées pour cette application.',
	reminderSet: 'Une notification vous préviendra.',
	reminderText: (day: string) =>
		`L’activité réelle du RTBA du ${day} est diffusée. Ouvrez l’application pour actualiser le briefing NOTAM.`,
	reminderTitle: 'Activité réelle du RTBA diffusée',
	retry: 'Réessayer',
	route: (p: { time: string; list: string }) => `La route a changé depuis le briefing de ${p.time} (${p.list})`,
	routeArea: (p: { time: string; list: string }) => `La route sort de la zone du briefing de ${p.time} (${p.list})`,
	routeWidth: (p: { time: string; list: string }) =>
		`Le couloir est plus large que celui du briefing de ${p.time} (${p.list})`,
	rtba: (p: { day: string; release: string }) => `L’activité réelle du RTBA du ${p.day} est diffusée à partir du ${p.release}`,
	shortTag: 'Briefing NOTAM incomplet',
	shortTagNone: 'Aucun briefing NOTAM',
	supaipCited: (p: { ref: string; notam: string }) => `${p.ref} (NOTAM trigger ${p.notam})`,
	supaipList: (day: string) => `Liste des SUP AIP du ${day}`,
	supaipMissing: (p: { n: number; list: string; day: string | null }) =>
		`${p.list} ${p.n === 1 ? 'est en vigueur et absent' : 'sont en vigueur et absents'} de la liste des SUP AIP${p.day === null ? '' : ` du ${p.day}`}`,
	supaipMore: (n: number) => `et ${n} autre${n === 1 ? '' : 's'}`,
} satisfies Messages['briefing'];
