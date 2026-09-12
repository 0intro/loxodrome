import { describe, expect, it } from 'vitest';
import {
	formatFreqMHz,
	coalesceRadios,
	coalesceRadioLines,
	contactLines,
	preferredChannel,
	radioSummary,
	sortRadios,
} from '$lib/format/radio';

describe('formatFreqMHz', () => {
	it('formats to exactly three decimals', () => {
		expect(formatFreqMHz('119.3')).toBe('119.300');
		expect(formatFreqMHz('123')).toBe('123.000');
		expect(formatFreqMHz('118.775')).toBe('118.775');
		expect(formatFreqMHz(' 121.5 ')).toBe('121.500');
	});

	it('returns non-numeric input unchanged', () => {
		expect(formatFreqMHz('')).toBe('');
		expect(formatFreqMHz('n/a')).toBe('n/a');
	});
});

describe('coalesceRadios', () => {
	it('joins distinct service labels that share a frequency', () => {
		const got = coalesceRadios([
			{ freq: '121.1', unit: 'TWR', call: '' },
			{ freq: '121.1', unit: 'A/A', call: '' },
		]);
		expect(got).toEqual([{ label: 'TWR / A/A', freq: '121.100' }]);
	});

	it('keeps distinct frequencies separate, in canonical order', () => {
		const got = coalesceRadios([
			{ freq: '127.115', unit: 'ATIS', call: '' },
			{ freq: '119.25', unit: 'TWR', call: '' },
		]);
		expect(got).toEqual([
			{ label: 'TWR', freq: '119.250' },
			{ label: 'ATIS', freq: '127.115' },
		]);
	});

	it('drops blank frequencies and units', () => {
		const got = coalesceRadios([
			{ freq: '', unit: 'TWR', call: '' },
			{ freq: '118.7', unit: '', call: '' },
		]);
		expect(got).toEqual([]);
	});
});

describe('coalesceRadioLines', () => {
	it('merges distinct services that share one frequency (TWR / AFIS / A/A)', () => {
		const got = coalesceRadioLines([
			{ freq: '118.2', unit: 'TWR', call: '' },
			{ freq: '118.2', unit: 'AFIS', call: '' },
			{ freq: '118.2', unit: 'A/A', call: '' },
		]);
		expect(got).toEqual([{ label: 'TWR / AFIS / A/A', freq: '118.200' }]);
	});

	it('joins a service published on several frequencies into one line', () => {
		const got = coalesceRadioLines([
			{ freq: '134.875', unit: 'APP', call: '' },
			{ freq: '118.05', unit: 'APP', call: '' },
			{ freq: '118.89', unit: 'APP', call: '' },
			{ freq: '127.815', unit: 'FIS', call: '' },
			{ freq: '134.3', unit: 'FIS', call: '' },
		]);
		expect(got).toEqual([
			{ label: 'APP', freq: '134.875 / 118.050 / 118.890' },
			{ label: 'FIS', freq: '127.815 / 134.300' },
		]);
	});

	it('keeps a service-only frequency separate from its shared frequency', () => {
		// TWR shares 118.2 with A/A but also has 120.7 on its own.
		const got = coalesceRadioLines([
			{ freq: '118.2', unit: 'TWR', call: '' },
			{ freq: '118.2', unit: 'A/A', call: '' },
			{ freq: '120.7', unit: 'TWR', call: '' },
		]);
		expect(got).toEqual([
			{ label: 'TWR / A/A', freq: '118.200' },
			{ label: 'TWR', freq: '120.700' },
		]);
	});

	it('keys off a custom label (the call sign) for airspace radios', () => {
		// One controller (SEINE - APPROCHE) on three frequencies.
		const got = coalesceRadioLines(
			[
				{ freq: '134.875', unit: 'LFPM MELUN SEINE', call: 'SEINE - APPROCHE' },
				{ freq: '118.05', unit: 'LFPM MELUN SEINE', call: 'SEINE - APPROCHE' },
				{ freq: '118.89', unit: 'LFPM MELUN SEINE', call: 'SEINE - APPROCHE' },
			],
			(r) => r.call || r.unit,
		);
		expect(got).toEqual([{ label: 'SEINE - APPROCHE', freq: '134.875 / 118.050 / 118.890' }]);
	});
});

describe('radioSummary', () => {
	it('renders the coalesced lines as one "label: freq" string', () => {
		expect(
			radioSummary([
				{ freq: '118.2', unit: 'TWR', call: '' },
				{ freq: '118.2', unit: 'A/A', call: '' },
				{ freq: '134.875', unit: 'APP', call: '' },
				{ freq: '118.05', unit: 'APP', call: '' },
			]),
		).toBe('TWR / A/A: 118.200 · APP: 134.875 / 118.050');
	});
});

describe('sortRadios', () => {
	it('orders by canonical service rank, stable within unknowns', () => {
		const got = sortRadios([
			{ freq: '1', unit: 'APP', call: '' },
			{ freq: '2', unit: 'TWR', call: '' },
			{ freq: '3', unit: 'ATIS', call: '' },
		]);
		expect(got.map((r) => r.unit)).toEqual(['TWR', 'ATIS', 'APP']);
	});
});

/* The channel and callable rules below are pinned against the shipped
 * datasets: every ident named is a real field whose published list has the
 * shape under test. */

