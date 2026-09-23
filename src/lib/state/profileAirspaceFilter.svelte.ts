/* The vertical profiles' airspace filter rows: which KINDS of airspace the
 * four profiles plot, ported from the Garmin navigators' Airspace page
 * (docs/route-profile.md "Airspace filter"). The rows and the resolver
 * that buckets a volume into one of them are the pure
 * airspaceFilterGroup in $lib/data/airspaces; what lives here is the
 * pilot's choice and its persistence. Every row lives here even though no
 * one surface offers them all: the state is shared, and which subset a
 * surface can serve is that surface's own business.
 *
 * The profileLayers idiom exactly: one key per row, only the NON-DEFAULT
 * state stored, so a fresh browser writes nothing and a partial write
 * cannot lose the others. Deliberately
 * NOT folded into profileLayers (those seven are OVERLAY toggles for two
 * modals; these eight subset the chart's own subject and reach the two
 * column profiles too) and not into the 'loxodrome:layers' doc (that is
 * the MAP's layer document, seeded through its own validator and written
 * by PersistHost). reset.ts needs no registration: clearing is the default
 * and only KEEPING a key requires a list. */

import { AIRSPACE_FILTER_GROUPS, type AirspaceFilterGroup } from '$lib/data/airspaces';
import { readItem, removeItem, writeItem } from './persist';

const KEYS: Record<AirspaceFilterGroup, string> = {
	classA: 'loxodrome:profile-class-a',
	classB: 'loxodrome:profile-class-b',
	classC: 'loxodrome:profile-class-c',
	classD: 'loxodrome:profile-class-d',
	classE: 'loxodrome:profile-class-e',
	restricted: 'loxodrome:profile-zone-restricted',
	military: 'loxodrome:profile-zone-military',
	trafficmgmt: 'loxodrome:profile-zone-trafficmgmt',
	other: 'loxodrome:profile-zone-other',
	activity: 'loxodrome:profile-activity',
	fir: 'loxodrome:profile-fir',
	siv: 'loxodrome:profile-siv',
};

/* Every row on but two. Aerial activity ships OFF: it is the only row
 * whose volumes carry no obligation on a transiting pilot (SERA.3120 /
 * 3125 / 3130 put the duty on the operator), and 1061 of its 2403 rows
 * top out at or below 1000 ft - mostly aeromodelling sites, which would
 * crowd the ground line for nothing. Off also means nothing changed for
 * an existing pilot the day the row appeared. */
export const PROFILE_AIRSPACE_DEFAULTS: Record<AirspaceFilterGroup, boolean> = {
	classA: true,
	classB: true,
	classC: true,
	classD: true,
	classE: true,
	restricted: true,
	military: true,
	trafficmgmt: true,
	other: true,
	activity: false,
	fir: true,
	// Off for the same reason as activity, and a different one: a FIS
	// sector spans the whole leg from the surface, so it is a backdrop
	// rather than a volume to clear, and the pilot asks for it when the
	// radio is the question.
	siv: false,
};

function initial(key: AirspaceFilterGroup): boolean {
	const stored = readItem(KEYS[key]);
	return stored == null ? PROFILE_AIRSPACE_DEFAULTS[key] : stored === 'on';
}

export const profileAirspaceGroups = $state<Record<AirspaceFilterGroup, boolean>>({
	classA: initial('classA'),
	classB: initial('classB'),
	classC: initial('classC'),
	classD: initial('classD'),
	classE: initial('classE'),
	restricted: initial('restricted'),
	military: initial('military'),
	trafficmgmt: initial('trafficmgmt'),
	other: initial('other'),
	activity: initial('activity'),
	fir: initial('fir'),
	siv: initial('siv'),
});

/** Toggle one filter row, storing only the non-default state. */
export function setProfileAirspaceGroup(key: AirspaceFilterGroup, on: boolean): void {
	profileAirspaceGroups[key] = on;
	if (on === PROFILE_AIRSPACE_DEFAULTS[key]) {
		removeItem(KEYS[key]);
	} else {
		writeItem(KEYS[key], on ? 'on' : 'off');
	}
}

/** Has the pilot narrowed the rows BEYOND their defaults? The header
 *  button wears its emphasis while this holds, so a decluttered chart says
 *  so without being opened.
 *
 *  Against DEFAULTS rather than against `true`, which is the same test
 *  today and stops being one the moment a row ships default-off: such a
 *  row would otherwise light the emphasis on every install out of the box
 *  and the signal would stop meaning anything. Deliberately NOT the same
 *  question as `airspaceGateActive`, which asks whether anything is hidden
 *  at all and must keep answering yes for a default-off row. */
export function profileAirspaceGroupsRestrict(): boolean {
	return AIRSPACE_FILTER_GROUPS.some((g) => profileAirspaceGroups[g] !== PROFILE_AIRSPACE_DEFAULTS[g]);
}
