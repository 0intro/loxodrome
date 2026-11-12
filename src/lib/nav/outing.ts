/* The outing window: a trace whose last fix is younger than this is the SAME
 * outing. The boot keeps such a trace on the map rather than parking it
 * (state/navRecording.svelte.ts), an interrupted flight holds its automatic
 * night only that long, and the flight button offers to add the next flight
 * to it ("Add to this trace") only inside it (nav/flightStart.ts). One
 * definition, in a leaf both the state module and the pure decision read, so
 * the answers cannot drift. */

export const OUTING_MS = 6 * 60 * 60 * 1000;