describe('preferredChannel', () => {
	it('passes a single channel through', () => {
		expect(preferredChannel('118.605')).toBe('118.605');
	});

	it('takes the civil VHF channel over a military one', () => {
		// LFBY tower publishes VHF-low first, LFKS and LFMI publish UHF first.
		expect(preferredChannel('40.800 / 118.325')).toBe('118.325');
		expect(preferredChannel('257.800 / 122.100')).toBe('122.100');
		expect(preferredChannel('377.600 / 123.600')).toBe('123.600');
	});

	it('takes a working channel over the emergency frequency', () => {
		// LFTH tower and the Luxembourg tower/approach both list guard first.
		expect(preferredChannel('257.800 / 121.500 / 121.800 / 121.000')).toBe('121.800');
		expect(preferredChannel('121.500 / 120.165 / 119.950')).toBe('120.165');
	});

	it('shows guard when the line has nothing else', () => {
		expect(preferredChannel('121.500')).toBe('121.500');
		expect(preferredChannel('243.000 / 121.500')).toBe('121.500');
	});

	it('shows a UHF-only line as published', () => {
		expect(preferredChannel('257.800 / 343.325')).toBe('257.800');
	});
});

describe('contactLines', () => {
	const r = (unit: string, freq: string, call = ''): { freq: string; unit: string; call: string } => ({
		freq,
		unit,
		call,
	});

	it('leads with the tower and reduces each line to one channel', () => {
		const got = contactLines(
			[r('ATIS', '125.030'), r('TWR', '118.605'), r('GND', '122.130')],
			'aerodrome',
		);
		expect(got.map((l) => `${l.label} ${l.freq}`)).toEqual([
			'TWR 118.605',
			'GND 122.130',
			'ATIS 125.030',
		]);
	});

	it('never offers a service you only listen to when one can be called', () => {
		// LFNA publishes ATIS and AFIS; the canonical order ranks ATIS first.
		const lfna = contactLines([r('ATIS', '122.505'), r('AFIS', '118.475')], 'aerodrome');
		expect(lfna[0].label).toBe('AFIS');
		expect(lfna[1].label).toBe('ATIS');
		// LFBU adds an A/A on the AFIS frequency, which coalesces into one line.
		const lfbu = contactLines(
			[r('ATIS', '120.900'), r('AFIS', '118.150'), r('A/A', '118.150')],
			'aerodrome',
		);
		expect(lfbu[0].label).toBe('AFIS / A/A');
	});

	it('keeps a listen-only service when the field publishes nothing else', () => {
		const got = contactLines([r('ATIS', '127.000')], 'aerodrome');
		expect(got.map((l) => l.label)).toEqual(['ATIS']);
	});

	it('carries every channel for the tooltip while showing one', () => {
		const got = contactLines([r('APP', '127.200'), r('APP', '119.400')], 'aerodrome');
		expect(got[0].freq).toBe('127.200');
		expect(got[0].all).toBe('127.200 / 119.400');
	});

	it('reports the frequency a NOTAM moved a line off', () => {
		const got = contactLines(
			[
				{ ...r('TWR', '118.930'), override: { was: '118.925' } },
				r('GND', '122.130'),
			],
			'aerodrome',
		);
		expect(got[0].was).toBe('118.925');
		expect(got[1].was).toBeUndefined();
	});

	it('leaves an airspace in its published order, keyed on the call sign', () => {
		// Station names are unknown to the canonical rank, so there is no
		// callable / listen distinction to make and nothing to reorder.
		const got = contactLines(
			[r('BREST UAC', '134.575', 'BREST CONTROLE'), r('SEINE', '120.330', 'SEINE INFO')],
			'airspace',
		);
		expect(got.map((l) => l.label)).toEqual(['BREST CONTROLE', 'SEINE INFO']);
	});

	it('never offers guard, whatever label it coalesces under', () => {
		// LFPV Villacoublay publishes 243.000 under BOTH its tower and its
		// approach, so grouping by frequency gives it a "TWR / APP" line with
		// nothing else on it, and the readout offered the military emergency
		// frequency as a channel to set.
		const lfpv = contactLines(
			[
				r('TWR', '121.75'),
				r('TWR', '257.8'),
				r('TWR', '243'),
				r('APP', '123.75'),
				r('APP', '243'),
				r('APP', '119.425'),
			],
			'aerodrome',
		);
		expect(lfpv.map((l) => `${l.label} ${l.freq}`)).toEqual(['TWR 121.750', 'APP 123.750']);
		expect(lfpv[0].all).toBe('121.750 / 257.800');
		// LFKS Solenzara puts both emergency frequencies on that shared line.
		const lfks = contactLines(
			[r('TWR', '119.7'), r('TWR', '243'), r('TWR', '121.5'), r('APP', '243'), r('APP', '121.5')],
			'aerodrome',
		);
		expect(lfks.map((l) => `${l.label} ${l.freq}`)).toEqual(['TWR 119.700']);
	});

	it('is empty for a field with no usable frequency', () => {
		expect(contactLines([], 'aerodrome')).toEqual([]);
		expect(contactLines([r('TWR', '')], 'aerodrome')).toEqual([]);
		// Guard alone is not a frequency to set, so a field publishing nothing
		// else has no contact line.
		expect(contactLines([r('TWR', '121.5')], 'aerodrome')).toEqual([]);
	});
});
