/* Unit tests for the SIA airspace symbology resolver: the full type/class ->
 * symbol mapping of docs/airspace-symbology.md, the RTBA id predicate, the
 * Leaflet style invariants (chart-faithful: never a resting fill; highlight
 * always stroked + tinted), and the designator-label rules per source. */

import { describe, it, expect } from 'vitest';
import {
	SIA,
	AEM_BAND,
	aemBandColor,
	bandZoomFactor,
	lineZoomFactor,
	symbolFor,
	polygonStyle,
	polygonHighlightStyle,
	airspaceLabel,
	activityGlyph,
	isRtba,
	type SymbolInput,
	type LabelInput,
} from '$lib/map/airspaceSymbology';

function input(over: Partial<SymbolInput>): SymbolInput {
	return {
		type: 'TMA', airClass: '', subtype: '', source: 'fr', id: 'LFX1',
		upper: null, ...over,
	};
}

function labelInput(over: Partial<LabelInput>): LabelInput {
	return { ...input({}), name: '', workHr: '', ...over };
}

describe('isRtba', () => {
	it('matches the ENR 5.1 AZBA families (AIRAC 04/26) and their sub-zones', () => {
		for (const id of [
			'LFR45C', 'LFR45S6.1', 'LFR45NS', 'LFR46E1', 'LFR56', 'LFR69',
			'LFR143', 'LFR149B', 'LFR152', 'LFR166A1', 'LFR589A', 'LFR593',
		]) {
			expect(isRtba(id), id).toBe(true);
		}
	});
	it('rejects non-AZBA R zones and near-miss ids', () => {
		for (const id of [
			// Ordinary R zones: LFR115A is the Captieux firing range, LFR213
			// an exercise area; neither defers to the Cartes AZBA.
			'LFR115A', 'LFR213', 'LFR30B',
			// The FULL number is the family: 451 / 450 / 404 are not 45.
			'LFR451', 'LFR450', 'LFR404', 'LFR600', 'LFR601', 'LFR4',
			'LFD45', 'EGR45', 'R45C',
		]) {
			expect(isRtba(id), id).toBe(false);
		}
	});
});

describe('zoom factors (chart-anchored at z10)', () => {
	it('thins boundary strokes below z10, holds at the anchor, ramps above', () => {
		expect(lineZoomFactor(14)).toBe(1.6);
		expect(lineZoomFactor(13)).toBe(1.4);
		expect(lineZoomFactor(12)).toBe(1.2);
		expect(lineZoomFactor(11)).toBe(1);
		expect(lineZoomFactor(10)).toBe(1);
		expect(lineZoomFactor(9)).toBe(0.6);
		expect(lineZoomFactor(8)).toBe(0.45);
		expect(lineZoomFactor(6)).toBe(0.4);
	});
	it('narrows bands and fringes below z10, ramps above z11', () => {
		expect(bandZoomFactor(15)).toBe(1.6);
		expect(bandZoomFactor(13)).toBe(1.4);
		expect(bandZoomFactor(12)).toBe(1.2);
		expect(bandZoomFactor(11)).toBe(1);
		expect(bandZoomFactor(10)).toBe(1);
		expect(bandZoomFactor(9)).toBe(0.5);
		expect(bandZoomFactor(8)).toBe(0.33);
		expect(bandZoomFactor(7)).toBe(0.25);
	});
});

