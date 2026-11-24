import { describe, it, expect } from 'vitest';
import { extractAirportAnchor, extractRadiusFromText, parseNotams, radiusToNM } from '$lib/notam';

// Unit tests for radius extraction

describe('extractRadiusFromText', () => {
	it('should extract RADIUS after coordinates', () => {
		const text = 'PSN 514600N 0052622E RADIUS 1NM BTN GND/500FT';
		// "514600N 0052622E" starts at 4, length 16
		const r = extractRadiusFromText(text, 4, 20);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(1);
		expect(r!.radiusUnit).toBe('NM');
	});

	it('should extract decimal RADIUS after coordinates', () => {
		const text = 'PSN 513613N 0055239E RADIUS 1.5NM BTN GND';
		const r = extractRadiusFromText(text, 4, 20);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(1.5);
		expect(r!.radiusUnit).toBe('NM');
	});

	it('should extract RADIUS with comma decimal (KM) before coordinates', () => {
		const text = 'CIRCLE RADIUS 5,6KM CENTRED ON 482406N 0170711E';
		// "482406N 0170711E" starts at 31, length 16
		const r = extractRadiusFromText(text, 31, 47);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(5.6);
		expect(r!.radiusUnit).toBe('KM');
	});

	it('should extract M RADIUS OF before coordinates', () => {
		const text = 'UNMANNED ACFT VEHICLE FLYING WI 1000M RADIUS OF 414056N 0044930W';
		// "414056N 0044930W" starts at 49, length 16
		const r = extractRadiusFromText(text, 49, 65);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(1000);
		expect(r!.radiusUnit).toBe('M');
	});

	it('should return null when no radius present', () => {
		const text = 'PSN 484024N 0030441E RDL 031/5.4NM ARP LFAI';
		const r = extractRadiusFromText(text, 4, 20);
		expect(r).toBe(null);
	});

	it('should extract French DE RAYON before coordinates', () => {
		const text = 'CERCLE DE 1NM DE RAYON CENTRE SUR PSN 482807N 0023803E';
		// "482807N 0023803E" starts at 38, length 16
		const r = extractRadiusFromText(text, 38, 54);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(1);
		expect(r!.radiusUnit).toBe('NM');
	});

	it('should extract French decimal DE RAYON before coordinates', () => {
		const text = 'CERCLE DE 0.2NM DE RAYON CENTRE SUR PSN : 434524N 0065513E';
		// "434524N 0065513E" starts at 42, length 16
		const r = extractRadiusFromText(text, 42, 58);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(0.2);
		expect(r!.radiusUnit).toBe('NM');
	});

	it('should extract French RAYON : after coordinates', () => {
		const text = 'PSN : 461043N 0064212E\nRAYON : 5NM\nRDL091/18NM LFLI';
		// "461043N 0064212E" starts at 6, length 16
		const r = extractRadiusFromText(text, 6, 22);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(5);
		expect(r!.radiusUnit).toBe('NM');
	});

	it('should extract French DANS UN RAYON DE after coordinates', () => {
		const text = 'PSN : 461620N 0065012E DANS UN RAYON DE 5NM\nRDL046/18NM';
		// "461620N 0065012E" starts at 6, length 16
		const r = extractRadiusFromText(text, 6, 22);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(5);
		expect(r!.radiusUnit).toBe('NM');
	});

	it('should not match RAYON without a separator (e.g. RAYON LASER)', () => {
		const text = 'EMISSION RAYON LASER 3M PSN 482807N 0023803E';
		// "482807N 0023803E" starts at 28, length 16
		const r = extractRadiusFromText(text, 28, 44);
		expect(r).toBe(null);
	});
});

describe('extractAirportAnchor', () => {
	it('parses the plain RDL form', () => {
		expect(extractAirportAnchor('RDL 031/5.4NM ARP LFAI')).toEqual({
			bearing: 31,
			distance: 5.4,
			distanceUnit: 'NM',
			ident: 'LFAI',
		});
	});

	it('parses the label-colon form', () => {
		expect(extractAirportAnchor('RDL : 268DEG/1.24NM ARP LFDB MONTAUBAN')).toEqual({
			bearing: 268,
			distance: 1.24,
			distanceUnit: 'NM',
			ident: 'LFDB',
		});
	});

	it('parses the truncated-DEG form', () => {
		expect(extractAirportAnchor('RDL220DE/0.22NM ARP LFBJ')).toEqual({
			bearing: 220,
			distance: 0.22,
			distanceUnit: 'NM',
			ident: 'LFBJ',
		});
	});

	it('returns null without the ARP ident', () => {
		expect(extractAirportAnchor('RDL046/18NM')).toBe(null);
	});
});

