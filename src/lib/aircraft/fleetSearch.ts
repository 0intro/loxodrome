/* Fleet list search + grouping: pure helpers behind the Aircraft tab's
 * operator groups and search field. */

import { aircraftKey, type Aircraft } from './schema';

export interface FleetGroup {
	/** Trimmed operator name; null collects the planes without one. */
	operator: string | null;
	planes: Aircraft[];
}

/** Fold case and accents away ("Aéroclub" matches "aeroclub"). */
export function normalizeFleetText(s: string): string {
	return s
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '');
}

/** Every whitespace-separated query token must substring-match at least one of
 *  registration / type / ICAO type / name / operator; an empty query matches all. */
export function matchesFleetQuery(a: Aircraft, query: string): boolean {
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
	]
		.filter((f): f is string => !!f)
		.map(normalizeFleetText);
	return tokens.every((t) => fields.some((f) => f.includes(t)));
}

/** Group the fleet by operator, filtered by the query: named groups sorted
 *  by name, the operator-less group last, planes within a group sorted by
 *  type, then registration key. Searching drops emptied groups. */
export function groupFleet(planes: Aircraft[], query: string): FleetGroup[] {
	const byOperator = new Map<string | null, Aircraft[]>();
	for (const a of planes) {
		if (!matchesFleetQuery(a, query)) {
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
	const groups = [...byOperator.entries()].map(([operator, list]) => ({
		operator,
		planes: list.sort(
			(x, y) =>
				x.identity.type.localeCompare(y.identity.type) ||
				aircraftKey(x).localeCompare(aircraftKey(y)),
		),
	}));
	return groups.sort((x, y) => {
		if (x.operator === null) {
			return 1;
		}
		if (y.operator === null) {
			return -1;
		}
		return x.operator.localeCompare(y.operator);
	});
}
