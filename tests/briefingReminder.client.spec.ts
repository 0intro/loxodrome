/* The Android reminder at the RTBA release (state/briefingReminder.svelte.ts,
 * run by BriefingHost as an effect): set for the release while the verdict
 * waits for it, once, in the locale in force, kept past the release while
 * the reason stands, taken back with the reason, the switch or the
 * permission, and asked for from the notice. The native seam and the
 * verdict are faked: a mock registered with vi.mock outlives
 * vi.resetModules, and would hand every case the first case's state, so
 * the briefing module's is registered again in each (vi.doMock). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { fake as Fake } from './helpers/reminderFake.svelte';

interface Env {
	native: boolean;
	/** What the plugin reads, and answers after its question. */
	permission: string | null;
	answer: string | null;
	log: unknown[][];
	fake: typeof Fake | null;
	/** The planned flight's window's end. */
	plannedTo: number;
}
const env: Env = vi.hoisted(() => ({ native: true, permission: 'granted', answer: 'granted', log: [], fake: null, plannedTo: 0 }));

vi.mock('$lib/native/platform', () => ({ isNativeApp: () => env.native }));
vi.mock('$lib/native/reminder', () => ({
	reminderPermission: () => Promise.resolve(env.permission),
	requestReminderPermission: () => Promise.resolve(env.answer),
	scheduleReminder: (note: unknown) => {
		env.log.push(['schedule', note]);
		return Promise.resolve();
	},
	cancelReminder: () => {
		env.log.push(['cancel']);
		return Promise.resolve();
	},
}));

const MIN = 60_000;
const DAY = Date.UTC(2026, 10, 25);
const RELEASE = Date.UTC(2026, 10, 24, 17, 30);
const rtba = () => [{ code: 'rtba' as const, dayMs: DAY, releaseMs: RELEASE }];
const NOTE = {
	atMs: RELEASE,
	title: 'RTBA activity published',
	text: 'RTBA activity for 2026-11-25 is published. Open the app to refresh the NOTAM briefing.',
	channel: 'NOTAM briefing reminders',
};

async function setup(nowMs: number) {
	vi.setSystemTime(nowMs);
	const { flushSync } = await import('svelte');
	const reminder = await import('$lib/state/briefingReminder.svelte');
	const { briefingWatch } = await import('$lib/state/briefing.svelte');
	const { display } = await import('$lib/state/display.svelte');
	const { i18n } = await import('$lib/state/i18n.svelte');
	const { fake } = await import('./helpers/reminderFake.svelte');
	const { mountEffect } = await import('./helpers/derivedHost.svelte');
	const { nav } = await import('$lib/state/navRecording.svelte');
	env.fake = fake;
	i18n.locale = 'en';
	display.autoNotams = true;
	fake.reasons = rtba();
	briefingWatch.restored = true;
	await reminder.readReminderPermission();
	const effect = mountEffect(() => reminder.syncBriefingReminder());
	flushSync();
	return { flushSync, reminder, briefingWatch, display, i18n, fake, effect, nav };
}

beforeEach(() => {
	vi.resetModules();
	vi.doMock('$lib/state/briefing.svelte', async (importOriginal) => {
		const real = await importOriginal<typeof import('$lib/state/briefing.svelte')>();
		return {
			...real,
			briefingVerdictNow: () => ({ reasons: env.fake?.reasons ?? [] }),
			briefingReplaceable: () => env.fake?.replaceable ?? true,
			briefingSourceReady: () => env.fake?.sourceReady ?? true,
		};
	});
	vi.doMock('$lib/state/timeWindow.svelte', async (importOriginal) => ({
		...(await importOriginal<typeof import('$lib/state/timeWindow.svelte')>()),
		plannedFlightAt: () => ({ fromMs: env.plannedTo - 2 * 3_600_000, toMs: env.plannedTo }),
	}));
	vi.useFakeTimers({ toFake: ['Date'] });
	env.native = true;
	env.permission = 'granted';
	env.answer = 'granted';
	env.log = [];
	env.plannedTo = DAY + 11 * 3_600_000;
});
afterEach(() => {
	vi.useRealTimers();
});