describe('extractRadiusFromText France corpus forms', () => {
	it('parses "RADIUS : <n>" with a colon (W0701/26)', () => {
		const text = 'PSN : 451912N 0032141E\nRADIUS : 1NM';
		expect(extractRadiusFromText(text, 6, 22)).toEqual({
			radius: 1,
			radiusUnit: 'NM',
		});
	});

	it('parses "WITHIN <n> RADIUS" after the coordinate (P3953/25)', () => {
		const text = 'PSN MOY : 480345N 0014301W WITHIN 330M RADIUS';
		expect(extractRadiusFromText(text, 10, 26)).toEqual({
			radius: 330,
			radiusUnit: 'M',
		});
	});

	it('parses "CIRCLE OF <n> RADIUS" after the coordinate (W0227/26)', () => {
		const text =
			"PSN : 461043N 0064212E \nCIRCLE OF 3NM RADIUS RDL091/18NM FM 'ANNEMASSE' AD";
		expect(extractRadiusFromText(text, 6, 22)).toEqual({
			radius: 3,
			radiusUnit: 'NM',
		});
	});

	it('applies the radius-around-name preamble to the PSN (W1654/26)', () => {
		const text =
			"GATHERING OF 50 GLIDERS WITHIN A 5NM RADIUS AROUND 'CHALONS' AD :\n-PSN : 485420N 0042110E";
		const start = text.indexOf('485420N');
		expect(extractRadiusFromText(text, start, start + 16, true)).toEqual({
			radius: 5,
			radiusUnit: 'NM',
		});
	});

	it('parses "CERCLE DE <n> CENTRE SUR" without DE RAYON (R1651/26)', () => {
		const text = 'CERCLE DE 2NM CENTRE SUR 462131N 0063859E';
		const start = text.indexOf('462131N');
		expect(extractRadiusFromText(text, start, start + 16)).toEqual({
			radius: 2,
			radiusUnit: 'NM',
		});
	});

	it('applies "CERCLE DE <n> DE RAYON CENTRE SUR PSN" to the PSN (R2307/26)', () => {
		const text =
			'- PSN : 484033N 0012602E\n1- LIMITES LATERALES :\nCERCLE DE 1NM DE RAYON CENTRE SUR PSN';
		const start = text.indexOf('484033N');
		expect(extractRadiusFromText(text, start, start + 16, true)).toEqual({
			radius: 1,
			radiusUnit: 'NM',
		});
	});

	it('reads the radius of a circle on the PSN before its conversion (R2909/26)', () => {
		for (const text of [
			'CERCLE DE 0.11 NM (200 M) DE RAYON CENTRE SUR PSN : 492747N 0010708E',
			'0.11NM (200M) RADIUS CIRCLE CENTRED ON PSN : 492747N 0010708E',
		]) {
			const start = text.indexOf('492747N');
			expect(extractRadiusFromText(text, start, start + 16, true)).toEqual({
				radius: 0.11,
				radiusUnit: 'NM',
			});
		}
	});

	it('gives a circle named after the PSN to the one PSN alone', () => {
		for (const text of [
			'TREUIL 484500N 0013000E. CERCLE DE 1NM DE RAYON CENTRE SUR PSN',
			'WINCH 484500N 0013000E. 1NM RADIUS CIRCLE CENTRED ON PSN',
		]) {
			const start = text.indexOf('484500N');
			expect(extractRadiusFromText(text, start, start + 16)).toBeNull();
		}
	});

	it('halves the English DIAMETER like the French DIAMETRE (H0343/26)', () => {
		const text = 'PSN : 451111N 0054539E\n- SAFETY AREA : DIAMETER 28 M';
		expect(extractRadiusFromText(text, 6, 22, true)).toEqual({
			radius: 14,
			radiusUnit: 'M',
		});
	});

	it("never leaks an earlier coordinate's radius across it (R1129/26)", () => {
		const text =
			'ARC HORAIRE DE 0.8NM DE RAYON CENTRE SUR 490801N 0042112E,\n490810N 0042000E,';
		const start = text.indexOf('490810N');
		expect(extractRadiusFromText(text, start, start + 16)).toBeNull();
	});
});

describe('radiusToNM', () => {
	it('should return NM as-is', () => {
		expect(radiusToNM(5, 'NM')).toBe(5);
	});

	it('should convert KM to NM', () => {
		expect(radiusToNM(1.852, 'KM')).toBeCloseTo(1.0, 2);
	});

	it('should convert M to NM', () => {
		expect(radiusToNM(1852, 'M')).toBeCloseTo(1.0, 2);
	});
});