describe('symbolFor', () => {
	it('bands controlled airspace by class: A rubine, B/C/D blue, E light blue', () => {
		const a = symbolFor(input({ type: 'TMA', airClass: 'A' }));
		expect(a.band).toMatchObject({ kind: 'solid', color: SIA.zone });
		expect(a.line).toMatchObject({ color: SIA.zone });
		const d = symbolFor(input({ type: 'TMA', airClass: 'D' }));
		expect(d.band).toMatchObject({ kind: 'solid', color: SIA.ctl });
		const none = symbolFor(input({ type: 'CTA', airClass: '' }));
		expect(none.band).toMatchObject({ kind: 'solid', color: SIA.ctl });
		const e = symbolFor(input({ type: 'TMA', airClass: 'E' }));
		expect(e.band).toMatchObject({ kind: 'solid', color: SIA.classE });
		expect(e.line).toMatchObject({ color: SIA.ctl });
		// Class E bands print at TWICE the B/C/D width (Legende2026 class
		// table: 89 px vs 45 px screens) and gate later (FAA E alone is
		// 4330 rows).
		expect(e.band!.widthPx / d.band!.widthPx).toBeCloseTo(2.0, 1);
		expect(e.minZoom.band).toBeGreaterThan(d.minZoom.band);
	});
	it('FAA CLASS rows ride the same class rule', () => {
		const b = symbolFor(input({ type: 'CLASS', airClass: 'B', source: 'faa' }));
		expect(b.band).toMatchObject({ kind: 'solid', color: SIA.ctl });
		const e = symbolFor(input({ type: 'CLASS', airClass: 'E', source: 'faa' }));
		expect(e.band).toMatchObject({ kind: 'solid', color: SIA.classE });
	});
	it('LTA rides the class band like a CTA, no activity glyph (Legende2026: TMA/CTA/LTA row)', () => {
		// The 500k chart groups LTA with TMA / CTA; class D draws the blue
		// band, class E the wide light-blue band, and neither shows the old
		// balloon glyph the D-OTHER mis-typing produced.
		const d = symbolFor(input({ type: 'LTA', airClass: 'D', id: 'LTA13071' }));
		expect(d.band).toMatchObject({ kind: 'solid', color: SIA.ctl });
		expect(d.line).toMatchObject({ color: SIA.ctl });
		expect(d.glyph).toBeNull();
		const e = symbolFor(input({ type: 'LTA', airClass: 'E', id: 'LTA130751' }));
		expect(e.band).toMatchObject({ kind: 'solid', color: SIA.classE });
		expect(e.glyph).toBeNull();
		expect(e.band!.widthPx / d.band!.widthPx).toBeCloseTo(2.0, 1);
		// Prefixed label with the class chip, like the chart's "LTA FRANCE 1 [D]".
		const label = airspaceLabel(
			labelInput({ type: 'LTA', airClass: 'D', name: 'FRANCE 3 ALPES 7', id: 'LTA130737' }),
		);
		expect(label?.text).toBe('LTA FRANCE 3 ALPES 7');
		expect(label?.chip?.letter).toBe('D');
	});
	it('classes F/G draw a thin blue line and no band', () => {
		const g = symbolFor(input({ type: 'CTA', airClass: 'G' }));
		expect(g.band).toBeNull();
		expect(g.line).toMatchObject({ color: SIA.ctl });
	});
	it('CTR is a dashed blue line over a CONTINUOUS band, any class', () => {
		for (const airClass of ['A', 'D', '']) {
			const s = symbolFor(input({ type: 'CTR', airClass }));
			// Long dashes at twice the TMA edge weight (Legende2026: 118.5 on
			// / 22 off at a 19 px weight vs the 9 px B/C/D band edge).
			expect(s.line).toMatchObject({ color: SIA.ctl, weight: 3, dashArray: '21 4' });
			expect(s.band).toMatchObject({ kind: 'solid', color: SIA.ctl });
		}
	});
	it('ATZ is a blue round-dot ring', () => {
		const s = symbolFor(input({ type: 'ATZ' }));
		expect(s.band).toBeNull();
		expect(s.line).toMatchObject({ color: SIA.ctl, lineCap: 'round' });
	});
	it('P draws the rubine crosshatch band', () => {
		const s = symbolFor(input({ type: 'P', id: 'LFP23' }));
		expect(s.band).toMatchObject({ kind: 'cross', color: SIA.zone });
		expect(s.line).toMatchObject({ color: SIA.zone });
		expect(s.crossEligible).toBe(true);
	});
	it('R / D / CBA / MOA / W / A / TFR draw the rubine 45-degree hatch band', () => {
		for (const type of ['R', 'D', 'CBA', 'MOA', 'W', 'A', 'TFR']) {
			const s = symbolFor(input({ type, id: 'LFR212' }));
			expect(s.band, type).toMatchObject({ kind: 'hatch', color: SIA.zone });
			expect(s.crossEligible, type).toBe(true);
		}
	});

	it('CBA files with the R / D family, not the TRA orange (Legende2026)', () => {
		const s = symbolFor(input({ type: 'CBA', id: 'EBCBA01' }));
		expect(s.line).toMatchObject({ color: SIA.zone, weight: 1.2 });
		expect(s.band).toMatchObject({ kind: 'hatch', color: SIA.zone });
		expect(s).toEqual(symbolFor(input({ type: 'D', id: 'EBD01' })));
	});
	it('RTBA zones add the thick pecked inner band', () => {
		expect(symbolFor(input({ type: 'R', id: 'LFR45C' })).band).toMatchObject({
			kind: 'hatchPecked',
		});
		expect(symbolFor(input({ type: 'R', id: 'LFR450' })).band).toMatchObject({
			kind: 'hatch',
		});
	});
	it('TMZ / RMZ / TMZ-RMZ dash long-short in the soft ink, clean interior', () => {
		for (const type of ['TMZ', 'RMZ', 'TMZ-RMZ']) {
			const s = symbolFor(input({ type }));
			// Legende2026: long 65.5 / gap 23 / short 21 / gap 23, printed in
			// the softer #3D3D3C black layer; the chart prints the weight at
			// ~0.6x the CTR dash (8.5-10 px at 600 dpi), not the legend's 1x.
			expect(s.line).toMatchObject({
				color: SIA.inkSoft,
				weight: 2,
				dashArray: '10 4 3 4',
			});
			expect(s.band).toBeNull();
		}
	});
	it('ADIZ dash-dot-dots in ink, TRA / TSA the solid orange line', () => {
		expect(symbolFor(input({ type: 'ADIZ' })).line).toMatchObject({
			color: SIA.ink,
			dashArray: '12 4 2 4 2 4',
		});
		expect(symbolFor(input({ type: 'TRA' })).line).toMatchObject({ color: SIA.tra });
		// TSA prints like TRA (Belgium publishes TRA/TSA volumes).
		expect(symbolFor(input({ type: 'TSA' }))).toEqual(symbolFor(input({ type: 'TRA' })));
	});
	it('SIV is green square dots only; DLG-ATS the dark-blue fine comb', () => {
		const siv = symbolFor(input({ type: 'SIV' }));
		expect(siv.line).toBeNull();
		expect(siv.marks).toEqual({ kind: 'squareDots', color: SIA.siv });
		const dlg = symbolFor(input({ type: 'DLG-ATS' }));
		expect(dlg.line).toBeNull();
		expect(dlg.marks).toEqual({ kind: 'fineComb', color: SIA.dlg });
	});
	it('FIC (FIR-level FIS) draws nothing: the chart never prints it', () => {
		const fic = symbolFor(input({ type: 'FIC' }));
		expect(fic.line).toBeNull();
		expect(fic.band).toBeNull();
		expect(fic.marks).toBeNull();
		expect(fic.glyph).toBeNull();
		// The selection highlight derives its stroke from labelColor.
		expect(fic.labelColor).toBe(SIA.siv);
		expect(airspaceLabel(labelInput({ type: 'FIC', name: 'PARIS OUEST', id: 'LFFFFSO' }))).toBeNull();
	});
	it('the FIR family draws the ink comb (incl. US centres)', () => {
		for (const type of ['FIR', 'UIR', 'OCA', 'ARTCC', 'ACC']) {
			const s = symbolFor(input({ type }));
			expect(s.marks, type).toEqual({ kind: 'comb', color: SIA.ink });
			expect(s.line, type).toMatchObject({ color: SIA.ink });
		}
	});
	it('UTA / FRA / TRSA / SATA are thin blue lines', () => {
		for (const type of ['UTA', 'FRA', 'TRSA', 'SATA']) {
			const s = symbolFor(input({ type }));
			expect(s.band, type).toBeNull();
			expect(s.line, type).toMatchObject({ color: SIA.ctl, weight: 0.85 });
		}
	});
	it('unknown types fall back to the class-banded controlled rule', () => {
		const s = symbolFor(input({ type: 'XYZ', airClass: 'D' }));
		expect(s.band).toMatchObject({ kind: 'solid', color: SIA.ctl });
	});
});

