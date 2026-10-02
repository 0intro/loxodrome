<script lang="ts">
	/* The precipitation radar's map-mounted time strip
	 * (docs/precipitation-radar.md "Map and panels"): play / pause at the left,
	 * the shown frame's UTC time and its age beside it in the age tier's
	 * ink, the close at the right, then a slider over the loop's frames with
	 * a dot per frame held and the two ends labelled as relative ages, and a
	 * notice line only when there is something to say (the feed expired, the
	 * map outside the composite, the loop capped, a fetch error). Two rows on
	 * a phone, one where the strip is wide enough for everything. Every EFB
	 * puts this control at the bottom of the map, so it rides the map's foot
	 * rather than a panel. The 500 ms loop interval lives here and stops with
	 * the strip; pausing returns to the newest frame, which then follows the
	 * arrivals.
	 *
	 * The close FOLDS the strip into a chip at the map's foot, back on the
	 * newest frame, and never switches the layer off (foldRadarStrip): the
	 * chip keeps the frame's time and age on the map, the one reading the
	 * strip existed to show, and a tap on it brings the strip back. */
	import { onDestroy, tick } from 'svelte';
	import Icon from './Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { display } from '$lib/state/display.svelte';
	import {
		radar,
		radarAge,
		radarFeed,
		radarFrameHeld,
		radarLoop,
		foldRadarStrip,
		setRadarPlaying,
		setRadarShownFrame,
		stepRadarFrame,
		unfoldRadarStrip,
	} from '$lib/state/radar.svelte';
	import { OPERA_PRODUCT_INFO, ageMinutes, hhmmZ, slotHHMM } from '$lib/weather/opera';
	import { formatAge } from '$lib/weather/metar';

	const shown = $derived(radar.showOnMap && display.liveWeather);
	const loop = $derived(radarLoop());
	const feed = $derived(radarFeed());
	const frame = $derived(loop.shownIdx >= 0 ? loop.frames[loop.shownIdx] : null);
	const age = $derived(frame ? radarAge(frame) : null);
	const expired = $derived(feed?.staleness === 'expired');
	const canLoop = $derived(loop.frames.length >= 2);
	/** The oldest frame's age relative to the newest, minutes. */
	const spanMin = $derived(
		loop.frames.length >= 2
			? Math.round((loop.frames[loop.frames.length - 1].ms - loop.frames[0].ms) / 60_000)
			: 0,
	);

	function ageText(ms: number): string {
		return formatAge(ageMinutes(ms), t.weather.metar);
	}

	/** What the polite live region announces: the FEED's tier (the newest
	 *  frame's, which moves on the minute tick) and the notices. Never the
	 *  shown frame's time and age, which the play loop changes twice a
	 *  second: wrapped in the region, a screen reader was handed a new
	 *  announcement at every beat for as long as the animation ran. */
	const liveText = $derived(
		expired && feed
			? t.weather.radar.expired({
					time: slotHHMM(feed.newest.t),
					min: OPERA_PRODUCT_INFO[radar.product].staleness.expired,
				})
			: radar.status === 'outside'
				? t.weather.radar.outside
				: radar.status === 'error' && radar.error
					? radar.error()
					: feed
						? t.weather.radar.tierTitle[feed.staleness]
						: '',
	);

	function onSlider(e: Event): void {
		const i = Number((e.currentTarget as HTMLInputElement).value);
		const f = loop.frames[i];
		if (f) {
			setRadarShownFrame(f.t);
		}
	}

	function togglePlay(): void {
		setRadarPlaying(!radar.playing);
	}

	// The loop stops with the strip, whichever half of its gate went false:
	// the layer's own switch stops it (setShowRadarOnMap), and Live weather
	// turned off left it stepping every 500 ms behind the hidden strip, to
	// resume by itself when the weather came back.
	$effect(() => {
		if (!shown && radar.playing) {
			setRadarPlaying(false);
		}
	});

	// The loop: a frame every 500 ms, the newest held three beats, beats
	// skipped while the tab is hidden (nothing renders there).
	$effect(() => {
		if (!radar.playing || !shown) {
			return;
		}
		let hold = 0;
		const id = setInterval(() => {
			if (document.hidden) {
				return;
			}
			if (hold > 0) {
				hold--;
				return;
			}
			const { frames, shownIdx } = radarLoop();
			if (frames.length < 2 || radarFeed()?.staleness === 'expired') {
				// Nothing to step, or nothing drawn: an expired feed's loop
				// stands where it was, so a fresh index resumes in place.
				return;
			}
			if (shownIdx >= frames.length - 1) {
				setRadarShownFrame(frames[0].t);
				return;
			}
			setRadarShownFrame(frames[shownIdx + 1].t);
			if (shownIdx + 1 === frames.length - 1) {
				hold = 2;
			}
		}, 500);
		return () => clearInterval(id);
	});

	// The focus follows a fold: from the close to the chip it leaves, and
	// back, so a keyboard is never dropped on the page's body.
	let closeEl = $state<HTMLButtonElement>();
	let chipEl = $state<HTMLButtonElement>();

	async function fold(): Promise<void> {
		foldRadarStrip();
		await tick();
		chipEl?.focus();
	}

	async function unfold(): Promise<void> {
		unfoldRadarStrip();
		await tick();
		closeEl?.focus();
	}

	onDestroy(() => {
		radar.playing = false;
	});
