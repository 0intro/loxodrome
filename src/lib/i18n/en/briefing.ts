/* The NOTAM briefing judged against the planned flight (state/briefing.svelte.ts,
 * notam/briefingVerdict.ts): the line every NOTAM surface states and the
 * reasons a briefing reads short. Keys are alphabetized. The French mirror is
 * ../fr/briefing.ts. */

import { plural } from './plural';

export const briefing = {
	/** An aerodrome the automatic run asked for by name and did not get. */
	aerodromes: (list: string) => `Aerodrome NOTAMs not fetched: ${list}`,
	/** The briefing is older than its limit on the ground. The NOTAMs tab's
	 *  head states the age in its stamp instead. */
	age: (age: string) => `NOTAMs fetched ${age}`,
	ageByHand: (age: string) => `Bulletin loaded ${age}`,
	/** The age as paper states it, at the fetch's own instant. */
	agePaper: (time: string) => `NOTAMs fetched at ${time}`,
	agePaperByHand: (time: string) => `Bulletin loaded at ${time}`,
	/** A bulletin pasted or opened by hand. */
	byHand: (time: string) => `Bulletin pasted or opened at ${time}. Check that it covers this flight.`,
	/** The same, with no flight planned. */
	byHandBare: (time: string) => `Bulletin pasted or opened at ${time}.`,
	/** The span the briefing covers, stated under its line while the period
	 *  the map is read at reaches outside it. */
	covers: (span: string) => `Covers ${span}`,
	/** Which end of that span the map's period passes, and what the map then
	 *  lacks. */
	coversTip: (p: { before: boolean; after: boolean }) =>
		`${
			p.before && p.after
				? 'The map’s period starts before this briefing and runs past it: NOTAMs in force outside it are missing from the map.'
				: p.before
					? 'The map’s period starts before this briefing: NOTAMs in force before it are missing from the map.'
					: 'The map’s period runs past this briefing: NOTAMs taking effect after it are missing from the map.'
		} A period inside it shows the map as briefed.`,
	/** The NOTAMs tab and the phone's Brief destination, named with what
	 *  their dot says. */
	dotLabel: (p: { tab: string; text: string }) => `${p.tab}: ${p.text}`,
	/** The routes the fetch lost: opens the fetch view, which says why. */
	failedShow: 'Why?',
	fetch: 'Fetch NOTAMs',
	fetched: (p: { source: string; time: string; age: string }) => `NOTAMs: ${p.source} ${p.time}, ${p.age}`,
	/** The stamp as paper prints it, on one line of box C: the source, the
	 *  fetch's absolute time, the period covered. */
	fetchedPaper: (p: { source: string; time: string; span: string }) => `NOTAMs: ${p.source} ${p.time}, for ${p.span}`,
	fetchedPaperBare: (p: { source: string; time: string }) => `NOTAMs: ${p.source} ${p.time}`,
	fetching: 'Fetching…',
	/** The map notice's ✕: the dot keeps saying it. */
	fold: 'Hide until the briefing changes',
	/** NOTAMs the list has not shown yet, since the pilot last left it. */
	newSince: (p: { n: number; time: string }) => `${p.n} new ${plural(p.n, 'NOTAM', 'NOTAMs')} since ${p.time}`,
	none: 'No NOTAM briefing for this flight',
	/** Box C after its first reason: the others, counted (the Overview
	 *  stays one sheet). */
	paperMore: (n: number) => `The NOTAMs tab states ${n} more.`,
	period: (p: { briefed: string; flight: string }) => `The briefing covers ${p.briefed}, the flight ${p.flight}`,
	/** The print menu's line, after the reason: the print's own fetch
	 *  (state/briefingFetch.ts ensureBriefing). */
	printFetches: 'The print fetches the briefing first.',
	/** What a sheet reads while the briefing is short (the performance, fuel
	 *  and nav log pages), after the reason. */
	readsAip: {
		fuel: 'Fuel as the AIP publishes it.',
		navlog: 'Frequencies as the AIP publishes them.',
		perf: 'Runways and declared distances as the AIP publishes them.',
	},
	readsBriefing: {
		fuel: 'Fuel as that briefing states it.',
		navlog: 'Frequencies as that briefing states them.',
		perf: 'Runways and declared distances as that briefing states them.',
	},
	refresh: 'Refresh',
	/** The map notice's button on Android, which asks for the notification
	 *  permission. */
	remind: 'Remind me',
	remindTip: 'Get a notification when the activity is published',
	/** The reminder's channel, as Android's settings list it. */
	reminderChannel: 'NOTAM briefing reminders',
	/** After the RTBA line, once Android refused the notification permission
	 *  Remind me asked for. */
	reminderRefused: 'Notifications are off for this app.',
	/** After the RTBA line, while the reminder is set. */
	reminderSet: 'A notification will tell you.',
	reminderText: (day: string) =>
		`RTBA activity for ${day} is published. Open the app to refresh the NOTAM briefing.`,
	reminderTitle: 'RTBA activity published',
	retry: 'Retry',
	route: (p: { time: string; list: string }) => `The route changed since the ${p.time} briefing (${p.list})`,
	/** A route leaving the map view a briefing was fetched for. */
	routeArea: (p: { time: string; list: string }) => `The route leaves the area of the ${p.time} briefing (${p.list})`,
	/** A corridor wider than the briefing's: widened since, or past the
	 *  99 NM SOFIA accepts. */
	routeWidth: (p: { time: string; list: string }) => `The corridor is wider than the ${p.time} briefing’s (${p.list})`,
	rtba: (p: { day: string; release: string }) => `RTBA activity for ${p.day} is published from ${p.release}`,
	/** A sheet's warning slot, short, the reason on its title. */
	shortTag: 'NOTAM briefing short',
	shortTagNone: 'No NOTAM briefing',
	/** A supplement a trigger NOTAM of the briefing cites. */
	supaipCited: (p: { ref: string; notam: string }) => `${p.ref} (trigger NOTAM ${p.notam})`,
	/** The SUP AIP list in use, by the day it was built. */
	supaipList: (day: string) => `SUP AIP list of ${day}`,
	/** Supplements a trigger NOTAM cites that the list in use lacks, a stale
	 *  list's (the APK carries the one it was built with). The day is null
	 *  while the list's date is unread. */
	supaipMissing: (p: { n: number; list: string; day: string | null }) =>
		`${p.list} ${p.n === 1 ? 'is' : 'are'} in force and missing from the SUP AIP list${p.day === null ? '' : ` of ${p.day}`}`,
	/** The supplements past the ones named. */
	supaipMore: (n: number) => `and ${n} more`,
};