describe('a circle named after the PSN in a whole NOTAM', () => {
	const head =
		'R2307/26 NOTAMN\nQ) LFFF/QRTCA/IV/BO/W/000/005/4840N00126E002\nA) LFFF B) 2611210800 C) 2611211700\nE) ';
	const circle =
		'ZONE REGLEMENTEE TEMPO (ZRT) A FONVILLE :\n- PSN : 484033N 0012602E\n1- LIMITES LATERALES :\n' +
		"CERCLE DE 1NM DE RAYON CENTRE SUR PSN\n2- STATUT :\nZRT, QUI LORSQU'ELLE EST ACTIVE, SE SUBSTITUE AUX PORTIONS D'ESPACES";
	function coordinates(e: string) {
		return parseNotams(head + e + '\nF) SFC G) 500FT AMSL').flatMap((n) =>
			n.coordinates.map((c) => ({ at: c.original, radius: c.radius, polygon: n.isPolygon })),
		);
	}

	it('draws the circle of R2307/26 on its PSN', () => {
		expect(coordinates(circle)).toEqual([{ at: '484033N 0012602E', radius: 1, polygon: false }]);
	});

	it('leaves another position of the text its own reading', () => {
		const got = coordinates(circle + '\nTREUIL PLANEURS 484500N 0013000E SUSPENDU');
		expect(got.find((c) => c.at === '484500N 0013000E')?.radius).toBeUndefined();
	});

	it('keeps the vertices of an area an area', () => {
		const got = coordinates(
			circle + '\nPARTIE B : LIMITES LATERALES : 484500N 0012500E - 484600N 0012800E - 484400N 0012900E',
		);
		expect(got.filter((c) => c.polygon).map((c) => c.at)).toEqual([
			'484500N 0012500E',
			'484600N 0012800E',
			'484400N 0012900E',
		]);
	});
});

describe('a radius stated once for the whole text', () => {
	function coordinates(id: string, e: string) {
		const text = `${id} NOTAMN\nQ) LFFF/QOBCE/IV/M/A/000/999/4500N00100E005\nA) LFFF B) 2611210800 C) 2611211700\nE) ${e}\nF) SFC G) UNL`;
		return parseNotams(text).flatMap((n) =>
			n.coordinates.map((c) => ({ at: c.original, radius: c.radius, polygon: n.isPolygon })),
		);
	}

	it('reads the diameter of a circle on its one position (A5567/26)', () => {
		expect(
			coordinates('A5567/26', 'TETHERED WHITE BALLOON WITHIN CIRCLE OF DIAMETER 150M CENTERED AT\n444721N 0202457E (BEOGRAD, ADA CIGANLIJA).'),
		).toEqual([{ at: '444721N 0202457E', radius: 75, polygon: false }]);
	});

	it("leaves a balloon's diameter off its launch site (G0678/26)", () => {
		const got = coordinates(
			'G0678/26',
			'NAVIGATION WARNING.\nFREE LIGHT RED METEOROLOGICAL BALLOON FM PSN:\n511455N 0165823E - LADOWISKO SZYMANOW,\nDIAMETER: 0.8M,\nUPPER LIMIT: 17000FT AMSL.',
		);
		expect(got).toEqual([{ at: '511455N 0165823E', radius: undefined, polygon: false }]);
	});

	it('leaves the vertices of an area their own reading (D6450/26)', () => {
		const got = coordinates(
			'D6450/26',
			'ASCENT OF MET LIGHT FREE BALLOON WILL TAKE PLACE\nWI COORD 383003N 0050200W 391219N 0042142W\n' +
				'393519N 0025514W 394944N 0023322W 383131N 0033122W\n383003N 0050200W EXC CTR LEAO\n' +
				'RMK: TYPE: LIGHT COLOUR: WHITE MAXIMUM DIAMETER: 7.0 M',
		);
		expect(got.length).toBe(5);
		expect(got.every((c) => c.polygon && c.radius === undefined)).toBe(true);
	});

	it('binds the French preamble to the PSN alone', () => {
		const got = coordinates(
			'P1167/26',
			'PSN MOYENNE : 471907N 0020542W - GRUES PRESENTES DANS UN RAYON DE 150M AUTOUR DU PSN.\n' +
				'HAUTEUR : 45M, ALTITUDE AU SOMMET : 120M.\nTREUIL PLANEURS 484500N 0013000E SUSPENDU',
		);
		expect(got.find((c) => c.at === '471907N 0020542W')?.radius).toBe(150);
		expect(got.find((c) => c.at === '484500N 0013000E')?.radius).toBeUndefined();
	});
});