</script>

{#if shown}
	<!-- Polite: the feed's tier changes and the notices are announced,
	     never interrupting, and never the frame the loop steps through.
	     Outside both forms, so a folded strip still says an expiry. -->
	<span class="sr-only" aria-live="polite">{liveText}</span>
	{#if radar.stripFolded}
		<!-- The folded strip: one button carrying the frame's time and age
		     (the newest, a fold returning to it), its name opening on the
		     words it shows. -->
		<button type="button" class="foot-chip radar-chip no-print" title={t.weather.radar.showStrip} onclick={unfold} bind:this={chipEl}>
			<span class="label">{t.weather.radar.radar}</span>
			{#if frame && age}
				<span class="time">{slotHHMM(frame.t)},</span>
				<span class="age {age.staleness}">{ageText(age.ms)}</span>
				<span class="sr-only">{t.weather.radar.tierTitle[age.staleness]}</span>
			{/if}
			<span class="sr-only">{t.weather.radar.showStrip}</span>
			<Icon name="chevron-up" size={12} />
		</button>
	{:else}
		<div class="radar-strip map-bar no-print" class:expired role="group" aria-label={t.weather.radar.legend}>
			<div class="grid">
				<!-- A loop already running must ALWAYS be stoppable, whichever half of
				     the gate went false: disabled outright, radar.playing stayed true
				     with the interval firing into a withdrawn feed (expiry) or into a
				     view with no frames (panning off the composite), and the animation
				     resumed by itself the moment the gate came back. Starting one is
				     the gated half. -->
				<button
					type="button"
					class="icon-btn play"
					onclick={togglePlay}
					disabled={!radar.playing && (!canLoop || expired)}
					aria-label={radar.playing ? t.weather.pauseAnimation : t.weather.playAnimation}
					title={radar.playing ? t.weather.pauseAnimation : t.weather.playAnimation}
				>
					<Icon name={radar.playing ? 'pause' : 'play'} size={16} />
				</button>
				<div class="readout">
					{#if expired && feed}
						<span class="notice danger">{t.weather.radar.expired({ time: slotHHMM(feed.newest.t), min: OPERA_PRODUCT_INFO[radar.product].staleness.expired })}</span>
					{:else if frame && age}
						<span class="label">{t.weather.radar.radar}</span>
						<span class="time">{slotHHMM(frame.t)}</span>
						<!-- The tier in words beside its ink, so ink alone does not
						     carry it: a title cannot, the strip taking no pointer
						     outside its controls. -->
						<span class="age {age.staleness}">{ageText(age.ms)}</span>
						<span class="sr-only">{t.weather.radar.tierTitle[age.staleness]}</span>
						{#if frame.publishedMs != null}
							<!-- The nominal time is the scan's; the bucket received the
							     frame minutes later, and a pilot judging the age against
							     the clock needs both. -->
							<span class="pub">{t.weather.radar.publishedAt(hhmmZ(frame.publishedMs))}</span>
						{/if}
						{#if !radarFrameHeld(frame.t)}
							<!-- A frame drawn short of its tiles reads as dry where they
							     are missing; the word says the picture is not whole. -->
							<span class="pub">{t.weather.radar.frameLoading}</span>
						{/if}
					{:else if radar.status === 'outside'}
						<span class="notice">{t.weather.radar.outside}</span>
					{:else if radar.status === 'error' && radar.error}
						<span class="notice danger">{radar.error()}</span>
					{:else if radar.status === 'ok'}
						<span class="notice">{t.weather.radar.noFrames}</span>
					{:else}
						<span class="notice">{t.weather.radar.loading}</span>
					{/if}
				</div>
				{#if canLoop && !expired}
					<button type="button" class="icon-btn step back" onclick={() => stepRadarFrame(-1)} aria-label={t.weather.radar.stepBack} title={t.weather.radar.stepBack}>
						<Icon name="chevron-left" size={16} />
					</button>
					<!-- The dots and the two ends are drawn inside the slider's own
					     box, under its track (the replay ticks' idiom), so they cost
					     no line of the strip. -->
					<div class="slider">
						<input
							type="range"
							min="0"
							max={loop.frames.length - 1}
							step="1"
							value={loop.shownIdx}
							oninput={onSlider}
							aria-label={t.weather.radar.scrubAria}
							aria-valuetext={frame && age ? `${slotHHMM(frame.t)}, ${ageText(age.ms)}` : undefined}
						/>
						<div class="dots" aria-hidden="true">
							{#each loop.frames as f, i (f.t)}
								<span class="dot" class:held={radarFrameHeld(f.t)} class:on={i === loop.shownIdx}></span>
							{/each}
						</div>
						<div class="ends" aria-hidden="true">
							<span>{t.weather.radar.relAge(spanMin)}</span>
							<span>{t.weather.radar.now}</span>
						</div>
					</div>
					<button type="button" class="icon-btn step fwd" onclick={() => stepRadarFrame(1)} aria-label={t.weather.radar.stepForward} title={t.weather.radar.stepForward}>
						<Icon name="chevron-right" size={16} />
					</button>
				{/if}
				<button
					type="button"
					class="icon-btn close map-bar-close"
					onclick={fold}
					bind:this={closeEl}
					aria-label={t.weather.radar.hideStrip}
					title={t.weather.radar.hideStrip}
				>
					<Icon name="x" size={16} />
				</button>
				{#if loop.capped && radar.frameCap != null && !expired}
					<div class="notice small extra">{t.weather.radar.loopCapped(radar.frameCap)}</div>
				{/if}
				{#if frame && radar.status === 'error' && radar.error}
					<!-- The readout keeps the frame and its age; the failure behind
					     it (a frame refused, the proxy busy) is said beneath, so the
					     tab is not the only place a pilot reads it. -->
					<div class="notice small danger extra">{radar.error()}</div>
				{/if}
			</div>
		</div>
	{/if}
{/if}

<style>
	/* A line of the map's foot (MapView .map-foot), which places it: above
	   the replay strip, the corner column and the credit standing on the
	   foot's one published height. Its chrome is the map's bar family
	   (app.css .map-bar): no text to select (a thumb resting on the readout
	   in a mount raised Android's selection handles over the map) and no
	   pointer target, only its controls take the pointer.

	   Its own width decides its form, never its content (a container query
	   styles what is inside the container, hence the inner grid). Two rows
	   where the strip is narrow, a portrait phone's: play, the readout and
	   the close over the slider between its step buttons, which stand under
	   play and the close. */
	.radar-strip {
		position: relative;
		flex: 1 0 100%;
		min-width: 0;
		padding: 2px;
	}

	/* Screen only, like every container here: containment must never touch
	   a print flow. */
	@media screen {
		.radar-strip {
			container: radar-strip / inline-size;
		}
	}

	.grid {
		display: grid;
		grid-template-areas:
			'play readout close'
			'back slider fwd'
			'extra extra extra';
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 0 4px;
		align-items: center;
	}

	/* One row where it fits everything, a landscape phone's or a desktop's.
	   After the rule above, which it overrides at the same specificity. */
	@container radar-strip (min-width: 500px) {
		.grid {
			grid-template-areas:
				'play readout back slider fwd close'
				'extra extra extra extra extra extra';
			grid-template-columns: auto minmax(0, max-content) auto minmax(120px, 1fr) auto auto;
		}

		.readout {
			max-width: 16em;
		}
	}

	.play {
		grid-area: play;
	}

	.readout {
		display: flex;
		flex-wrap: wrap;
		grid-area: readout;
		gap: 0 6px;
		align-items: baseline;
		min-width: 0;
		padding: 0 4px;
		white-space: nowrap;
	}

	.close {
		grid-area: close;
	}

	.back {
		grid-area: back;
	}

	.fwd {
		grid-area: fwd;
	}

	.extra {
		grid-area: extra;
		padding: 0 6px 2px;
	}

	.label,
	.time {
		font-weight: 600;
	}

	.age,
	.pub {
		color: var(--text-muted);
	}

	.pub {
		font-size: 11px;
	}

	/* The age tiers (DBZH 15 / 20 / 30 min, RATE 30 / 35 / 45): normal ink
	   under the first, the advisory orange from it, the danger red from the
	   second; at the third the feed is expired and the notice replaces the
	   readout (docs/precipitation-radar.md "The age policy"). The chip wears
	   the same inks. */
	.age.aging {
		color: var(--workbook-orange);
	}

	.age.stale,
	.age.expired {
		color: var(--danger);
	}

	.notice {
		color: var(--text-muted);
		white-space: normal;
	}

	.notice.danger {
		color: var(--danger);
	}

	.notice.small {
		font-size: 11px;
	}

	.step {
		color: var(--text-muted);
	}

	/* The slider's box carries the dots and the two ends under its track: the
	   input fills it, its track lifted by a bottom padding the marks draw in,
	   so the whole box is still the input's to take a finger. */
	.slider {
		position: relative;
		grid-area: slider;
		min-width: 0;
		height: 38px;
	}

	.slider input[type='range'] {
		box-sizing: border-box;
		display: block;
		width: 100%;
		height: 100%;
		padding: 0 0 18px;
		margin: 0;
		accent-color: var(--accent);
	}

	.dots,
	.ends {
		position: absolute;
		right: 0;
		left: 0;
		display: flex;
		justify-content: space-between;
		pointer-events: none;
	}

	.dots {
		bottom: 13px;
		padding: 0 6px;
	}

	.dot {
		width: 4px;
		height: 4px;
		background: var(--border-strong);
		border-radius: 50%;
	}

	.dot.held {
		background: var(--text-muted);
	}

	.dot.on {
		background: var(--accent);
	}

	.ends {
		bottom: 0;
		font-size: 10px;
		line-height: 12px;
		color: var(--text-muted);
	}

	/* The one control a stray tap in turbulence lands on: the whole 44 px
	   floor, since Chromium moves the thumb to the touch point and a brushed
	   track would pin the picture to an old frame (the recording's own
	   return to the newest is in radar.svelte.ts fetchIndex). The touch floor
	   rides the app's one in-flight class (a coarse pointer or a running
	   recording), never a media query of this component's own; the icon
	   buttons take theirs from app.css. */
	:global(:root.touch-ui) .slider {
		height: 44px;
	}

	.radar-chip .label,
	.radar-chip .time {
		font-weight: 600;
	}
</style>