describe('the reminder at the RTBA release', () => {
	it('is set once for the release, in the locale in force', async () => {
		const s = await setup(RELEASE - 3 * 60 * MIN);
		expect(env.log).toEqual([['schedule', NOTE]]);
		s.fake.reasons = rtba();
		s.flushSync();
		expect(env.log).toHaveLength(1);
		s.i18n.locale = 'fr';
		s.flushSync();
		expect(env.log[1]).toEqual([
			'schedule',
			{
				atMs: RELEASE,
				title: 'Activité réelle du RTBA diffusée',
				text: 'L’activité réelle du RTBA du 2026-11-25 est diffusée. Ouvrez l’application pour actualiser le briefing NOTAM.',
				channel: 'Rappels du briefing NOTAM',
			},
		]);
		s.i18n.locale = 'en';
		s.effect.stop();
	});

	it('stands past the release while the reason does, and goes with it', async () => {
		const s = await setup(RELEASE - 10 * MIN);
		vi.setSystemTime(RELEASE + 5 * MIN);
		s.fake.reasons = rtba();
		s.flushSync();
		expect(env.log).toEqual([['schedule', NOTE]]);
		s.fake.reasons = [];
		s.flushSync();
		expect(env.log).toEqual([['schedule', NOTE], ['cancel']]);
		s.effect.stop();
	});

	it('takes back, once, a release passed before this session', async () => {
		const s = await setup(RELEASE + 60 * MIN);
		s.fake.reasons = rtba();
		s.flushSync();
		expect(env.log).toEqual([['cancel']]);
		s.effect.stop();
	});

	it('is taken back with the switch, or where the app would not fetch by itself', async () => {
		const s = await setup(RELEASE - 60 * MIN);
		s.display.autoNotams = false;
		s.flushSync();
		expect(env.log).toEqual([['schedule', NOTE], ['cancel']]);
		s.display.autoNotams = true;
		s.fake.replaceable = false;
		s.flushSync();
		expect(env.log).toHaveLength(2);
		s.effect.stop();
	});

	it('waits for the plan’s restore and the permission, and asks for it from the notice', async () => {
		env.permission = null;
		const s = await setup(RELEASE - 60 * MIN);
		expect(env.log).toEqual([]);
		env.permission = 'prompt';
		s.briefingWatch.restored = false;
		await s.reminder.readReminderPermission();
		s.flushSync();
		expect(env.log).toEqual([]);
		s.briefingWatch.restored = true;
		s.flushSync();
		expect(env.log).toEqual([['cancel']]);
		await s.reminder.askReminderPermission();
		s.flushSync();
		expect(env.log).toEqual([['cancel'], ['schedule', NOTE]]);
		s.effect.stop();
	});

	it('is for the planned flight alone, on the ground', async () => {
		const s = await setup(RELEASE - 60 * MIN);
		s.nav.recording = true;
		s.flushSync();
		expect(env.log).toEqual([['schedule', NOTE], ['cancel']]);
		s.nav.recording = false;
		s.flushSync();
		expect(env.log).toHaveLength(3);
		s.effect.stop();
		vi.resetModules();
		env.log = [];
		env.plannedTo = RELEASE - 120 * MIN;
		const late = await setup(RELEASE - 60 * MIN);
		expect(env.log).toEqual([['cancel']]);
		late.effect.stop();
	});

	it('keeps the reminder handed past its release, a language changed since', async () => {
		const s = await setup(RELEASE - 10 * MIN);
		vi.setSystemTime(RELEASE + 5 * MIN);
		s.i18n.locale = 'fr';
		s.flushSync();
		expect(env.log).toEqual([['schedule', NOTE]]);
		s.i18n.locale = 'en';
		s.effect.stop();
	});

	it('says a refused ask until the permission is granted', async () => {
		env.permission = 'prompt';
		env.answer = 'denied';
		const s = await setup(RELEASE - 60 * MIN);
		await s.reminder.askReminderPermission();
		expect(s.reminder.briefingReminder).toEqual({ permission: 'denied', refused: true });
		env.permission = 'granted';
		await s.reminder.readReminderPermission();
		s.flushSync();
		expect(s.reminder.briefingReminder).toEqual({ permission: 'granted', refused: false });
		expect(env.log.at(-1)).toEqual(['schedule', NOTE]);
		s.effect.stop();
	});

	it('does nothing on the web', async () => {
		env.native = false;
		const s = await setup(RELEASE - 60 * MIN);
		expect(env.log).toEqual([]);
		s.effect.stop();
	});
});
