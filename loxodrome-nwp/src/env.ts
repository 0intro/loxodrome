/* The Worker's bindings and variables (wrangler.toml). */

import type { NwpIngest } from './ingest.ts';

export interface Env {
	NWP: R2Bucket;
	INGEST: DurableObjectNamespace<NwpIngest>;
	EMAIL?: { send(message: unknown): Promise<void> };
	SENDER_EMAIL?: string;
	REPORT_EMAIL?: string;
	ALLOW_ORIGINS?: string;
	/** "1": every forecast answers 503 disabled (the clients' failover). */
	DISABLED?: string;
	/** "1": the orchestrators start no job (the read path keeps serving). */
	INGEST_PAUSED?: string;
	/** A model's daily budget of container time, whole minutes (default
	 *  JOB_BUDGET_MINUTES, 90; "0" holds every job): past it no job starts
	 *  until 00:00 UTC, mailed once. */
	JOB_BUDGET_MINUTES?: string;
	/** A new value hands every failed block of the collecting runs another
	 *  three attempts, once (after a fix). */
	RETRY_EPOCH?: string;
	/** A new value sends ONE test alert (from AROME's orchestrator): the
	 *  operator's proof that the mail path works. */
	MAIL_TEST?: string;
	/** A new value starts every orchestrator afresh from the bucket's own
	 *  pointer, once, at its first tick with no job running (the bucket
	 *  moved, or restored). */
	STATE_EPOCH?: string;
}