describe('activity glyph keying', () => {
	const cases: [string, string, string | null][] = [
		['ACTIVITY', 'AER', 'modelAircraft'],
		['ACTIVITY', 'VOL', 'aerobatics'],
		['ACTIVITY', 'PJE', 'parachute'],
		['ACTIVITY', 'TRPLA', 'glider'],
		['ACTIVITY', 'TRVL', 'paraglider'],
		['ACTIVITY', 'TRPVL', 'paraglider'],
		['ACTIVITY', 'BAL', 'balloon'],
		// Dept-numbered AP rows ("33-001") are the GEN 2.3-2 drone zones.
		['ACTIVITY', 'AP', 'drone'],
		['ACTIVITY', '', 'generic'],
		['PARACHUTE', '', 'parachute'],
		['PARAGLIDER', '', 'paraglider'],
		['GLIDER', '', 'glider'],
		['BALLOON', '', 'balloon'],
		// Every TOWING row is a *TOW winch zone; no official tug symbol exists.
		['TOWING', '', 'paraglider'],
		['TOWING', 'TRVL', 'paraglider'],
		['TOWING', 'TRPLA', 'glider'],
		// The subtype routes first: LFV926TOW is typed PARACHUTE but is a
		// vol-libre winch site.
		['PARACHUTE', 'TRVL', 'paraglider'],
		['FBZ', '', 'balloon'],
		['FBZ', 'FBZ', 'balloon'],
	];
	it.each(cases)('%s/%s -> %s', (type, subtype, glyph) => {
		expect(activityGlyph(input({ type, subtype }))).toBe(glyph);
		expect(symbolFor(input({ type, subtype })).glyph).toBe(glyph);
	});
	it('SUR / PRN rows draw no glyph (natureLayer bullseye covers them)', () => {
		for (const subtype of ['SUR', 'PRN']) {
			const s = symbolFor(input({ type: 'ACTIVITY', subtype }));
			expect(s.glyph).toBeNull();
			expect(s.crossEligible).toBe(false);
		}
	});
	it('activity zones never degrade to the tiny-zone cross', () => {
		for (const [type, subtype] of [
			['ACTIVITY', 'VOL'], ['ACTIVITY', 'AER'], ['PARACHUTE', ''], ['FBZ', ''],
		]) {
			expect(symbolFor(input({ type, subtype })).crossEligible, `${type}/${subtype}`).toBe(false);
		}
	});
	it('activity zones keep the thin chart-red outline', () => {
		expect(symbolFor(input({ type: 'ACTIVITY', subtype: 'VOL' })).line).toMatchObject({
			color: SIA.zone,
		});
	});
});

