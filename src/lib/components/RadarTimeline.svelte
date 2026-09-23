<script lang="ts">
	/* The precipitation radar's map-mounted time strip
	 * (docs/precipitation-radar.md "Map and panels"): play / pause at the left,
	 * the shown frame's UTC time and its age beside it in the age tier's
	 * ink, a slider over the loop's frames with a dot per frame held, the
	 * two ends labelled as relative ages, and a notice line only when there
	 * is something to say (the feed expired, the map outside the composite,
	 * the loop capped, a fetch error). Every EFB puts this control at the
	 * bottom of the map, so this rides the map beside the cursor badge and
	 * the phone's map buttons rather than a panel. The 500 ms loop interval
	 * lives here and stops with the strip; pausing returns to the newest
	 * frame, which then follows the arrivals. */
	import { onDestroy } from 'svelte';
	import Icon from './Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { display } from '$lib/state/display.svelte';
	import {
		radar,
		radarAge,
		radarFeed,
		radarFrameHeld,
		radarLoop,
		setRadarPlaying,
		setRadarShownFrame,
		stepRadarFrame,
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

	// The strip's height, published for what stands above it: the phone's
	// corner credit (app.css --radar-strip-h; Leaflet's attribution control
	// is z 1000 over the strip's 470 and, unfolded for its five seconds at
	// each attach, sat on the strip's right end on a 392 px phone), and on
	// every layout the map's bottom-left column, whose terrain legend the
	// strip covered on a map narrower than about 900 px.
	let stripH = $state(0);
	$effect(() => {
		const h = shown ? stripH : 0;
		document.documentElement.style.setProperty('--radar-strip-h', `${h}px`);
		return () => document.documentElement.style.removeProperty('--radar-strip-h');
	});

	onDestroy(() => {
		radar.playing = false;
	});
</script>

{#if shown}
	<div class="radar-strip no-print" class:expired role="group" aria-label={t.weather.radar.legend} bind:clientHeight={stripH}>
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
		<div class="body">
			<!-- Polite: the feed's tier changes and the notices are announced,
			     never interrupting, and never the frame the loop steps through. -->
			<span class="sr-only" aria-live="polite">{liveText}</span>
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
				<div class="track">
					<button type="button" class="step" onclick={() => stepRadarFrame(-1)} aria-label={t.weather.radar.stepBack} title={t.weather.radar.stepBack}>
						<Icon name="chevron-left" size={14} />
					</button>
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
					<button type="button" class="step" onclick={() => stepRadarFrame(1)} aria-label={t.weather.radar.stepForward} title={t.weather.radar.stepForward}>
						<Icon name="chevron-right" size={14} />
					</button>
				</div>
			{/if}
			{#if loop.capped && radar.frameCap != null && !expired}
				<div class="notice small">{t.weather.radar.loopCapped(radar.frameCap)}</div>
			{/if}
			{#if frame && radar.status === 'error' && radar.error}
				<!-- The readout keeps the frame and its age; the failure behind
				     it (a frame refused, the proxy busy) is said beneath, so the
				     tab is not the only place a pilot reads it. -->
				<div class="notice small danger">{radar.error()}</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* Bottom centre of the map, above the attribution's line and clear of
	   the cursor badge at the left and the phone's map buttons at the right.
	   The Leaflet container already shrinks for a docked pane, so the strip
	   stays above it. Same z as the map buttons; under the sidebar's 500. */
	.radar-strip {
		position: absolute;
		left: 50%;
		bottom: max(10px, var(--sab, 0px));
		z-index: 470;
		display: flex;
		align-items: center;
		gap: 8px;
		width: max-content;
		max-width: min(92%, 440px);
		padding: 6px 10px 6px 6px;
		font-size: 12px;
		line-height: 1.3;
		color: var(--text);
		background: color-mix(in srgb, var(--surface) 92%, transparent);
		border: 1px solid var(--border-strong);
		border-radius: 10px;
		box-shadow: var(--shadow-1);
		transform: translateX(-50%);
		font-variant-numeric: tabular-nums;

		/* Not text to select: a thumb resting on the readout in a mount raised
		   Android's selection handles and its Copy / Share bar over the map
		   (the band declares the same). And a pan that starts on the box goes
		   to the map: only the controls take the pointer. */
		user-select: none;
		-webkit-touch-callout: none;
		pointer-events: none;
	}

	.play,
	.step,
	.slider {
		pointer-events: auto;
	}

	/* The phone layout keeps the map above the safe-area inset already (the
	   bar in flow, the landscape column's padding), so the strip needs none
	   of its own there. */
	:global(:root.mobile-ui) .radar-strip {
		bottom: 10px;
	}

	.play {
		width: 36px;
		height: 36px;
		flex: 0 0 auto;
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.readout {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0 6px;
		white-space: nowrap;
	}

	.label {
		font-weight: 600;
	}

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
	   readout (docs/precipitation-radar.md "The age policy"). */
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

	.track {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		color: var(--text-muted);
		background: transparent;
		border: 0;
		border-radius: 4px;
		cursor: pointer;
	}

	.step:hover {
		color: var(--text);
		background: var(--surface-2);
	}

	.slider {
		display: flex;
		flex-direction: column;
		gap: 1px;
		width: 220px;
		max-width: 50vw;
	}

	.slider input[type='range'] {
		width: 100%;
		margin: 0;
		accent-color: var(--accent);
	}

	.dots {
		display: flex;
		justify-content: space-between;
		padding: 0 6px;
	}

	.dot {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--border-strong);
	}

	.dot.held {
		background: var(--text-muted);
	}

	.dot.on {
		background: var(--accent);
	}

	.ends {
		display: flex;
		justify-content: space-between;
		font-size: 10px;
		color: var(--text-muted);
	}

	/* The touch floor rides the app's one in-flight class (a coarse pointer
	   or a running recording), never a media query of this component's own. */
	:global(:root.touch-ui) .play {
		width: 44px;
		height: 44px;
	}

	/* The app's touch floor (app.css, 44 px), like the play button's. */
	:global(:root.touch-ui) .step {
		width: 44px;
		height: 44px;
	}

	/* The one control a stray tap in turbulence lands on: the whole 44 px
	   floor, since Chromium moves the thumb to the touch point and a brushed
	   track would pin the picture to an old frame (the recording's own
	   return to the newest is in radar.svelte.ts fetchIndex). */
	:global(:root.touch-ui) .slider input[type='range'] {
		height: 44px;
	}
</style>
