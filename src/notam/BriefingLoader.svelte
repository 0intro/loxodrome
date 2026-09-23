<script lang="ts">
	/* How this app gets a briefing: paste it, open it, or ask for one by
	 * aerodrome.
	 *
	 * Loxodrome's own loader offers a viewport fetch and a route fetch, and
	 * needs a map viewport and a route workspace to do it. This app has
	 * neither, so it asks the question a NOTAM viewer's user can answer: which
	 * aerodromes. The briefing then covers those and the FIRs they sit in.
	 *
	 * Both sources are offered, on the app's own persisted choice
	 * (state/notamSource.svelte.ts, shared with Loxodrome). SOFIA is anonymous
	 * and French; autorouter covers Europe. Neither needs credentials here:
	 * the proxy holds them.
	 */
	import Segmented from '$lib/components/Segmented.svelte';
	import { fetchNotamsForIdents } from '$lib/autorouter/fetch';
	import { autorouter } from '$lib/autorouter/state.svelte';
	import { briefFromSofia } from '$lib/sofia/fetch';
	import { sofia } from '$lib/sofia/state.svelte';
	import { i18n, t } from '$lib/state/i18n.svelte';
	import {
		activeEvalWindow,
		clearNotams,
		notamState,
		parseInput,
	} from '$lib/state/notam.svelte';
	import { notamFetchBusy, notamSource, setNotamSource } from '$lib/state/notamSource.svelte';
	import { pickerAccept } from '$lib/ui/filePicker';
	import { DEFAULT_CORRIDOR_RADIUS_NM } from '$lib/route/notamCorridor';
	import { parseIdentList } from './identList';

	let { onLoaded, onGaps }: { onLoaded?: () => void; onGaps?: () => void } = $props();

	let idents = $state('');
	let uploadError = $state<string | null>(null);
	let pasteError = $state<string | null>(null);
	let pasteDetail = $state<string | null>(null);
	let pasteBox = $state<HTMLTextAreaElement>();

	const parsed = $derived(parseIdentList(idents));
	const busy = $derived(notamFetchBusy());
	const count = $derived(notamState.notams.length);
	const fetchError = $derived(
		notamSource.source === 'sofia' ? sofia.error : autorouter.error,
	);
	// The E-item language a SOFIA briefing comes back in follows the UI, which
	// is what makes a French-language reader's bulletin French.
	void i18n.locale;

	/** Run a load and, when it produced a whole briefing, hand the panel to the
	 *  list. A failure keeps this view so the error stays under the control
	 *  that raised it; a briefing short of what was asked keeps it too, since
	 *  what it missed is stated right here. Loxodrome's own rule, and the
	 *  parsedAt identity test is why: an UNCHANGED stamp means the action
	 *  produced no briefing at all, where the count alone would see the
	 *  PREVIOUS one and carry this click's error off screen. */
	async function run(action: () => void | Promise<void>): Promise<void> {
		const parsedBefore = notamState.parsedAt;
		await action();
		if (notamState.parsedAt === parsedBefore || notamState.notams.length === 0) {
			return;
		}
		if (notamState.gaps) {
			onGaps?.();
		} else {
			onLoaded?.();
		}
	}

	async function fetchBriefing(): Promise<void> {
		if (busy) {
			return;
		}
		await run(async () => {
			if (notamSource.source === 'autorouter') {
				await fetchNotamsForIdents(parsed.idents);
				return;
			}
			if (parsed.idents.length === 0) {
				sofia.error = () => t.errors.needAerodrome;
				return;
			}
			// SOFIA reads the first and last route[] tokens as the PIB's
			// departure and destination aerodromes, so a single ident is sent
			// twice: [LFPN, LFPN] is its own aerodrome-PIB shape, and
			// narrowRouteTokens would otherwise hand it a one-token route.
			const points = parsed.idents.map((token) => ({ token, aerodrome: true }));
			await briefFromSofia(
				[
					{
						label: parsed.idents.join(' '),
						points: points.length === 1 ? [points[0], points[0]] : points,
					},
				],
				{
					// The SAME corridor the flight app briefs, because the
					// question is the same one: what is between these
					// aerodromes. SOFIA scans radiusAD (10 NM, its own default)
					// around each aerodrome in the track AND corridors this
					// half-width along the legs between them, so a narrow value
					// here would quietly drop the en-route half of a briefing
					// the reader asked for by naming two fields.
					widthNM: DEFAULT_CORRIDOR_RADIUS_NM,
					window: activeEvalWindow(),
					kind: 'aerodromes',
				},
			);
		});
	}

	// The read is the step that fails on Android (the chooser hands back a
	// content URI a provider can refuse), and an unguarded one rejects into
	// nowhere, which reads as the app ignoring the file.
	async function onUpload(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) {
			return;
		}
		uploadError = null;
		try {
			notamState.rawText = await file.text();
			parseInput();
		} catch (err) {
			uploadError = err instanceof Error ? err.message : String(err);
		}
		input.value = '';
	}

	/** The Paste button. On a phone this is the main way in, so a refusal is
	 *  SAID, and said in a way the reader can act on.
	 *
	 *  Measured on a Redmi running Android 14 and Chrome 152: readText is
	 *  permission-gated there and answers "Read permission denied" outright,
	 *  which is the common case rather than the edge one. Firefox for Android
	 *  does not implement readText at all. So the button cannot be the only
	 *  way in, and when it fails the honest thing is to name the box that
	 *  always works and put the caret in it. Loxodrome's own version swallows
	 *  the rejection, which on a touch device reads as a dead button.
	 *
	 *  The raw wire message rides underneath in English (docs/i18n.md rule 7);
	 *  the INSTRUCTION is the app's own sentence and is translated. */
	async function onPaste(): Promise<void> {
		pasteError = null;
		pasteDetail = null;
		try {
			notamState.rawText = await navigator.clipboard.readText();
		} catch (err) {
			pasteError = t.viewer.pasteRefused;
			pasteDetail = err instanceof Error ? err.message : String(err);
			pasteBox?.focus();
		}
	}

	function onClear(): void {
		clearNotams();
		autorouter.error = null;
		sofia.error = null;
		sofia.errorDetail = null;
		pasteError = null;
		pasteDetail = null;
		uploadError = null;
	}