describe('aeromodelling height bands (Legende2026 9560 / 9604 / 9657-1)', () => {
	const aer = (upper: SymbolInput['upper']) =>
		input({ type: 'ACTIVITY', subtype: 'AER', upper });
	it('colours AER zones by ceiling band, outline and label alike', () => {
		const cases: [SymbolInput['upper'], string][] = [
			[['HEI', '450', 'FT'], AEM_BAND.low],
			[['HEI', '1000', 'FT'], AEM_BAND.low],
			[['HEI', '1500', 'FT'], AEM_BAND.mid],
			[['HEI', '2500', 'FT'], AEM_BAND.high],
			// AMSL ceilings band on the published number (upper bound on the
			// height: may overstate the band, never understate it).
			[['ALT', '800', 'FT'], AEM_BAND.low],
			[['ALT', '1450', 'FT'], AEM_BAND.mid],
			// Metre ceilings convert before banding (500 m = 1640 ft: mid,
			// not low as the raw number would suggest).
			[['HEI', '500', 'M'], AEM_BAND.mid],
			// No usable ceiling, or an explicit UNL: the activity family red.
			[null, AEM_BAND.high],
			[['UNL', '', ''], AEM_BAND.high],
		];
		for (const [upper, color] of cases) {
			const s = symbolFor(aer(upper));
			expect(s.labelColor, JSON.stringify(upper)).toBe(color);
			expect(s.line?.color, JSON.stringify(upper)).toBe(color);
			expect(aemBandColor({ upper })).toBe(color);
		}
	});
	it('memoisation keeps the bands apart', () => {
		expect(symbolFor(aer(['HEI', '450', 'FT'])).labelColor).not.toBe(
			symbolFor(aer(['HEI', '1500', 'FT'])).labelColor,
		);
	});
	it('other activities stay on the family red', () => {
		for (const subtype of ['VOL', 'PJE', 'TRVL', 'AP']) {
			expect(
				symbolFor(input({ type: 'ACTIVITY', subtype, upper: ['HEI', '450', 'FT'] }))
					.labelColor,
				subtype,
			).toBe(SIA.zone);
		}
		expect(AEM_BAND.high).toBe(SIA.zone);
	});
});

