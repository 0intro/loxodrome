import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { isSummerUtc, parseSectorHours, sectorActiveIn } from '$lib/route/airspaceHours';

const ms = (iso: string) => Date.parse(iso);
const at = (iso: string) => ({ fromMs: ms(iso), toMs: ms(iso) });
const day = (isoDate: string) => ({
	fromMs: ms(`${isoDate}T00:00:00Z`),
	toMs: ms(`${isoDate}T23:59:59Z`),
});

// The three schedule texts the 110 French SIV / FIC rows publish, verbatim
// from public/data/fr-airspaces.json.
const LE_BOURGET = ['HX', 'SAT-SUN : 0700-1900#(SUM -1 HR)'] as const;
const SEINE = ['HX', '0600-2100 (SUM : -1 HR)'] as const;
const CHEVREUSE = [
	'HO',
	'SUM : 0800 - SS+30 (MAX 1730)#\nWIN : 0900 - SS+30 (MAX 1830)#\nRepris par PARIS INFO en dehors de ces HOR#\nPARIS INFO outside these SKED',
] as const;
const TOUSSUS = { lat: 48.75, lon: 2.11 };

describe('isSummerUtc', () => {
	it('runs from the last Sunday of March to the last Sunday of October', () => {
		expect(isSummerUtc(ms('2026-03-29T00:59:00Z'))).toBe(false);
		expect(isSummerUtc(ms('2026-03-29T01:00:00Z'))).toBe(true);
		expect(isSummerUtc(ms('2026-10-25T00:59:00Z'))).toBe(true);
		expect(isSummerUtc(ms('2026-10-25T01:00:00Z'))).toBe(false);
	});
});

describe('parseSectorHours', () => {
	it('reads a permanently open sector off workHr alone', () => {
		expect(parseSectorHours('H24', 'H24')).toBe('always');
		expect(parseSectorHours('H24', 'H 24')).toBe('always');
		// The one H24 row whose remark is prose, not a schedule.
		expect(parseSectorHours('H24', 'Hors HOR ATS LA ROCHELLE')).toBe('always');
	});

	it('answers unknown for a sector that publishes no schedule text', () => {
		// 46 of the 110 rows: HX or HO with an empty remark. Unknown, never
		// "closed", so the sector goes on being briefed.
		expect(parseSectorHours('HX', '')).toBeNull();
		expect(parseSectorHours('HO', '')).toBeNull();
		expect(parseSectorHours('HX', 'Sur activation')).toBeNull();
	});

	it('reads a day-restricted window and its summer shift', () => {
		const h = parseSectorHours(...LE_BOURGET);
		expect(h).not.toBeNull();
		if (h == null || h === 'always') return;
		expect([...(h.days ?? [])].sort()).toEqual([0, 6]); // Sunday and Saturday
		expect(h.winter).toEqual({ fromMin: 7 * 60, to: { kind: 'clock', min: 19 * 60 } });
		// The local clock does not move, so the UTC window does.
		expect(h.summer).toEqual({ fromMin: 6 * 60, to: { kind: 'clock', min: 18 * 60 } });
	});

	it('reads an every-day window with a summer shift', () => {
		const h = parseSectorHours(...SEINE);
		expect(h).not.toBeNull();
		if (h == null || h === 'always') return;
		expect(h.days).toBeNull();
		expect(h.winter).toEqual({ fromMin: 6 * 60, to: { kind: 'clock', min: 21 * 60 } });
		expect(h.summer).toEqual({ fromMin: 5 * 60, to: { kind: 'clock', min: 20 * 60 } });
	});

	it('reads a per-season sunset-relative window with its cap', () => {
		const h = parseSectorHours(...CHEVREUSE);
		expect(h).not.toBeNull();
		if (h == null || h === 'always') return;
		expect(h.days).toBeNull();
		expect(h.summer).toEqual({
			fromMin: 8 * 60,
			to: { kind: 'sunset', offsetMin: 30, capMin: 17 * 60 + 30 },
		});
		expect(h.winter).toEqual({
			fromMin: 9 * 60,
			to: { kind: 'sunset', offsetMin: 30, capMin: 18 * 60 + 30 },
		});
	});
});

