/* Miroir français de ../en/zones.ts. « Activable » est le mot des
 * publications (AIP France ENR 5.1, colonne HOR), l’anglais « may be
 * active » (docs/i18n-glossary.md). */

import type { Messages } from '../en';

export const zones = {
	activePermanent: 'Active en permanence.',
	activeNow: 'Active en ce moment.',
	activeNowUntil: (to: string, dated: boolean) => `Active en ce moment, jusqu’${dated ? 'au' : 'à'} ${to}.`,
	activeFlight: 'Active pendant le vol.',
	activePeriod: 'Active sur la période.',
	activeFromTo: (from: string, to: string, on: string | null, dated: boolean) =>
		on ? `Active le ${on} de ${from} à ${to}.` : dated ? `Active du ${from} au ${to}.` : `Active de ${from} à ${to}.`,
	mayNow: 'Activable en ce moment.',
	mayNowUntil: (to: string, dated: boolean) => `Activable en ce moment, jusqu’${dated ? 'au' : 'à'} ${to}.`,
	mayFlight: 'Activable pendant le vol.',
	mayPeriod: 'Activable sur la période.',
	mayFromTo: (from: string, to: string, on: string | null, dated: boolean) =>
		on ? `Activable le ${on} de ${from} à ${to}.` : dated ? `Activable du ${from} au ${to}.` : `Activable de ${from} à ${to}.`,
	inactiveNow: 'Inactive en ce moment.',
	inactiveFlight: 'Inactive pendant le vol.',
	inactivePeriod: 'Inactive sur la période.',
	inactiveNowUntil: (to: string, dated: boolean) => `Inactive en ce moment, jusqu’${dated ? 'au' : 'à'} ${to}.`,
	reasonNotam: 'Activée par NOTAM.',
	reasonNotamUnread: 'Activée par NOTAM sur toute sa validité, son champ D non lu.',
	notamLevels: (lower: string, upper: string) => `Le NOTAM l’active de ${lower} à ${upper}.`,
	notamLevelsFrom: (lower: string) => `Le NOTAM l’active à partir de ${lower}.`,
	notamLevelsUpTo: (upper: string) => `Le NOTAM l’active jusqu’à ${upper}.`,
	reasonRtba: 'Active dans le programme RTBA.',
	reasonPublished: 'Active dans ses horaires publiés.',
	reasonActivable: 'Publiée comme activable\u202f: les organismes qu’elle cite connaissent l’activité réelle.',
	reasonUnread: 'Ses horaires publiés ne sont lus qu’en partie\u202f: elle peut être active à tout moment.',
	reasonNotamUnbriefed: 'Activation par NOTAM. Le briefing laisse cette zone ouverte à ce moment.',
	reasonRtbaUnbriefed: 'Activation par NOTAM dans le programme RTBA. Le briefing précède la diffusion du jour.',
	reasonNotamNone: (time: string) => `Inactive d’après le briefing de ${time}. Activation par NOTAM.`,
	reasonNotamNoneNotice: (time: string, notice: string) =>
		`Inactive d’après le briefing de ${time}. Activation par NOTAM, préavis ${notice}.`,
	reasonRtbaNone: (time: string) => `Inactive dans le programme RTBA du briefing de ${time}.`,
	reasonNotamNotice: (notice: string, time: string) =>
		`Activation par NOTAM avec un préavis de ${notice}. Le briefing date de ${time}.`,
	reasonAmended: 'Un NOTAM modifie cette zone\u202f: ses horaires publiés sont incertains.',
	reasonOutside: 'En dehors de ses horaires publiés.',
	reasonNoted: (unit: string, at: string) => (unit ? `D’après ${unit}, noté à ${at}.` : `Noté à ${at}.`),
	reasonNotedBare: 'D’après la note du pilote sur ce que dit l’organisme.',
	nextActive: (at: string, dated: boolean) => `Ensuite\u202f: active à partir ${dated ? 'du' : 'de'} ${at}.`,
	nextMay: (at: string, dated: boolean) => `Ensuite\u202f: activable à partir ${dated ? 'du' : 'de'} ${at}.`,
	nextInactive: (at: string, dated: boolean) => `Ensuite\u202f: inactive à partir ${dated ? 'du' : 'de'} ${at}.`,
	knownOn: (unit: string) => `Activité réelle connue de ${unit}.`,
	knownByPhone: 'Activité réelle connue par téléphone.',
	afterActive: (at: string, after: string, dated: boolean) =>
		`Active à partir ${dated ? 'du' : 'de'} ${at}, ${after} après la traversée.`,
	afterMay: (at: string, after: string, dated: boolean) =>
		`Activable à partir ${dated ? 'du' : 'de'} ${at}, ${after} après la traversée.`,
	noteHead: 'Ce que dit l’organisme',
	noteUntil: 'Jusqu’à (UTC)',
	noteUntilAria: 'Jusqu’à quand l’organisme le dit, en UTC',
	noteUnit: 'Organisme',
	noteUnitAria: 'L’organisme qui le dit',
	noteInactive: 'Inactive',
	noteActive: 'Active',
	noteInactiveTip: 'Noter que l’organisme dit la zone inactive jusqu’à cette heure',
	noteActiveTip: 'Noter que l’organisme dit la zone active jusqu’à cette heure',
	noteClear: 'Effacer la note',
	notedLine: (active: boolean, until: string, dated: boolean, unit: string, at: string) =>
		`${active ? 'Active' : 'Inactive'} jusqu’${dated ? 'au' : 'à'} ${until}${unit ? `, ${unit}` : ''}, noté à ${at}.`,
	notedShort: (active: boolean, until: string, dated: boolean, unit: string) =>
		`${active ? 'active' : 'inactive'} jusqu’${dated ? 'au' : 'à'} ${until}${unit ? `, ${unit}` : ''}`,
	notedUntil: (until: string, dated: boolean) => `notée jusqu’${dated ? 'au' : 'à'} ${until}`,
	notedNamed: (name: string, short: string, at: string) => `${name} ${short}, noté à ${at}.`,
	listTitle: 'Zones',
	listOpenTip: 'Les zones temporaires de la période selon leur état',
	listBack: 'Retour aux NOTAM',
	listActive: 'Actives',
	listMay: 'Activables',
	listLater: 'Plus tard sur la période',
	listInactive: (n: number) => `Inactives sur la période (${n})`,
	listOthers: 'Autres suppléments en vigueur',
	listNone: 'Aucune zone temporaire sur la période.',
	noticeMin: (n: string) => `${n} min`,
	noticeHours: (n: string) => `${n} h`,
	noticeDays: (n: string) => `${n} jours`,
} satisfies Messages['zones'];