describe('polygon styles', () => {
	const everyType = [
		'TMA', 'CTA', 'CLASS', 'CTR', 'ATZ', 'P', 'R', 'D', 'CBA', 'MOA', 'W', 'A', 'TFR',
		'TMZ', 'RMZ', 'TMZ-RMZ', 'ADIZ', 'TRA', 'TSA', 'SIV', 'FIC', 'DLG-ATS',
		'FIR', 'UIR', 'OCA', 'ARTCC', 'ACC', 'UTA', 'FRA', 'TRSA', 'SATA',
		'ACTIVITY', 'PARACHUTE', 'FBZ',
	];
	it('never fills a resting interior (chart-faithful)', () => {
		for (const type of everyType) {
			const style = polygonStyle(input({ type, airClass: 'D' }));
			expect(style.fill, type).toBe(false);
			expect(style.fillOpacity, type).toBe(0);
		}
	});
	it('rests strokeless exactly for SIV / FIC / DLG-ATS', () => {
		const strokeless = everyType.filter(
			(type) => polygonStyle(input({ type })).stroke === false,
		);
		expect(strokeless.sort()).toEqual(['DLG-ATS', 'FIC', 'SIV']);
	});
	it('highlight always strokes and tints, whatever the resting style', () => {
		for (const type of everyType) {
			const style = polygonHighlightStyle(input({ type, airClass: 'A' }));
			expect(style.stroke, type).toBe(true);
			expect(style.weight, type).toBe(3);
			expect(style.fill, type).toBe(true);
			expect(style.fillOpacity, type).toBeGreaterThan(0);
		}
	});
});

