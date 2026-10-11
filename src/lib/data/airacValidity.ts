/* When the aeronautical data a build carries stops being current.
 *
 * The Android app carries the datasets it was built with (the whole
 * public/data ships inside the APK, both AIRAC slots), and so does an
 * installed PWA that has been offline; nothing refreshes them until the next
 * release. The build therefore stamps, from the dataset sidecars it ships, the
 * newest effective date among them; one AIRAC cycle after it the data is past
 * its cycle and AiracBanner says so.
 *
 * The NEWEST date, never each publisher's own: several publishers stamp a
 * publication date rather than a cycle (LVNL's aerodromes are dated 2022,
 * Georgia issues its data set every few cycles), and would read as expired
 * while being the latest issued. The newest date is carried by the AIRAC
 * publishers' pre-release slots, so the stamp answers the one question that
 * matters here: is this build a whole cycle behind its own newest data.
 *
 * With one exception, the home State. France is built BY HAND (cmd/fr, from
 * the SIA's AIXM export) where every other publisher is refreshed by a
 * scheduled workflow, so a release can be cut before France's pre-release is
 * in the tree: the others' pre-releases then carry the newest date, and the
 * stamp ran a whole cycle past the French data, the notice silent while the
 * home State's AIP was a cycle old. The stamp is one cycle after the EARLIER
 * of the newest date anywhere and France's own newest.
 *
 * Dates are read the way the slot picker reads them (parseEffectiveMs): an
 * AIRAC effective is a calendar date, and the SIA stamps it at local
 * midnight, "2026-10-01T00:00:00.000+02:00", an instant two hours before the
 * cycle that a plain Date.parse would have ended the validity on.
 *
 * Pure, no Svelte: vite.shared.ts computes the stamp at build time with the
 * same functions the app reads it back with. */

// By extension, unlike the rest of src: the Vite configs load this module
// (through vite.shared.ts), and Vite's config loader warns on every build
// about an extensionless import it reaches.
import { parseEffectiveMs } from './airac.ts';

/** One AIRAC cycle. */
export const AIRAC_CYCLE_MS = 28 * 86_400_000;

/** A pre-release is published about a month ahead of its cycle; a date
 *  further ahead than this is a stamping error, not a cycle, and would make
 *  the build look current for months. */
const MAX_AHEAD_MS = 90 * 86_400_000;

/** The home State's datasets, as cmd/fr writes them (one run writes all six
 *  from one export, each in its current and its pre-release slot). */
export const HOME_DATASETS: readonly string[] = [
	'fr-airspaces',
	'fr-obstacles',
	'fr-airports',
	'fr-navaids',
	'fr-nature',
	'fr-aerodrome-facilities',
];

/** One sidecar a build ships: its file name (`<dataset>.meta.json`, or
 *  `<dataset>.next.meta.json` for a pre-release) and the effective date it
 *  states, whatever that is. */
export interface ShippedSidecar {
	file: string;
	effective: unknown;
}

/** Whether a sidecar file describes one of the home State's datasets. */
export function isHomeSidecar(file: string): boolean {
	return HOME_DATASETS.includes(file.replace(/(\.next)?\.meta\.json$/, ''));
}

/** The latest parseable effective date, ignoring blanks (ENAIRE stamps an
 *  empty one) and dates implausibly far after `buildMs`. */
export function newestEffectiveMs(
	effectives: readonly (string | null | undefined)[],
	buildMs: number,
): number | null {
	let best: number | null = null;
	for (const e of effectives) {
		if (!e) {
			continue;
		}
		const ms = parseEffectiveMs(e);
		if (ms === null || ms > buildMs + MAX_AHEAD_MS) {
			continue;
		}
		if (best === null || ms > best) {
			best = ms;
		}
	}
	return best;
}

/** When a build carrying these effective dates stops being current, or null
 *  when none of them says anything: one cycle after the newest, or after the
 *  home State's newest (`home`, a subset of `effectives`) when that is
 *  earlier. */
export function dataValidUntilMs(
	effectives: readonly (string | null | undefined)[],
	buildMs: number,
	home: readonly (string | null | undefined)[] = [],
): number | null {
	const newest = newestEffectiveMs(effectives, buildMs);
	if (newest === null) {
		return null;
	}
	const homeNewest = newestEffectiveMs(home, buildMs);
	return (homeNewest === null ? newest : Math.min(newest, homeNewest)) + AIRAC_CYCLE_MS;
}

/** The build stamp from the sidecars a build ships, split into every date
 *  and the home State's (dataValidUntilMs). */
export function shippedDataValidUntilMs(
	sidecars: readonly ShippedSidecar[],
	buildMs: number,
): number | null {
	const dated = sidecars.flatMap((s) =>
		typeof s.effective === 'string' ? [{ file: s.file, effective: s.effective }] : [],
	);
	return dataValidUntilMs(
		dated.map((s) => s.effective),
		buildMs,
		dated.filter((s) => isHomeSidecar(s.file)).map((s) => s.effective),
	);
}

/** Whether the data is past its cycle at `nowMs`. An unknown validity is
 *  never expired: the banner must not cry wolf over a build that could not
 *  read its own sidecars. */
export function dataExpired(validUntil: string | null, nowMs: number): boolean {
	if (validUntil === null) {
		return false;
	}
	const until = Date.parse(validUntil);
	return Number.isFinite(until) && nowMs >= until;
}
