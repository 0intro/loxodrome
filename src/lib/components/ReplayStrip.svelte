<script lang="ts">
	/* The replay's transport on the map, on both layouts
	 * (state/replayStrip.svelte.ts; docs/nav-live.md "The replay strip"): the
	 * strip at the map's foot, the band above it reading the replayed pose.
	 * Play / Pause, the previous and next recorded event, the playhead's time,
	 * the speed and a close, over a scrubber marked with the flight's events
	 * (takeoff and landing, the waypoints passed, the airspace boundaries
	 * crossed), which is what makes it a debriefing tool rather than a scrub
	 * bar. RadarTimeline's idiom: only the controls take the pointer.
	 * MapView's foot places it, at the very bottom under the radar strip.
	 *
	 * The close FOLDS it into a chip carrying the playhead's time, which a tap
	 * unfolds: the trace stays on the map, and the trace profile, which reads
	 * it over time too, keeps working (its Play comes back while the strip is
	 * folded). */
	import { onDestroy, tick, untrack } from 'svelte';
	import Icon from './Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import {
		nav,
		PLAYBACK_SPEEDS,
		setPlaybackSpeed,
		setPlayhead,
		togglePlay,
	} from '$lib/state/navRecording.svelte';
	import { adjacentReplayEvent, replayEvents } from '$lib/state/navLive.svelte';
	import {
		foldReplayStrip,
		replayOpen,
		replayStripShown,
		setReplayScrub,
		unfoldReplayStrip,
	} from '$lib/state/replayStrip.svelte';
	import { hasAbsoluteTime, traceEndMs, traceStartMs } from '$lib/nav/trace';
	import { fmtClockUtcSec, fmtDurationMs } from '$lib/route/format';
	import { inputValue } from '$lib/ui/dom';

	const open = $derived(replayOpen());
	const shown = $derived(replayStripShown());
	const startMs = $derived(traceStartMs(nav.points) ?? 0);
	const endMs = $derived(traceEndMs(nav.points) ?? 0);
	const spanMs = $derived(Math.max(0, endMs - startMs));
	// The events fold the routes flown, their schedules and the motion fold:
	// read only while the strip is up (every derived here is lazy).
	const events = $derived(shown ? replayEvents() : []);
	const prevEvent = $derived(shown ? adjacentReplayEvent(events, nav.playheadMs, -1) : null);
	const nextEvent = $derived(shown ? adjacentReplayEvent(events, nav.playheadMs, 1) : null);
	// The time of day only for a trace that has one (a time-less GPX runs on
	// a synthesised clock from zero).
	const clock = $derived(hasAbsoluteTime(nav.points) ? `${fmtClockUtcSec(nav.playheadMs)}Z` : null);
	const elapsed = $derived(fmtDurationMs(nav.playheadMs - startMs));
	const total = $derived(fmtDurationMs(spanMs));
	// i18n-ignore: the multiplier suffix is locale-invariant (the tab's speed picker)
	const speedText = $derived(`${nav.playbackSpeed}×`);
	/** Each event's place along the scrubber, 0 to 1. */
	const ticks = $derived(
		spanMs > 0
			? events.map((e) => ({ ms: e.ms, kind: e.kind, f: Math.min(1, Math.max(0, (e.ms - startMs) / spanMs)) }))
			: [],
	);

	/** The speed steps up one multiplier a tap, round to the slowest: one
	 *  button where the tab has a row of them, which a phone cannot seat. */
	function cycleSpeed(): void {
		const i = PLAYBACK_SPEEDS.indexOf(nav.playbackSpeed);
		setPlaybackSpeed(PLAYBACK_SPEEDS[(i + 1) % PLAYBACK_SPEEDS.length]);
	}

	function jump(e: { ms: number } | null): void {
		if (e) {
			setPlayhead(e.ms);
		}
	}

	// The focus follows a fold: from the close to the chip it leaves, and
	// back, so a keyboard is never dropped on the page's body.
	let closeEl = $state<HTMLButtonElement>();
	let chipEl = $state<HTMLButtonElement>();

	async function fold(): Promise<void> {
		foldReplayStrip();
		await tick();
		chipEl?.focus();
	}

	async function unfold(): Promise<void> {
		unfoldReplayStrip();
		await tick();
		closeEl?.focus();
	}

	// A scrubber removed under the finger fires no pointerup: whenever the
	// strip is down (folded, a recording, no replay), no finger holds it. The
	// write is untracked, so the effect follows the strip alone.
	$effect(() => {
		if (!shown) {
			untrack(() => setReplayScrub(false));
		}
	});

	onDestroy(() => {
		setReplayScrub(false);
	});
