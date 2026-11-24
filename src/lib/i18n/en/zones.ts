/* A zone's state as a panel says it (components/zoneStateText.ts): the
 * state over the viewed time, why, and what changes next. "May be active"
 * is the publications' "activable" (docs/i18n-glossary.md). Times arrive
 * formatted, UTC with their Z. */

export const zones = {
	activePermanent: 'Active, permanent.',
	activeNow: 'Active now.',
	activeNowUntil: (to: string, _dated: boolean) => `Active now, until ${to}.`,
	activeFlight: 'Active during the flight.',
	activePeriod: 'Active over the period.',
	activeFromTo: (from: string, to: string, on: string | null, _dated: boolean) =>
		on ? `Active on ${on} from ${from} to ${to}.` : `Active from ${from} to ${to}.`,
	mayNow: 'May be active now.',
	mayNowUntil: (to: string, _dated: boolean) => `May be active now, until ${to}.`,
	mayFlight: 'May be active during the flight.',
	mayPeriod: 'May be active over the period.',
	mayFromTo: (from: string, to: string, on: string | null, _dated: boolean) =>
		on ? `May be active on ${on} from ${from} to ${to}.` : `May be active from ${from} to ${to}.`,
	inactiveNow: 'Inactive now.',
	inactiveFlight: 'Inactive during the flight.',
	inactivePeriod: 'Inactive over the period.',
	inactiveNowUntil: (to: string, _dated: boolean) => `Inactive now, until ${to}.`,
	reasonNotam: 'Activated by NOTAM.',
	reasonNotamUnread: 'Activated by NOTAM over its whole validity, its item D unread.',
	notamLevels: (lower: string, upper: string) => `The NOTAM activates it from ${lower} to ${upper}.`,
	notamLevelsFrom: (lower: string) => `The NOTAM activates it from ${lower} up.`,
	notamLevelsUpTo: (upper: string) => `The NOTAM activates it up to ${upper}.`,
	reasonRtba: 'Active in the RTBA programme.',
	reasonPublished: 'Active in its published hours.',
	reasonActivable: 'Published as activable: the units it names know the real activity.',
	reasonUnread: 'Its published hours are read in part, so it may be active at any time.',
	reasonNotamUnbriefed: 'Activation by NOTAM. The briefing leaves this zone open at this time.',
	reasonRtbaUnbriefed: 'Activation by NOTAM in the RTBA programme. The briefing predates the day’s release.',
	reasonNotamNone: (time: string) => `Inactive on the briefing of ${time}. Activation is by NOTAM.`,
	reasonNotamNoneNotice: (time: string, notice: string) =>
		`Inactive on the briefing of ${time}. Activation is by NOTAM, at ${notice} notice.`,
	reasonRtbaNone: (time: string) => `Inactive in the RTBA programme of the briefing of ${time}.`,
	reasonNotamNotice: (notice: string, time: string) =>
		`Activation by NOTAM at ${notice} notice. The briefing dates from ${time}.`,
	reasonAmended: 'A NOTAM changes this zone: its published hours are in doubt.',
	reasonOutside: 'Outside its published hours.',
	reasonNoted: (unit: string, at: string) => (unit ? `Noted from ${unit} at ${at}.` : `Noted at ${at}.`),
	reasonNotedBare: 'On the pilot’s note of what the unit said.',
	// `dated`: the instant carries its day, which French introduces apart.
	nextActive: (at: string, _dated: boolean) => `Next: active from ${at}.`,
	nextMay: (at: string, _dated: boolean) => `Next: may be active from ${at}.`,
	nextInactive: (at: string, _dated: boolean) => `Next: inactive from ${at}.`,
	// The crossings strip's notes on a crossing (zoneStateText.ts
	// crossingNoteLines): `after` is how long after the planned exit.
	knownOn: (unit: string) => `Activity known on ${unit}.`,
	knownByPhone: 'Activity known by telephone.',
	afterActive: (at: string, after: string, _dated: boolean) => `Active from ${at}, ${after} after the crossing.`,
	afterMay: (at: string, after: string, _dated: boolean) => `May be active from ${at}, ${after} after the crossing.`,
	// The pilot's note of what a unit said (detail/ZoneNote.svelte): its
	// form, then the note as the lists say it. `dated`: the end carries its
	// day.
	noteHead: 'What the unit says',
	noteUntil: 'Until (UTC)',
	noteUntilAria: 'Until when the unit says it holds, UTC',
	noteUnit: 'Unit',
	noteUnitAria: 'The unit that says it',
	noteInactive: 'Inactive',
	noteActive: 'Active',
	noteInactiveTip: 'Note that the unit says the zone is inactive until this time',
	noteActiveTip: 'Note that the unit says the zone is active until this time',
	noteClear: 'Clear the note',
	notedLine: (active: boolean, until: string, _dated: boolean, unit: string, at: string) =>
		`${active ? 'Active' : 'Inactive'} until ${until}${unit ? `, ${unit}` : ''}, noted ${at}.`,
	notedShort: (active: boolean, until: string, _dated: boolean, unit: string) =>
		`${active ? 'active' : 'inactive'} until ${until}${unit ? `, ${unit}` : ''}`,
	notedUntil: (until: string, _dated: boolean) => `noted until ${until}`,
	notedNamed: (name: string, short: string, at: string) => `${name} ${short}, noted ${at}.`,
	// The temporary zones of the period by state (ZoneList.svelte): the
	// NOTAMs tab's Zones view and the phone's Zones section.
	listTitle: 'Zones',
	listOpenTip: 'The temporary zones of the period by state',
	listBack: 'Back to the NOTAMs',
	listActive: 'Active',
	listMay: 'May be active',
	listLater: 'Later in the period',
	listInactive: (n: number) => `Inactive over the period (${n})`,
	listOthers: 'Other supplements in force',
	listNone: 'No temporary zone over the period.',
	noticeMin: (n: string) => `${n} min`,
	noticeHours: (n: string) => `${n} h`,
	noticeDays: (n: string) => `${n} days`,
};
