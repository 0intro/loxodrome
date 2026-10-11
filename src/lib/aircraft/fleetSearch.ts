/* Fleet list search + grouping: pure helpers behind the Aircraft tab's
 * operator groups and search field. */

import { aircraftKey, type Aircraft } from './schema';

export interface FleetGroup {
	/** An operator's planes, the planes without one, or the generic sheets. */
	kind: 'operator' | 'none' | 'generic';
	/** Trimmed operator name; null for the 'none' and 'generic' groups. */
	operator: string | null;
	planes: Aircraft[];
}

export interface FleetGroupOptions {
	/** The generic group's name in the current language, which a search
	 *  also matches on the generic sheets (this module stays locale-free). */
	genericLabel?: string | undefined;
}

/** Fold case and accents away ("Aéroclub" matches "aeroclub"). */
export function normalizeFleetText(s: string): string {
	return s
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '');
}

/** Every whitespace-separated query token must substring-match at least one of
 *  registration / type / ICAO type / name / operator (and, on a generic sheet,
 *  the generic group's name); an empty query matches all. */
export function matchesFleetQuery(a: Aircraft, query: string, genericLabel?: string): boolean {
	const tokens = normalizeFleetText(query).split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return true;
	}
	const fields = [
		a.identity.registration,
		a.identity.type,
		a.identity.icaoType,
		a.identity.name,
		a.identity.operator,
		a.identity.generic !== undefined ? genericLabel : undefined,
	]
		.filter((f): f is string => !!f)
		.map(normalizeFleetText);
	return tokens.every((t) => fields.some((f) => f.includes(t)));
}

/** Group the fleet by operator, filtered by the query: named groups sorted
 *  by name, then the operator-less group, then the generic sheets (whatever
 *  their operator field), planes within a group sorted by type, then name
 *  (a generic sheet's carries its serial range), then key. Searching drops
 *  emptied groups. */
export function groupFleet(planes: Aircraft[], query: string, opts: FleetGroupOptions = {}): FleetGroup[] {
	const byOperator = new Map<string | null, Aircraft[]>();
	const generic: Aircraft[] = [];
	for (const a of planes) {
		if (!matchesFleetQuery(a, query, opts.genericLabel)) {
			continue;
		}
		if (a.identity.generic !== undefined) {
			generic.push(a);
			continue;
		}
		const op = a.identity.operator?.trim() || null;
		const list = byOperator.get(op);
		if (list) {
			list.push(a);
		} else {
			byOperator.set(op, [a]);
		}
	}
	const byType = (x: Aircraft, y: Aircraft) =>
		x.identity.type.localeCompare(y.identity.type) ||
		(x.identity.generic !== undefined ? (x.identity.name ?? '').localeCompare(y.identity.name ?? '') : 0) ||
		aircraftKey(x).localeCompare(aircraftKey(y));
	const groups: FleetGroup[] = [...byOperator.entries()].map(([operator, list]) => ({
		kind: operator === null ? 'none' : 'operator',
		operator,
		planes: list.sort(byType),
	}));
	groups.sort((x, y) => {
		if (x.operator === null) {
			return 1;
		}
		if (y.operator === null) {
			return -1;
		}
		return x.operator.localeCompare(y.operator);
	});
	if (generic.length > 0) {
		groups.push({ kind: 'generic', operator: null, planes: generic.sort(byType) });
	}
	return groups;
}