</script>

{#if shown}
	<div class="replay-strip map-bar no-print" role="group" aria-label={t.navigation.replay}>
		<div class="body">
			<button
				type="button"
				class="icon-btn play"
				onclick={togglePlay}
				aria-label={nav.playing ? t.navigation.pause : t.navigation.play}
				title={nav.playing ? t.navigation.pause : t.navigation.play}
			>
				<Icon name={nav.playing ? 'pause' : 'play'} size={16} />
			</button>
			<button
				type="button"
				class="icon-btn prev"
				disabled={prevEvent == null}
				onclick={() => jump(prevEvent)}
				aria-label={t.navigation.prevEvent}
				title={t.navigation.eventJumpTip}
			>
				<Icon name="chevron-left" size={16} />
			</button>
			<button
				type="button"
				class="icon-btn next"
				disabled={nextEvent == null}
				onclick={() => jump(nextEvent)}
				aria-label={t.navigation.nextEvent}
				title={t.navigation.eventJumpTip}
			>
				<Icon name="chevron-right" size={16} />
			</button>
			<div class="readout">
				{#if clock}<span class="clock" title={t.navigation.timeOfDay}>{clock}</span>{/if}
				<span class="span">{elapsed} / {total}</span>
			</div>
			<div class="scrub">
				<!-- Under the track, the flight's events: the jumps' own stops,
				     seen before they are pressed. -->
				<div class="ticks" aria-hidden="true">
					{#each ticks as tk (tk.ms)}
						<span class="tick {tk.kind}" style:--f={tk.f}></span>
					{/each}
				</div>
				<!-- A finger on it holds follow loose until it lets go
				     (map/navLayer.ts syncNavAircraft), so a sweep across the
				     flight is not a map repaint per step. -->
				<input
					type="range"
					min={startMs}
					max={endMs}
					step="1000"
					value={nav.playheadMs}
					aria-label={t.navigation.replaySlider}
					aria-valuetext={t.navigation.replayPosition({ clock, elapsed, total })}
					oninput={(e) => setPlayhead(Number(inputValue(e)))}
					onpointerdown={() => setReplayScrub(true)}
					onpointerup={() => setReplayScrub(false)}
					onpointercancel={() => setReplayScrub(false)}
					onchange={() => setReplayScrub(false)}
				/>
			</div>
			<button
				type="button"
				class="text-btn speed"
				onclick={cycleSpeed}
				aria-label={t.navigation.speedNow(speedText)}
				title={t.navigation.speedNow(speedText)}
			>
				{speedText}
			</button>
			<button
				type="button"
				class="icon-btn close map-bar-close"
				onclick={fold}
				bind:this={closeEl}
				aria-label={t.navigation.replayHide}
				title={t.navigation.replayHide}
			>
				<Icon name="x" size={16} />
			</button>
		</div>
	</div>
{:else if open}
	<!-- The folded strip: one button carrying the playhead's time (the time
	     of day, or the elapsed time of a trace without one), its name opening
	     on the words it shows. -->
	<button type="button" class="foot-chip replay-chip no-print" title={t.navigation.replayShow} onclick={unfold} bind:this={chipEl}>
		<span class="chip-label">{t.navigation.replay}</span>
		<span class="chip-time">{clock ?? elapsed}</span>
		<span class="sr-only">{t.navigation.replayShow}</span>
		<Icon name="chevron-up" size={12} />
	</button>
{/if}

<style>
	/* The last line of the map's foot (MapView .map-foot), at its whole
	   width (a scrubber is only as fine as it is long): the radar strip, the
	   corner column and the credit stand on the foot's one published height. */
	.replay-strip {
		position: relative;
		flex: 1 0 100%;
		min-width: 0;
		padding: 2px 4px;
	}

	/* Its own width decides its form: its insets set it, never its content.
	   Screen only, like every container here: containment must never touch a
	   print flow. */
	@media screen {
		.replay-strip {
			container: replay-strip / inline-size;
		}
	}

	/* Two rows, the portrait phone's: the controls and the readout over the
	   scrubber, the speed at its end (beside the readout it left a phone 360
	   px wide no room for an hour's "1:02:04 / 1:07:06"). */
	.body {
		display: grid;
		grid-template-areas:
			'play prev next readout close'
			'scrub scrub scrub scrub speed';
		grid-template-columns: auto auto auto minmax(0, 1fr) auto;
		gap: 0 2px;
		align-items: center;
	}

	.play {
		grid-area: play;
	}

	.prev {
		grid-area: prev;
	}

	.next {
		grid-area: next;
	}

	.speed {
		grid-area: speed;
	}

	.close {
		grid-area: close;
	}

	.readout {
		display: flex;
		grid-area: readout;
		flex-direction: column;
		justify-content: center;
		min-width: 0;
		padding: 0 6px;
		overflow: hidden;
		white-space: nowrap;
	}

	/* One row where the width allows it, a landscape phone's. After the rules
	   above, which it overrides at the same specificity. */
	@container replay-strip (min-width: 580px) {
		.body {
			grid-template-areas: 'play prev next readout scrub speed close';
			grid-template-columns: auto auto auto auto minmax(0, 1fr) auto auto;
			gap: 0 6px;
		}
	}

	/* Three under the width of the controls and a readout, the landscape map
	   beside a pane at its wide detent: the readout goes under the scrubber,
	   the time of day at one end and the elapsed time at the other. */
	@container replay-strip (max-width: 299.98px) {
		.body {
			grid-template-areas:
				'play prev next . close'
				'scrub scrub scrub scrub speed'
				'readout readout readout readout readout';
		}

		.readout {
			flex-direction: row;
			justify-content: space-between;
		}
	}

	.clock {
		font-weight: 600;
	}

	.span {
		font-size: 11px;
		color: var(--text-muted);
	}

	/* The ticks share the input's box, so a tick's share of the track is its
	   share of the playhead's travel: the thumb's centre runs a radius in from
	   either end (Chromium's and Gecko's default thumbs are 16 px). */
	.scrub {
		--thumb-r: 8px;

		position: relative;
		grid-area: scrub;
		min-width: 0;
	}

	.scrub input {
		position: relative;
		display: block;
		width: 100%;
		margin: 0;
		accent-color: var(--accent);
	}

	/* The whole 44 px touch floor, the radar strip's own reason: a finger that
	   misses the track brushes the playhead elsewhere. */
	:global(:root.touch-ui) .scrub input {
		height: 44px;
	}

	.ticks {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.tick {
		position: absolute;
		top: calc(50% + 5px);
		left: calc(var(--thumb-r) + (100% - 2 * var(--thumb-r)) * var(--f));
		width: 2px;
		height: 7px;
		background: var(--text-muted);
		border-radius: 1px;
		transform: translateX(-50%);
	}

	.tick.takeoff,
	.tick.landing {
		height: 10px;
		background: var(--text);
	}

	.tick.airspace {
		width: 1px;
		height: 5px;
		background: var(--border-strong);
	}

	.chip-label,
	.chip-time {
		font-weight: 600;
	}
</style>
