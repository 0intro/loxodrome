/* The nav log's print flag (NavLogModal's papers): true from a request to
 * the job's afterprint, so every print row stands down (printBusy).
 * Import-free, so the print tracker can read it. */

export const navlogPrint = $state<{ preparing: boolean }>({ preparing: false });