</script>

<div class="loader">
	<fieldset class="group">
		<legend>{t.viewer.aerodromes}</legend>
		<Segmented
			options={[
				{ value: 'sofia', label: 'SOFIA-Briefing' },
				{ value: 'autorouter', label: 'autorouter' },
			]}
			value={notamSource.source}
			onSelect={(v) => setNotamSource(v as 'sofia' | 'autorouter')}
			ariaLabel={t.viewer.sourceLegend}
		/>
		<input
			class="search ident-field"
			type="text"
			autocapitalize="characters"
			autocomplete="off"
			spellcheck="false"
			enterkeyhint="go"
			aria-label={t.viewer.aerodromes}
			placeholder="LFPL LFPK LFFZ LFQB"
			bind:value={idents}
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					void fetchBriefing();
				}
			}}
		/>
		<button
			class="btn primary fetch-btn"
			disabled={busy || parsed.idents.length === 0}
			title={t.viewer.fetchBriefingTip}
			onclick={() => void fetchBriefing()}
		>
			{busy ? t.input.fetching : t.viewer.fetchBriefing}
		</button>
		{#if parsed.rejected.length > 0}
			<p class="warn" role="alert">
				{t.viewer.unknownIdents({ words: parsed.rejected.join(', ') })}
			</p>
		{/if}
		{#if fetchError}
			<p class="error" role="alert">{fetchError()}</p>
		{/if}
		{#if notamSource.source === 'sofia' && sofia.errorDetail}
			<p class="muted small" lang="en">{sofia.errorDetail}</p>
		{/if}
	</fieldset>

	<fieldset class="group paste">
		<legend>{t.input.launchPaste}</legend>
		<div class="ext-links">
			<a
				class="ext-link"
				href="https://sofia-briefing.aviation-civile.gouv.fr/"
				target="_blank"
				rel="noopener noreferrer"
				title={t.input.sofiaLinkTip}
			>{t.input.sofiaLink}</a>
			<a
				class="ext-link"
				href="https://www.autorouter.aero/"
				target="_blank"
				rel="noopener noreferrer"
				title={t.input.autorouterLinkTip}
			>{t.input.autorouterLink}</a>
		</div>
		<textarea
			class="notam-input"
			bind:this={pasteBox}
			bind:value={notamState.rawText}
			placeholder={t.input.pastePlaceholder}
			spellcheck="false"
		></textarea>
		<div class="actions">
			<button class="btn primary" onclick={() => void run(parseInput)}>
				{t.input.displayOnMap}
			</button>
			<label class="btn file">
				{t.input.upload}
				<input type="file" accept={pickerAccept('.txt')} onchange={onUpload} />
			</label>
			<button class="btn" onclick={() => void onPaste()}>{t.input.paste}</button>
		</div>
		{#if uploadError}
			<p class="error" role="alert" lang="en">{uploadError}</p>
		{/if}
		{#if pasteError}
			<p class="error" role="alert">{pasteError}</p>
			{#if pasteDetail}
				<p class="muted small" lang="en">{pasteDetail}</p>
			{/if}
		{/if}
	</fieldset>

	{#if count > 0}
		<div class="status">
			<p class="muted small">{t.input.plotted(count)}</p>
			<button class="btn" onclick={onClear}>{t.input.clear}</button>
		</div>
	{/if}

</div>

<style>
	/* No padding and no scroller of its own: the panel body owns both, so the
	 * loader and the list get the same air and the same scrollbar. */
	.loader {
		display: flex;
		flex-direction: column;
		gap: 12px;

		/* The card may SHRINK to the panel it is given. A flex item's automatic
		   minimum is its own content, so without this the card keeps its full
		   height and the panel simply scrolls, which is the whole bug. */
		min-block-size: 0;
	}

	/* The one section that gives. The aerodromes fieldset keeps its automatic
	   minimum, so the shrink lands here rather than squashing the idents field
	   and its button; inside, the only child with a floor low enough to absorb
	   it is the paste box. */
	.loader .group.paste {
		min-block-size: 0;
	}

	/* The sections stack their own children: a fieldset lays out as blocks and
	   the hint paragraphs carry no margin, so without this the field sits flush
	   against the source pill above it and the button flush against the box.
	   Loxodrome's own loader carries the same rule. */
	.loader .group {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	/* The source pill hugs its options: a flex child stretches by default, and
	   a full-width segmented control reads as a tab bar. */
	.loader .group :global(.seg) {
		align-self: flex-start;
	}

	/* Full width, because the idents are what the reader is looking at; the
	   button takes its own line under it rather than eating the box. */
	.ident-field {
		inline-size: 100%;
		min-inline-size: 0;
		text-transform: uppercase;
	}

	.fetch-btn {
		align-self: flex-start;
	}

	.ext-links {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.notam-input {
		inline-size: 100%;

		/* THE BOX TAKES WHAT IS LEFT, between a cap and a floor.

		   420px is the SIZE and so the CAP: on a screen with room to spare the
		   box stops here rather than growing to fill, which keeps a very large
		   window from showing a paste box the size of a page. It was a fixed
		   FLOOR, which is precisely the thing a layout may not shrink, so the
		   card grew instead of the box giving way: measured on the device at
		   392x766, the card ran 97px past the panel's scroller and the whole
		   actions row, Display on map included, sat 43px below the fold.

		   140px is the floor, about nine lines of the mono face, so a very
		   small screen keeps a paste box worth the name and scrolls for the
		   rest rather than a fitting card with a useless box in it.

		   Between the two the box simply SHRINKS, which it can do because
		   NotamsTab hands the card a definite height while the loader is up.
		   Nothing here is measured against the rest of the card: a share of
		   the screen and a hand-fitted offset were both tried and are the same
		   mistake in different clothes, a number standing in for a height the
		   layout can work out for itself. `resize` stays the reader's to
		   drag. */
		block-size: 420px;
		min-block-size: 140px;
		resize: vertical;
		font-family: var(--font-mono, monospace);
		font-size: var(--fs-xs);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.file input {
		display: none;
	}

	.status {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
</style>