describe('sectorActiveIn', () => {
	const leBourget = parseSectorHours(...LE_BOURGET);
	const seine = parseSectorHours(...SEINE);
	const chevreuse = parseSectorHours(...CHEVREUSE);

	it('is unknown for an unread schedule and true for a permanent one', () => {
		expect(sectorActiveIn(null, at('2026-09-07T10:00:00Z'))).toBeNull();
		expect(sectorActiveIn('always', at('2026-09-07T10:00:00Z'))).toBe(true);
	});

	// The case this whole path exists for: over Pontoise, SIV LE BOURGET is
	// shut on a weekday and PARIS Information is the FIS.
	it('closes a weekend-only sector on a weekday, whole day', () => {
		expect(sectorActiveIn(leBourget, day('2026-09-07'))).toBe(false); // Monday
		expect(sectorActiveIn(leBourget, day('2026-09-12'))).toBe(true); // Saturday
		expect(sectorActiveIn(leBourget, day('2026-09-13'))).toBe(true); // Sunday
	});

	it('applies the summer shift to the day it opens', () => {
		// Saturday in summer: open 0600-1800Z.
		expect(sectorActiveIn(leBourget, at('2026-09-12T05:30:00Z'))).toBe(false);
		expect(sectorActiveIn(leBourget, at('2026-09-12T06:30:00Z'))).toBe(true);
		expect(sectorActiveIn(leBourget, at('2026-09-12T18:30:00Z'))).toBe(false);
		// Saturday in winter: open 0700-1900Z.
		expect(sectorActiveIn(leBourget, at('2026-11-14T06:30:00Z'))).toBe(false);
		expect(sectorActiveIn(leBourget, at('2026-11-14T07:30:00Z'))).toBe(true);
		expect(sectorActiveIn(leBourget, at('2026-11-14T18:30:00Z'))).toBe(true);
	});

	it('answers a dawn departure either side of the DST switch', () => {
		// SEINE opens 0500Z in summer, 0600Z in winter.
		expect(sectorActiveIn(seine, at('2026-09-07T04:30:00Z'))).toBe(false);
		expect(sectorActiveIn(seine, at('2026-09-07T05:30:00Z'))).toBe(true);
		expect(sectorActiveIn(seine, at('2026-11-16T05:30:00Z'))).toBe(false);
		expect(sectorActiveIn(seine, at('2026-11-16T06:30:00Z'))).toBe(true);
	});

	it('resolves a sunset-relative close against the sector position, and is unknown without one', () => {
		// Summer: 0800Z to sunset+30 but never past 1730Z, which is the binding
		// end in September.
		expect(sectorActiveIn(chevreuse, at('2026-09-12T07:30:00Z'), TOUSSUS)).toBe(false);
		expect(sectorActiveIn(chevreuse, at('2026-09-12T12:00:00Z'), TOUSSUS)).toBe(true);
		expect(sectorActiveIn(chevreuse, at('2026-09-12T18:00:00Z'), TOUSSUS)).toBe(false);
		// Winter: opens an hour later and closes with the sun, well before the
		// 1830Z cap.
		expect(sectorActiveIn(chevreuse, at('2026-12-15T08:30:00Z'), TOUSSUS)).toBe(false);
		expect(sectorActiveIn(chevreuse, at('2026-12-15T12:00:00Z'), TOUSSUS)).toBe(true);
		expect(sectorActiveIn(chevreuse, at('2026-12-15T18:00:00Z'), TOUSSUS)).toBe(false);
		// No position: the close cannot be resolved, so nothing is withdrawn.
		expect(sectorActiveIn(chevreuse, at('2026-09-12T20:00:00Z'), null)).toBeNull();
	});

	// European summer time always switches on a SUNDAY at 01:00 UTC, and LE
	// BOURGET is a Saturday/Sunday sector, so the two transition days are
	// operational ones. The window in force after 01:00 is the new season's,
	// and judging the day by its 00:00 season would withdraw a frequency the
	// sector is working: on 2026-03-29 summer opens it at 0600Z, an hour before
	// the winter window the day STARTS in.
	it('reads the season in force at the hour, not at the start of the day', () => {
		expect(sectorActiveIn(leBourget, at('2026-03-29T06:30:00Z'))).toBe(true); // summer, open
		expect(sectorActiveIn(leBourget, at('2026-10-25T18:30:00Z'))).toBe(true); // winter, open
		// Away from the boundary each season still binds on its own.
		expect(sectorActiveIn(leBourget, at('2026-04-05T06:30:00Z'))).toBe(true); // summer Sunday
		expect(sectorActiveIn(leBourget, at('2026-04-05T18:30:00Z'))).toBe(false); // shut at 1800Z
		expect(sectorActiveIn(leBourget, at('2026-11-15T06:30:00Z'))).toBe(false); // winter, not yet
		expect(sectorActiveIn(leBourget, at('2026-11-15T18:30:00Z'))).toBe(true);
	});

	// An exhaustive read against an independent formulation: for every hour of
	// two years, is the instant inside the window its OWN season implies? The
	// day-by-day walk and the seasonal selection have to agree with that at
	// every one of ~17,500 instants, which is what makes the two DST Sundays a
	// pin rather than a case someone remembered to write.
	it('agrees with a direct reading at every hour of 2026 and 2027', () => {
		const cases: [ReturnType<typeof parseSectorHours>, (t: number) => boolean][] = [
			[
				leBourget,
				(t) => {
					const d = new Date(t);
					const dow = d.getUTCDay();
					const summer = isSummerUtc(t);
					const min = d.getUTCHours() * 60 + d.getUTCMinutes();
					return (
						(dow === 0 || dow === 6) &&
						min >= (summer ? 6 : 7) * 60 &&
						min <= (summer ? 18 : 19) * 60
					);
				},
			],
			[
				seine,
				(t) => {
					const d = new Date(t);
					const summer = isSummerUtc(t);
					const min = d.getUTCHours() * 60 + d.getUTCMinutes();
					return min >= (summer ? 5 : 6) * 60 && min <= (summer ? 20 : 21) * 60;
				},
			],
		];
		const bad: string[] = [];
		for (const [hours, want] of cases) {
			for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += 3600_000) {
				if (sectorActiveIn(hours, { fromMs: t, toMs: t }) !== want(t)) {
					bad.push(new Date(t).toISOString());
				}
			}
		}
		expect(bad.slice(0, 8)).toEqual([]);
	});

	it('is true over any range that spans a whole week', () => {
		// An unbounded briefing window contains every weekday, which is exactly
		// why it is not the range the hours are judged against.
		expect(
			sectorActiveIn(leBourget, { fromMs: ms('2026-09-07T00:00:00Z'), toMs: Infinity }),
		).toBe(true);
	});

	it('reads an inverted range as no', () => {
		expect(
			sectorActiveIn(leBourget, { fromMs: ms('2026-09-12T12:00:00Z'), toMs: ms('2026-09-12T10:00:00Z') }),
		).toBe(false);
	});
});

