/* Where each print is asked for, read from the sources (the printReview
 * precedent): the flight dossier from the toolbar's printer, a one-row menu
 * on desktop and a row of the app menu on a phone, each with the line saying
 * which charts it would print, and the workbook's four pages from its own
 * printer, the shell's pinned one. The packs print from the host App mounts
 * whatever is open. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const toolbar = read('src/lib/components/Toolbar.svelte');
const prep = read('src/lib/components/FlightPrepModal.svelte');

describe('the flight dossier', () => {
	it('is the toolbar printer\'s one record', () => {
		const at = toolbar.indexOf('const dossierAction: ToolbarAction = $derived({');
		expect(at).toBeGreaterThan(-1);
		const record = toolbar.slice(at, toolbar.indexOf('});', at));
		expect(record).toContain("run: () => requestPackPrint('dossier'),");
		expect(record).toContain('disabled: printBusy() || printableRoutes.length === 0,');
		expect(toolbar).not.toContain('exportMapPdf');
	});

	it('opens a one-row menu on desktop, the chart line under its row', () => {
		expect(toolbar).toMatch(/onclick=\{openPrintMenu\}\s+disabled=\{dossierAction\.disabled\}/);
		const at = toolbar.indexOf('open={printMenuOpen}');
		expect(at).toBeGreaterThan(-1);
		const menu = toolbar.slice(at, toolbar.indexOf('</HeadOverlay>', at));
		expect(menu.match(/<button/g)).toHaveLength(1);
		expect(menu).toContain('dossierAction.run();');
		expect(menu).toContain('<ChartsReadiness routes={printableRoutes} />');
	});

	it('is a row of the phone app menu once a route can print, the chart line under it', () => {
		expect(toolbar).toContain('...(printableRoutes.length > 0 ? [dossierAction] : []),');
		expect(toolbar).toMatch(/\{#if a\.id === 'dossier' && showReadiness\}\s*<ChartsReadiness routes=\{printableRoutes\} \/>/);
	});

	it('promises a NOTAM fetch only where the print makes one, never for a flight already flown', () => {
		// The print asks SOFIA nothing for a flight already behind us
		// (PackPrintHost's `past`), as the chart line says of its charts.
		const line = read('src/lib/components/flightprep/BriefingReadiness.svelte');
		expect(line).toContain('briefingWanted(now, v) && briefingSourceReady() && briefingWatch.online && !pastFlight(now)');
	});

	it('prints from the host App mounts, beside the weather briefing\'s', () => {
		expect(read('src/App.svelte')).toMatch(/<WxPrintHost \/>\s*<PackPrintHost \/>/);
	});
});

describe('the workbook\'s printer', () => {
	it('prints the four pages at a press, and leaves the rest to their doors', () => {
		expect(prep).toContain('actionsIcon="printer"');
		expect(prep).toContain('actionsLabel={t.flightprep.printPrep}');
		expect(prep).toContain("onPrint={() => requestPackPrint('prep')}");
		expect(prep).not.toContain('{#snippet actions(');
		expect(prep).not.toContain('printSurface(');
		expect(prep).not.toContain("requestPackPrint('dossier')");
		expect(prep).not.toContain('requestWxPrint');
		expect(prep).not.toContain('ChartsReadiness');
	});

	it('is the shell\'s pinned button, pressed directly and standing down while a print is busy', () => {
		const shell = read('src/lib/components/SurfaceShell.svelte');
		expect(shell).toContain("const directPrint = $derived(!actions && actionsIcon === 'printer' ? onPrint : undefined);");
		expect(shell).toContain('{#if actions || directPrint}');
		expect(shell).toContain('aria-expanded={actions ? actionsOpen : undefined}');
		expect(shell).toContain('disabled={!!directPrint && printBusy()}');
		expect(shell).toContain('onclick={directPrint ?? openActions}');
	});
});
