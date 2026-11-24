/* Types for play-listing.js, so tests/playListing.spec.ts can check the
 * listing rules. The script itself stays plain JS, as play-release.js. */

/** The URLs text gives, a sentence's final period left out. */
export function links(text: string): string[];

/** Why the listing in dir cannot go to Play, a line each, or none. */
export function checkListing(dir: string): string[];