// The reader runs on EVERY publisher's FIS rows, not only the French ones it
// was written against, and the only thing it can do wrong is withdraw a
// frequency a unit is actually working. So this walks the committed datasets
// and pins which rows it claims to understand: a new publisher, or a cycle
// that reformats a schedule, has to come through here.
describe('the committed corpus', () => {
	interface Dataset {
		fields: string[];
		rows: unknown[][];
	}
	const cell = (v: unknown): string => (typeof v === 'string' ? v : '');
	function sivRows(): { file: string; workHr: string; rmk: string }[] {
		const out: { file: string; workHr: string; rmk: string }[] = [];
		for (const file of readdirSync('public/data')) {
			if (!/-airspaces\.json$/.test(file) || file.includes('.next.')) {
				continue;
			}
			const d = JSON.parse(readFileSync(`public/data/${file}`, 'utf8')) as Dataset;
			const ix = Object.fromEntries(d.fields.map((f, i) => [f, i]));
			for (const r of d.rows) {
				const type = cell(r[ix.type]);
				if (type === 'SIV' || type === 'FIC') {
					out.push({ file, workHr: cell(r[ix.workHr]), rmk: cell(r[ix.rmkWorkHr]) });
				}
			}
		}
		return out;
	}

	const all = sivRows();

	it('finds FIS rows to judge', () => {
		expect(all.length).toBeGreaterThan(100);
	});

	it('reads a schedule only where one is published, and only the French rows publish one', () => {
		const gated = all.filter(({ workHr, rmk }) => {
			const h = parseSectorHours(workHr, rmk);
			return h != null && h !== 'always';
		});
		// SEINE 1-8, CHEVREUSE 1-3, LE BOURGET. Every other row in every
		// dataset is either permanently open or states nothing this can read,
		// and both of those leave the sector on watch.
		expect(gated.length).toBe(12);
		expect(new Set(gated.map((g) => g.file))).toEqual(new Set(['fr-airspaces.json']));
	});

	it('never withdraws a frequency on a row that publishes no schedule text', () => {
		// The failure that would matter: a bare HX, or a publisher's own
		// convention, read as a closed window. Germany states "ANY 00:00-00:00"
		// in workHr and the Netherlands leaves both columns empty; neither may
		// ever answer false.
		const at = { fromMs: Date.parse('2026-09-07T10:00:00Z'), toMs: Date.parse('2026-09-07T10:00:00Z') };
		for (const { file, workHr, rmk } of all) {
			if (rmk.trim() !== '' && file === 'fr-airspaces.json') {
				continue; // the 12 gated rows plus the H24 remarks, judged above
			}
			const verdict = sectorActiveIn(parseSectorHours(workHr, rmk), at, null);
			expect(verdict, `${file} ${JSON.stringify([workHr, rmk])}`).not.toBe(false);
		}
	});
});