describe('airspaceLabel', () => {
	it('prefixes the type onto bare French designator tails', () => {
		expect(
			airspaceLabel(labelInput({ type: 'R', id: 'LFR212', name: '212' })),
		).toMatchObject({ text: 'R 212', color: SIA.zone });
		expect(
			airspaceLabel(labelInput({ type: 'TMA', name: 'RENNES 4', airClass: 'D' })),
		).toMatchObject({ text: 'TMA RENNES 4', chip: { letter: 'D', solid: true } });
		expect(
			airspaceLabel(labelInput({ type: 'RMZ', name: 'MEAUX' })),
		).toMatchObject({ text: 'RMZ MEAUX', color: SIA.inkSoft });
	});
	it('keeps names that already carry the type word', () => {
		expect(
			airspaceLabel(
				labelInput({ type: 'TMA', source: 'uk', id: 'EGTMA014', name: 'LONDON TMA 14' }),
			)?.text,
		).toBe('LONDON TMA 14');
	});
	it('matches the carried type on token boundaries, not substrings', () => {
		// Single-letter types R/D/P must not be swallowed by ordinary words:
		// fr LFD12SB "12 SUD B" contains a D, fr LFR108RM "108 RM" an R.
		expect(
			airspaceLabel(labelInput({ type: 'D', id: 'LFD12SB', name: '12 SUD B' }))?.text,
		).toBe('D 12 SUD B');
		expect(
			airspaceLabel(labelInput({ type: 'R', id: 'LFR108RM', name: '108 RM' }))?.text,
		).toBe('R 108 RM');
		// be R zones now render their id designator (like de / at), so a
		// prose name is superseded by "EB-R 21".
		expect(
			airspaceLabel(labelInput({ type: 'R', source: 'be', id: 'EBR21', name: 'BRUSSELS CITY' }))
				?.text,
		).toBe('EB-R 21');
		// A whole-token type word still counts as carried.
		expect(
			airspaceLabel(labelInput({ type: 'R', id: 'LFR212', name: 'R 212' }))?.text,
		).toBe('R 212');
	});
	it('derives Spanish zone designators from the id', () => {
		expect(
			airspaceLabel(labelInput({ type: 'R', source: 'es', id: 'LER146', name: 'SORIA' }))?.text,
		).toBe('LE-R 146');
		expect(
			airspaceLabel(labelInput({ type: 'D', source: 'es', id: 'LED17C', name: '' }))?.text,
		).toBe('LE-D 17C');
	});

	it('derives Belgian zone designators from the id', () => {
		expect(
			airspaceLabel(labelInput({ type: 'R', source: 'be', id: 'EBR18A', name: 'BEAUVECHAIN' }))?.text,
		).toBe('EB-R 18A');
		// A republished French zone (LFR*) falls through to its name.
		expect(
			airspaceLabel(labelInput({ type: 'R', source: 'be', id: 'LFR616L', name: 'FLORENNES' }))?.text,
		).toBe('R FLORENNES');
	});

	it('derives UK zone designators from the id', () => {
		expect(
			airspaceLabel(labelInput({ type: 'D', source: 'uk', id: 'EGD710', name: 'RAASAY' }))
				?.text,
		).toBe('D 710');
	});
	it('derives Austrian zone designators from the id', () => {
		expect(
			airspaceLabel(labelInput({ type: 'R', source: 'at', id: 'LOR1', name: 'SEIBERSDORF' }))
				?.text,
		).toBe('LO-R 1');
		expect(
			airspaceLabel(labelInput({ type: 'D', source: 'at', id: 'LOD25A', name: 'ALLENTSTEIG' }))
				?.text,
		).toBe('LO-D 25A');
		// The zone ids that carry no chart designator keep the name.
		expect(
			airspaceLabel(labelInput({ type: 'TSA', source: 'at', id: 'LOTRAHSH', name: 'HOCHSCHWAB-HOCH' }))
				?.text,
		).toBe('TSA HOCHSCHWAB-HOCH');
	});
	it('opens up FAA SUA dashes', () => {
		expect(
			airspaceLabel(labelInput({ type: 'R', source: 'faa', id: 'R-2101', name: 'R-2101' }))
				?.text,
		).toBe('R 2101');
	});
	it('labels class A controlled airspace in rubine, SIV in green', () => {
		expect(
			airspaceLabel(labelInput({ type: 'TMA', name: 'PARIS 5', airClass: 'A' })),
		).toMatchObject({ text: 'TMA PARIS 5', color: SIA.zone });
		expect(
			airspaceLabel(labelInput({ type: 'SIV', name: 'SEINE' })),
		).toMatchObject({ text: 'SEINE', color: SIA.siv });
	});
	it('outlines the class chip for non-H24 zones', () => {
		expect(
			airspaceLabel(labelInput({ type: 'CTR', name: 'PONTOISE', airClass: 'D', workHr: 'HX' }))
				?.chip,
		).toEqual({ letter: 'D', solid: false });
	});
	it('labels activity zones by their bare number, skipping SUR / PRN', () => {
		expect(
			airspaceLabel(labelInput({ type: 'ACTIVITY', subtype: 'VOL', name: '6112' })),
		).toMatchObject({ text: '6112', color: SIA.zone });
		expect(
			airspaceLabel(labelInput({ type: 'ACTIVITY', subtype: 'PRN', name: '14' })),
		).toBeNull();
	});
	it('marks winch zones with the chart CABLE prefix', () => {
		for (const subtype of ['TRPLA', 'TRVL', 'TRPVL']) {
			expect(
				airspaceLabel(labelInput({ type: 'ACTIVITY', subtype, name: '912' }))?.text,
				subtype,
			).toBe('CABLE 912');
		}
		expect(
			airspaceLabel(labelInput({ type: 'TOWING', subtype: 'TRVL', name: '929' }))?.text,
		).toBe('CABLE 929');
		// A non-winch paraglider-family row keeps the bare number.
		expect(
			airspaceLabel(labelInput({ type: 'PARAGLIDER', name: '880' }))?.text,
		).toBe('880');
	});
	it('leaves DLG-ATS and unnamed rows unlabelled', () => {
		expect(airspaceLabel(labelInput({ type: 'DLG-ATS', name: 'GENEVE' }))).toBeNull();
		expect(airspaceLabel(labelInput({ type: 'TMA', name: '' }))).toBeNull();
	});
});
