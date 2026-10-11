import { describe, expect, it } from 'vitest';
import { classifySurface, formatSurface, hasHardPart, type SurfaceClass } from '$lib/data/runwaySurface';

// Real strings from the shipped datasets (the 2026-10-02 survey), grouped by
// the class each must read as.
const CASES: Record<SurfaceClass, readonly string[]> = {
	hard: [
		'ASP', 'ASPH', 'ASPHALT', 'CON', 'CONC', 'CONCRETE', 'PEM', 'BIT', 'BITUM', 'MACADAM',
		'CONC+ASPH', 'CONC_ASPH', 'ASPH-G', 'ASPH-CONC',
		// A PCN's letters are no surface.
		'ASPH 71/F/C/X/T',
		// Spellings the overlays call ASPH.
		'Asfalt', 'ASHP', 'Ashpalt', 'APSH',
		// DAFIF's permanent surface; the Finnish oil-bound gravel.
		'PER', 'Oilgravel', 'Cement',
		// Blacktop is paving; "granite" is no GRA.
		'Blacktop on granite',
		'PAVED', 'REVÊTUE',
		// Australian bitumen; HARD alone.
		'B', 'HARD', 'hard',
		// Heliport structures draw no bar either way: kept as they were.
		'ROOF', 'DECK', 'METAL', 'WOOD',
	],
	mixed: [
		'ASP+GRS', 'ASPH-TURF', 'ASPH-TURF-G', 'CONC-TURF', 'CONC+GRVL', 'ASPH_GRASS', 'TURF/ASP',
		'Oilgravel/sand',
		// DAFIF's composite codes.
		'COP', 'COM', 'Composite',
	],
	soft: [
		'TURF', 'TURF-G', 'GRASS', 'GRS', 'GVL', 'GRVL', 'GRV', 'GRAVEL', 'GRAVE', 'DIRT', 'EARTH', 'WATER',
		'SAND', 'CLAY', 'CORAL', 'SNOW',
		'Piçarra', 'TER', 'CLA', 'SAN', 'LAT', 'CRUSHED ROCK', 'Graded Hardcore', 'TRTD', 'Hard Gravel',
		// Australian grass and natural strips.
		'G', 'N', 'Gr', 'B/Gr',
		// Every negation of a paving word.
		'Unpaved', 'UnPaved', 'UNPAVED', 'NOT PAVED', 'non-paved', 'Un-paved', 'NONPAVED', 'NOTPAVED',
		'unsealed', 'NON REVÊTUE', 'NON_BITUM_MIX',
	],
	unknown: [
		'', '   ', 'UNK', 'UNKNOWN', 'OTHER', 'MATS', 'PSP', 'PAD', 'X', 'C', 'S', 'L', 'A', 'U',
		// Words the vocabulary leaves alone, never a substring match.
		'GRAIN', 'Hard coating', 'rough', 'STEEL',
	],
};

describe('classifySurface', () => {
	for (const [want, strings] of Object.entries(CASES) as [SurfaceClass, readonly string[]][]) {
		it(`reads ${want}`, () => {
			for (const s of strings) {
				expect(classifySurface(s), s).toBe(want);
			}
		});
	}

	it('reads a missing surface as unknown', () => {
		expect(classifySurface(null)).toBe('unknown');
		expect(classifySurface(undefined)).toBe('unknown');
	});

	it('answers the same twice (memoised)', () => {
		expect(classifySurface('ASPH-TURF')).toBe(classifySurface('ASPH-TURF'));
	});
});

describe('hasHardPart', () => {
	it('is the map paved test: hard and mixed draw paved, soft and unknown do not', () => {
		expect(hasHardPart('hard')).toBe(true);
		expect(hasHardPart('mixed')).toBe(true);
		expect(hasHardPart('soft')).toBe(false);
		expect(hasHardPart('unknown')).toBe(false);
	});
});

describe('formatSurface', () => {
	it('labels by first token', () => {
		expect(formatSurface('ASPH')).toBe('Asphalt');
		expect(formatSurface('ASPH-TURF')).toBe('Asphalt');
		expect(formatSurface('CONC')).toBe('Concrete');
		expect(formatSurface('TURF-G')).toBe('Grass');
		expect(formatSurface('BITUM')).toBe('Bitumen');
		expect(formatSurface('MACADAM')).toBe('Macadam');
	});

	it('reads gravel as Gravel, never as Grass', () => {
		expect(formatSurface('GRAVEL')).toBe('Gravel');
		expect(formatSurface('GRAVEL-G')).toBe('Gravel');
		expect(formatSurface('GRAVE')).toBe('Gravel');
		expect(formatSurface('GRV')).toBe('Gravel');
	});

	it('says Unpaved for a negated paving word', () => {
		expect(formatSurface('UNPAVED')).toBe('Unpaved');
		expect(formatSurface('NOT PAVED')).toBe('Unpaved');
		expect(formatSurface('NON REVÊTUE')).toBe('Unpaved');
	});

	it('says Unknown for an empty or placeholder surface', () => {
		expect(formatSurface('')).toBe('Unknown');
		expect(formatSurface('UNK')).toBe('Unknown');
		expect(formatSurface('OTHER')).toBe('Unknown');
		expect(formatSurface(null)).toBe('Unknown');
	});

	it('shows anything else as published', () => {
		expect(formatSurface('Graded Hardcore')).toBe('Graded Hardcore');
		expect(formatSurface('Piçarra')).toBe('Piçarra');
		expect(formatSurface('  Loam ')).toBe('Loam');
	});
});
