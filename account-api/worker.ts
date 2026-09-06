/* The Loxodrome account + sync API (docs/accounts-sync.md): e-mail
 * one-time-code auth, opaque bearer sessions, and a content-opaque
 * document replicator (per-doc rev, per-account seq, recorded
 * tombstones, content-hash idempotency) over D1 + R2, with the staged
 * account deletion and the daily cron sweeps.
 *
 * The server NEVER parses a payload: plans and aircraft are the app's
 * own file text verbatim, outings a canonical JSON of authored fields,
 * and every inline payload rides the {alg, data} envelope so end-to-end
 * encryption stays a client decision. What this worker owns is
 * authenticate, arbitrate revisions, count bytes, sweep.
 *
 * Bindings: DB (D1, location weur), BLOBS (R2, jurisdiction eu), EMAIL
 * (send_email). Secrets: TURNSTILE_SECRET. Dev: DEV_CODE fixes the
 * login code AND bypasses the Turnstile siteverify; it must never be
 * set in production (wrangler.toml's header).
 *
 * Load-bearing shapes, each pinned by a test:
 *  - the per-account seq is computed INSIDE the push batch's SQL (bump
 *    users.change_seq, then a conditional upsert whose seq is a
 *    subselect and whose baseRev precondition lives in the statement);
 *    JS-side read-modify-write would mint duplicate seqs under
 *    concurrent pushes and a client at `since` between them would
 *    silently miss a change;
 *  - bytes_used is a closing batch statement RECOMPUTING the account,
 *    never delta bookkeeping (a doc losing its precondition mid-batch
 *    makes deltas unknowable); the blob PUT enforces caps against the
 *    ACTUAL body size, which bounds real R2 usage whatever a ref
 *    claims;
 *  - a rev mismatch whose content already equals the pushed intent
 *    (equal hash, or both deleted) answers ok with no write: the
 *    retried-push idempotency the client fold mirrors;
 *  - tombstoning a doc CLEARS its blob_refs; the orphans table is the
 *    30-day GC grace clock (R2 has no Time Travel, so a database
 *    restored inside D1's 30-day window must still find the blobs its
 *    restored rows reference);
 *  - the blobs LEDGER, stamped from the actual body at PUT, is what the
 *    quota counts and what a pushed ref must name: a ref's own `n` is a
 *    claim, and the content hash embeds it, so it is stored as sent but
 *    never summed;
 *  - a full listing pages with `full=1` on its continuation requests,
 *    which the horizon clamp must not re-test: the second page's cursor
 *    sits below the horizon by construction, and re-clamping it to zero
 *    would hand a >200-doc account its first page for ever;
 *  - tombstone retention keys on the server's own stamp (docs.server_at),
 *    never on the client clock a push carries;
 *  - `cloudflare:email` is imported dynamically inside the real-send
 *    branch only, or the module would be unimportable under Node and
 *    the zero-dependency test harness with it. */

// --- types, env and limits -------------------------------------------------

interface EmailBinding {
	send(message: unknown): Promise<void>;
}

interface Env {
	DB: D1Database;
	BLOBS: R2Bucket;
	EMAIL?: EmailBinding;
	TURNSTILE_SECRET?: string;
	ALLOW_ORIGINS?: string;
	SENDER_EMAIL?: string;
	REPORT_EMAIL?: string;
	/** Dev/e2e only: the fixed login code; also bypasses Turnstile. */
	DEV_CODE?: string;
	/** Aggregate ceiling overrides (strings from [vars]); defaults below. */
	MAX_ACCOUNTS?: string;
	MAX_TOTAL_BYTES?: string;
}

const COLLECTIONS = ['plans', 'outings', 'aircraft', 'acstate', 'pilot'] as const;
type Collection = (typeof COLLECTIONS)[number];

/** Per-account quota and per-object caps (the contract's settled
 *  numbers; the quota error names them to the user). */
const QUOTA_BYTES = 250 * 1024 * 1024;
const BLOB_MAX_STORED = 25 * 1024 * 1024;
const INLINE_MAX_BYTES = 256 * 1024;
const META_MAX_BYTES = 2 * 1024;
const DOCS_MAX = 20_000;
const PUSH_MAX_DOCS = 100;
const PUSH_MAX_BODY = 4 * 1024 * 1024;
const CHANGES_PAGE = 200;
/** A changes page is bounded by bytes as well as by count: 200 inline
 *  payloads at the 256 KB cap would be a 51 MB JSON body. */
const CHANGES_PAGE_BYTES = 3_500_000;
/** D1 binds at most 100 parameters per statement; the ledger lookup
 *  chunks its IN list under that. */
const SQL_IN_CHUNK = 90;

/** Auth timings. */
const CODE_TTL_MS = 10 * 60_000;
const CODE_MAX_ATTEMPTS = 5;
const CODE_COOLDOWN_MS = 60_000;
const CODES_PER_HOUR = 3;
const CODES_PER_DAY = 10;
const SESSION_PERSONAL_MS = 90 * 86_400_000;
const SESSION_SHARED_MS = 12 * 3_600_000;
const SESSION_ROLL_AFTER_MS = 3_600_000;

/** Retention. */
const TOMBSTONE_KEEP_MS = 90 * 86_400_000;
const BLOB_GRACE_MS = 30 * 86_400_000;
const DELETE_STAGE_MS = 7 * 86_400_000;

/** Aggregate service ceilings, the wallet guard open signup demands:
 *  new-account creation refuses past them ("service full"), existing
 *  accounts untouched. Overridable via [vars] so raising them is a
 *  config change, not a deploy. */
const DEFAULT_MAX_ACCOUNTS = 500;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;

interface UserRow {
	id: string;
	email: string;
	created_at: number;
	change_seq: number;
	status: string;
	delete_after: number | null;
	bytes_used: number;
	horizon_seq: number;
	last_seen: number | null;
}

interface SessionRow {
	id: string;
	user_id: string;
	token_hash: string;
	device_name: string;
	mode: string;
	created_at: number;
	last_seen: number;
	expires_at: number;
}

interface DocRow {
	user_id: string;
	col: Collection;
	doc_id: string;
	rev: number;
	seq: number;
	deleted: number;
	updated_at: number;
	device_id: string;
	content_hash: string;
	meta_json: string;
	payload: string | null;
	blob_refs: string | null;
	server_at: number;
}

interface CodeRow {
	email_hash: string;
	code_hash: string;
	expires_at: number;
	attempts: number;
	requested_at: number;
	hour_start: number;
	hour_count: number;
	day_start: number;
	day_count: number;
}

interface BlobRef {
	h: string;
	n: number;
}

interface PushDocIn {
	col: Collection;
	id: string;
	baseRev: number;
	deleted: boolean;
	updatedAt: number;
	device: string;
	hash: string;
	meta: Record<string, unknown>;
	payload?: { alg: string; data: string };
	blobs?: BlobRef[];
}

// --- small utils -----------------------------------------------------------

/** Every JSON answer is `no-store`: tokens, addresses, payloads and
 *  session lists must not outlive the shared machine's wipe in the
 *  browser's HTTP cache (URL-keyed; the bearer is no cache key). */
function json(value: unknown, status = 200, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...headers,
		},
	});
}

/** The typed error the client maps through errorText: {error: code}. */
function errJson(code: string, status: number, extra?: Record<string, unknown>): Response {
	return json({ error: code, ...extra }, status);
}

function logError(event: string, fields: Record<string, unknown>): void {
	console.error(JSON.stringify({ event, ...fields }));
}

const utf8 = new TextEncoder();

function byteLength(text: string): number {
	return utf8.encode(text).length;
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === 'string' ? utf8.encode(data) : data;
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	let out = '';
	for (const b of new Uint8Array(digest)) {
		out += b.toString(16).padStart(2, '0');
	}
	return out;
}

function normalizeEmail(raw: unknown): string | null {
	if (typeof raw !== 'string') {
		return null;
	}
	const email = raw.trim().toLowerCase();
	// Deliberately loose: the code round trip proves deliverability, this
	// only rejects the obviously-not-an-address.
	if (email.length < 6 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return null;
	}
	return email;
}

/** The address is stored ONLY as this hash in login_codes and
 *  suppressions: codes get requested for addresses that never become
 *  accounts, and there is no reason to keep the addresses of people who
 *  typo'd once. */
function emailHash(email: string): Promise<string> {
	return sha256Hex(`loxodrome:${email}`);
}

function digestEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

function clientIp(request: Request): string {
	return (
		request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? 'unknown'
	);
}

function newId(): string {
	return crypto.randomUUID();
}

function base64Url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) {
		bin += String.fromCharCode(b);
	}
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newToken(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function intVar(raw: string | undefined, fallback: number): number {
	const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Read a JSON request body, refusing past `maxBytes` rather than
 *  buffering an attacker's patience. Null = missing, over-cap or
 *  malformed. */
async function readJsonCapped(request: Request, maxBytes: number): Promise<unknown> {
	const reader = request.body?.getReader() as
		| ReadableStreamDefaultReader<Uint8Array>
		| undefined;
	if (!reader) {
		return null;
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.length;
		if (total > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const all = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		all.set(c, off);
		off += c.length;
	}
	try {
		return JSON.parse(new TextDecoder().decode(all));
	} catch {
		return null;
	}
}

async function readBytesCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
	const reader = request.body?.getReader() as
		| ReadableStreamDefaultReader<Uint8Array>
		| undefined;
	if (!reader) {
		return new Uint8Array(0);
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.length;
		if (total > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const all = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		all.set(c, off);
		off += c.length;
	}
	return all;
}

// --- CORS ------------------------------------------------------------------

/** The site and the Android shell's WebView origin, nothing else: the
 *  vite dev origins ride `.dev.vars`, never a default a missing var
 *  would silently admit in production. */
const DEFAULT_ALLOW_ORIGINS = 'https://loxodrome.fr,https://localhost';

function corsHeaders(origin: string): Record<string, string> {
	const headers: Record<string, string> = {
		'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Authorization, Content-Type',
		'Access-Control-Expose-Headers': 'Retry-After',
		'Access-Control-Max-Age': '86400',
		'X-Content-Type-Options': 'nosniff',
	};
	if (origin) {
		headers['Access-Control-Allow-Origin'] = origin;
		headers['Vary'] = 'Origin';
	}
	return headers;
}

function cors(res: Response, origin: string): Response {
	for (const [k, v] of Object.entries(corsHeaders(origin))) {
		res.headers.set(k, v);
	}
	return res;
}

// --- rate limiting ---------------------------------------------------------

/* Module-global sliding windows, best-effort per isolate (the
 * notam-proxy posture): the point is breaking abuse economics, not
 * exact accounting; D1-side caps (login_codes windows) carry the
 * durable half. */

const RATE_LIMITS: Record<string, { limit: number; windowMs: number }> = {
	auth: { limit: 30, windowMs: 60_000 },
	sync: { limit: 240, windowMs: 60_000 },
	// Generous on purpose: a first adoption uploads the WHOLE library in
	// one pass (a real 84-outing device is ~170 blob PUTs, measured on
	// the M6 phone drive), and the per-ACCOUNT quota is the real brake;
	// this only has to stop hammering, not meter a legitimate burst.
	blobs: { limit: 600, windowMs: 60_000 },
};

/** The per-IP account-creation cap, the multiplier guard open signup
 *  needs (per-address caps are courtesy, plus-aliasing mints
 *  addresses). */
const CREATIONS_PER_IP_DAY = 3;

const rlHits = new Map<string, number[]>();
const RL_MAX_KEYS = 5000;
/** The widest window any bucket keeps (the creation cap's day). */
const RL_MAX_WINDOW_MS = 86_400_000;

/** Bound the map: drop the keys whose every hit has aged out of the
 *  widest window, then, still over, the coldest half by last hit. Never
 *  a wholesale clear, which would hand an attacker with many addresses
 *  a reset of everyone's 24 h creation window. */
function evictRateKeys(map: Map<string, number[]>, now: number): void {
	for (const [key, hits] of map) {
		if (hits.length === 0 || hits[hits.length - 1] <= now - RL_MAX_WINDOW_MS) {
			map.delete(key);
		}
	}
	if (map.size <= RL_MAX_KEYS) {
		return;
	}
	const byLast = [...map.entries()].sort(
		(a, b) => a[1][a[1].length - 1] - b[1][b[1].length - 1],
	);
	for (const [key] of byLast.slice(0, Math.ceil(byLast.length / 2))) {
		map.delete(key);
	}
}

/** `record` false only PEEKS: the creation gate is read before a code is
 *  spent and charged after it proves valid, so a wrong guess at an
 *  unknown address cannot burn the IP's three creations a day. */
function slidingWindowAllow(
	map: Map<string, number[]>,
	key: string,
	limit: number,
	windowMs: number,
	now: number,
	record = true,
): { allowed: boolean; retryAfterS: number } {
	let hits = map.get(key);
	if (!hits) {
		if (map.size > RL_MAX_KEYS) {
			evictRateKeys(map, now);
		}
		hits = [];
		map.set(key, hits);
	}
	let w = 0;
	for (let i = 0; i < hits.length; i++) {
		if (hits[i] > now - windowMs) {
			hits[w++] = hits[i];
		}
	}
	hits.length = w;
	if (hits.length >= limit) {
		return { allowed: false, retryAfterS: Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000)) };
	}
	if (record) {
		hits.push(now);
	}
	return { allowed: true, retryAfterS: 0 };
}

function checkRateLimit(bucket: string, ip: string): { allowed: boolean; retryAfterS: number } {
	const conf = RATE_LIMITS[bucket];
	if (!conf) {
		return { allowed: true, retryAfterS: 0 };
	}
	return slidingWindowAllow(rlHits, `${bucket}|${ip}`, conf.limit, conf.windowMs, Date.now());
}

function creationAllowed(ip: string, record: boolean): { allowed: boolean; retryAfterS: number } {
	return slidingWindowAllow(
		rlHits,
		`create|${ip}`,
		CREATIONS_PER_IP_DAY,
		RL_MAX_WINDOW_MS,
		Date.now(),
		record,
	);
}

function rateRefusal(retryAfterS: number): Response {
	return json({ error: 'rate-limited', retryAfterS }, 429, { 'Retry-After': String(retryAfterS) });
}

// --- e-mail ----------------------------------------------------------------

/** ONE send seam for the login codes and the weekly report. The DEV
 *  short-circuit comes FIRST, before the binding is even touched, so
 *  local dev and the tests never depend on it existing; the dynamic
 *  import keeps `cloudflare:email` out of Node's module graph. */
async function sendMail(env: Env, to: string, subject: string, body: string): Promise<void> {
	if (env.DEV_CODE !== undefined) {
		console.log(JSON.stringify({ event: 'dev-mail', to, subject }));
		return;
	}
	if (!env.EMAIL) {
		throw new Error('EMAIL binding missing');
	}
	const from = env.SENDER_EMAIL ?? 'login@loxodrome.fr';
	const spec = 'cloudflare:email';
	const mod = (await import(/* @vite-ignore */ spec)) as {
		EmailMessage: new (from: string, to: string, raw: string) => unknown;
	};
	const raw = [
		`From: Loxodrome <${from}>`,
		`To: <${to}>`,
		`Subject: ${subject}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: 8bit',
		'',
		body,
	].join('\r\n');
	await env.EMAIL.send(new mod.EmailMessage(from, to, raw));
}

function codeMail(locale: string, code: string): { subject: string; body: string } {
	if (locale === 'fr') {
		return {
			subject: 'Votre code de connexion Loxodrome',
			body:
				`Votre code de connexion Loxodrome : ${code}\n\n` +
				'Il expire dans 10 minutes.\n' +
				"Si vous n'avez pas demandé ce code, ignorez ce message. " +
				'Ne partagez jamais ce code avec quiconque.\n',
		};
	}
	return {
		subject: 'Your Loxodrome sign-in code',
		body:
			`Your Loxodrome sign-in code: ${code}\n\n` +
			'It expires in 10 minutes.\n' +
			'If you did not request it, ignore this message. ' +
			'Never share this code with anyone.\n',
	};
}

// --- auth: login codes -----------------------------------------------------

async function turnstileOk(env: Env, token: unknown, ip: string): Promise<boolean> {
	if (env.DEV_CODE !== undefined) {
		return true;
	}
	if (typeof token !== 'string' || token === '' || !env.TURNSTILE_SECRET) {
		return false;
	}
	try {
		const form = new URLSearchParams({
			secret: env.TURNSTILE_SECRET,
			response: token,
			remoteip: ip,
		});
		const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			body: form,
			signal: AbortSignal.timeout(10_000),
		});
		const out = await res.json<{ success?: boolean }>();
		return out.success === true;
	} catch (err) {
		logError('turnstile-error', { detail: err instanceof Error ? err.message : String(err) });
		return false;
	}
}

/** POST /v1/auth/code: always 204, whatever happened, so nothing about
 *  an address's existence, suppression or caps is observable from the
 *  response (the mailbox's owner is the only one who learns anything,
 *  about their own address). A bearer-authenticated request for the
 *  session's OWN address skips Turnstile: the sudo re-verify must not
 *  re-render the widget, and the caller is already an account. */
async function handleAuthCode(request: Request, env: Env, ip: string): Promise<Response> {
	const body = (await readJsonCapped(request, 8 * 1024)) as {
		email?: unknown;
		turnstile?: unknown;
		locale?: unknown;
	} | null;
	const email = normalizeEmail(body?.email);
	const done = new Response(null, { status: 204 });
	if (!email) {
		return done;
	}
	let human = false;
	if (request.headers.get('Authorization')?.startsWith('Bearer ')) {
		const auth = await bearerAuth(request, env);
		human = !(auth instanceof Response) && auth.user.email === email;
	}
	if (!human && !(await turnstileOk(env, body?.turnstile, ip))) {
		return done;
	}
	const hash = await emailHash(email);
	const now = Date.now();
	const suppressed = await env.DB.prepare('SELECT email_hash FROM suppressions WHERE email_hash = ?1')
		.bind(hash)
		.first();
	if (suppressed) {
		return done;
	}
	const row = await env.DB.prepare('SELECT * FROM login_codes WHERE email_hash = ?1')
		.bind(hash)
		.first<CodeRow>();
	let hourStart = now;
	let hourCount = 1;
	let dayStart = now;
	let dayCount = 1;
	if (row) {
		if (now - row.requested_at < CODE_COOLDOWN_MS) {
			return done;
		}
		if (now - row.hour_start < 3_600_000) {
			if (row.hour_count >= CODES_PER_HOUR) {
				return done;
			}
			hourStart = row.hour_start;
			hourCount = row.hour_count + 1;
		}
		if (now - row.day_start < 86_400_000) {
			if (row.day_count >= CODES_PER_DAY) {
				return done;
			}
			dayStart = row.day_start;
			dayCount = row.day_count + 1;
		}
	}
	const code =
		env.DEV_CODE !== undefined
			? env.DEV_CODE
			: String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
	const codeHash = await sha256Hex(`code:${code}`);
	await env.DB.prepare(
		`INSERT INTO login_codes (email_hash, code_hash, expires_at, attempts, requested_at,
			hour_start, hour_count, day_start, day_count)
		VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8)
		ON CONFLICT (email_hash) DO UPDATE SET
			code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0,
			requested_at = excluded.requested_at, hour_start = excluded.hour_start,
			hour_count = excluded.hour_count, day_start = excluded.day_start,
			day_count = excluded.day_count`,
	)
		.bind(hash, codeHash, now + CODE_TTL_MS, now, hourStart, hourCount, dayStart, dayCount)
		.run();
	const locale = body?.locale === 'fr' ? 'fr' : 'en';
	const mail = codeMail(locale, code);
	try {
		await sendMail(env, email, mail.subject, mail.body);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		logError('mail-error', { detail });
		// A synchronous HARD bounce lands the address on the suppression
		// list: sender reputation is what keeps the legitimate codes
		// landing (docs/accounts-sync.md). Only a permanent recipient
		// failure qualifies; a transient refusal (a greylist, a quota, a
		// rate limit, a timeout) must not silence an address for good,
		// there being no user-visible sign and only an operator recipe
		// (admin/unsuppress.sql) to undo it.
		if (isHardBounce(detail)) {
			await env.DB.prepare(
				'INSERT OR REPLACE INTO suppressions (email_hash, at, reason) VALUES (?1, ?2, ?3)',
			)
				.bind(hash, now, 'hard-bounce')
				.run();
		}
	}
	return done;
}

/** Whether a send error names a PERMANENT recipient failure (the
 *  address does not exist), as opposed to anything transient. */
function isHardBounce(detail: string): boolean {
	if (/temporar|try again|later|greylist|rate|quota|throttl|timeout|timed out|\b4\d\d\b/i.test(detail)) {
		return false;
	}
	return /(no such|unknown|invalid|bad|rejected|does not exist|not found)\W+(user|recipient|address|mailbox|account)|hard.?bounce|\b55[0-9]\b/i.test(
		detail,
	);
}

/** Verify a code for an address: shared by /auth/verify and the sudo
 *  re-verify. Burns the code on success (single use) and counts
 *  attempts to the cap on failure. The attempt is charged IN SQL, with
 *  the cap in the statement's own WHERE: a read-then-write cap lets N
 *  parallel guesses all read "under five" and take N shots at one code. */
async function consumeCode(env: Env, email: string, code: unknown): Promise<boolean> {
	if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
		return false;
	}
	const hash = await emailHash(email);
	const now = Date.now();
	const row = await env.DB.prepare(
		`UPDATE login_codes SET attempts = attempts + 1
		WHERE email_hash = ?1 AND attempts < ?2 AND expires_at >= ?3
		RETURNING code_hash`,
	)
		.bind(hash, CODE_MAX_ATTEMPTS, now)
		.first<{ code_hash: string }>();
	if (!row) {
		return false;
	}
	// Comparing DIGESTS defeats input-timing; the XOR fold below removes
	// even the digest-prefix timing.
	const candidate = await sha256Hex(`code:${code}`);
	if (!digestEqual(candidate, row.code_hash)) {
		return false;
	}
	await env.DB.prepare('DELETE FROM login_codes WHERE email_hash = ?1').bind(hash).run();
	return true;
}

// --- auth: verify + sessions -----------------------------------------------

/** POST /v1/auth/verify: one flow, sign-in and creation alike. The
 *  first successful verification on an unknown address CREATES the
 *  account (behind the creation cap and the aggregate ceilings);
 *  pending_delete still mints a session, since the restore needs auth,
 *  and the `status` field is how the client learns to offer it. */
async function handleVerify(request: Request, env: Env, ip: string): Promise<Response> {
	const body = (await readJsonCapped(request, 8 * 1024)) as {
		email?: unknown;
		code?: unknown;
		deviceName?: unknown;
		mode?: unknown;
	} | null;
	const email = normalizeEmail(body?.email);
	if (!email) {
		return errJson('bad-request', 400);
	}
	const mode = body?.mode === 'shared' ? 'shared' : body?.mode === 'personal' ? 'personal' : null;
	if (mode === null) {
		return errJson('bad-request', 400); // never a silent 90-day session
	}
	const now = Date.now();
	let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?1')
		.bind(email)
		.first<UserRow>();
	let created = false;
	if (!user) {
		// The creation gates are READ before the code is spent (a refused
		// creation must not cost the pilot the code and its cooldown slot)
		// and the IP's creation is CHARGED only once the code proves valid
		// (a wrong guess at an unknown address must not burn the cap).
		const creation = creationAllowed(ip, false);
		if (!creation.allowed) {
			return rateRefusal(creation.retryAfterS);
		}
		const ceilings = await env.DB.prepare(
			`SELECT (SELECT COUNT(*) FROM users) AS n,
				(SELECT COALESCE(SUM(bytes_used), 0) FROM users)
				+ (SELECT COALESCE(SUM(n), 0) FROM orphans) AS b`,
		).first<{ n: number; b: number }>();
		if (
			ceilings &&
			(ceilings.n >= intVar(env.MAX_ACCOUNTS, DEFAULT_MAX_ACCOUNTS) ||
				ceilings.b >= intVar(env.MAX_TOTAL_BYTES, DEFAULT_MAX_TOTAL_BYTES))
		) {
			logError('service-full', { accounts: ceilings.n, bytes: ceilings.b });
			return errJson('service-full', 503);
		}
	}
	if (!(await consumeCode(env, email, body?.code))) {
		return errJson('code-invalid', 401);
	}
	if (!user) {
		creationAllowed(ip, true);
		const id = newId();
		await env.DB.prepare('INSERT INTO users (id, email, created_at, last_seen) VALUES (?1, ?2, ?3, ?3)')
			.bind(id, email, now)
			.run();
		user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first<UserRow>();
		created = true;
	}
	if (!user) {
		return errJson('internal', 500);
	}
	if (user.status === 'suspended') {
		return errJson('suspended', 403);
	}
	// A staged deletion mints sessions only INSIDE its window (the restore
	// needs auth; docs/accounts-sync.md, Lifecycle). Past the deadline, or
	// under the sweep's claim, the account is spoken for: an operator's
	// immediate deletion (admin/delete.sql) is not the abuser's to cancel
	// in the hours before the cron.
	if (deletionSealed(user, now)) {
		return errJson('account-pending-delete', 403, { deleteAfter: user.delete_after });
	}
	const deviceName =
		typeof body?.deviceName === 'string' && body.deviceName.trim() !== ''
			? body.deviceName.trim().slice(0, 60)
			: 'Unknown device';
	const token = newToken();
	await env.DB.prepare(
		`INSERT INTO sessions (id, user_id, token_hash, device_name, mode, created_at, last_seen, expires_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)`,
	)
		.bind(
			newId(),
			user.id,
			await sha256Hex(`token:${token}`),
			deviceName,
			mode,
			now,
			now + (mode === 'personal' ? SESSION_PERSONAL_MS : SESSION_SHARED_MS),
		)
		.run();
	return json({ token, userId: user.id, created, status: user.status });
}

interface AuthResult {
	user: UserRow;
	session: SessionRow;
}

/** Resolve the bearer token to a live session + user: one D1 read per
 *  request, which is what makes revocation INSTANT (the JWT alternative
 *  was considered and rejected; docs/accounts-sync.md). */
async function bearerAuth(request: Request, env: Env): Promise<AuthResult | Response> {
	const header = request.headers.get('Authorization') ?? '';
	if (!header.startsWith('Bearer ')) {
		return errJson('unauthorized', 401);
	}
	const tokenHash = await sha256Hex(`token:${header.slice(7).trim()}`);
	const row = await env.DB.prepare(
		`SELECT s.id AS s_id, s.user_id, s.token_hash, s.device_name, s.mode, s.created_at AS s_created,
			s.last_seen AS s_seen, s.expires_at, u.*
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = ?1`,
	)
		.bind(tokenHash)
		.first<
			UserRow & {
				s_id: string;
				user_id: string;
				token_hash: string;
				device_name: string;
				mode: string;
				s_created: number;
				s_seen: number;
				expires_at: number;
			}
		>();
	const now = Date.now();
	if (!row || row.expires_at < now) {
		return errJson('unauthorized', 401);
	}
	if (row.status === 'suspended') {
		return errJson('suspended', 403);
	}
	if (row.status === 'purging') {
		return errJson('account-pending-delete', 403, { deleteAfter: row.delete_after });
	}
	const session: SessionRow = {
		id: row.s_id,
		user_id: row.user_id,
		token_hash: row.token_hash,
		device_name: row.device_name,
		mode: row.mode,
		created_at: row.s_created,
		last_seen: row.s_seen,
		expires_at: row.expires_at,
	};
	const user: UserRow = {
		id: row.id,
		email: row.email,
		created_at: row.created_at,
		change_seq: row.change_seq,
		status: row.status,
		delete_after: row.delete_after,
		bytes_used: row.bytes_used,
		horizon_seq: row.horizon_seq,
		last_seen: row.last_seen,
	};
	// Hourly-granular presence write; personal sessions ROLL their expiry
	// with use (the 90-day sliding window), shared ones never do (the
	// 12 h cap is absolute, the club-PC posture).
	if (now - session.last_seen > SESSION_ROLL_AFTER_MS) {
		const expires =
			session.mode === 'personal' ? now + SESSION_PERSONAL_MS : session.expires_at;
		await env.DB.prepare(
			'UPDATE sessions SET last_seen = ?1, expires_at = ?2 WHERE id = ?3',
		)
			.bind(now, expires, session.id)
			.run();
		await env.DB.prepare('UPDATE users SET last_seen = ?1 WHERE id = ?2').bind(now, user.id).run();
	}
	return { user, session };
}

/** A staged deletion past its deadline, or one the sweep has claimed
 *  (`purging`): no sign-in and no restore, whatever the cron's timing. */
function deletionSealed(user: UserRow, now: number): boolean {
	return (
		user.status === 'purging' ||
		(user.status === 'pending_delete' && user.delete_after !== null && user.delete_after <= now)
	);
}

/** The endpoints a pending_delete account may still reach: seeing its
 *  own state, and cancelling the deletion. Everything else refuses with
 *  a typed code the client words. */
function pendingDeleteAllowed(method: string, pathname: string): boolean {
	return (
		(method === 'GET' && pathname === '/v1/account') ||
		(method === 'POST' && pathname === '/v1/account/restore')
	);
}

/** The sudo gate (GitHub's pattern): destructive account-level actions
 *  re-verify with a FRESH code, which bounds a still-signed-in shared
 *  machine's worst case to "someone read my plans". */
async function sudoOk(env: Env, user: UserRow, body: unknown): Promise<boolean> {
	const code = (body as { code?: unknown } | null)?.code;
	return consumeCode(env, user.email, code);
}

// --- sync: changes ---------------------------------------------------------

function wireDoc(row: DocRow): Record<string, unknown> {
	const doc: Record<string, unknown> = {
		col: row.col,
		id: row.doc_id,
		rev: row.rev,
		seq: row.seq,
		deleted: row.deleted !== 0,
		updatedAt: row.updated_at,
		device: row.device_id,
		hash: row.content_hash,
		meta: JSON.parse(row.meta_json) as Record<string, unknown>,
	};
	if (row.payload !== null) {
		doc.payload = { alg: 'none', data: row.payload };
	}
	if (row.blob_refs !== null) {
		doc.blobs = JSON.parse(row.blob_refs) as BlobRef[];
	}
	return doc;
}

async function handleChanges(request: Request, env: Env, auth: AuthResult): Promise<Response> {
	const url = new URL(request.url);
	const sinceRaw = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
	let since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;
	// `full=1`: a continuation page of a full listing the client is
	// already reading after a reset. Its cursor is the last seq it got,
	// below the horizon by construction on every page but the last, and
	// re-clamping it would serve page one for ever.
	const full = url.searchParams.get('full') === '1';
	let reset = false;
	// A client AHEAD of the account head has met a restored database (D1
	// Time Travel, the operator's undo): its cursor points into a future
	// that no longer exists, and empty deltas would look like being in
	// sync forever. Full reconcile instead.
	if (since > auth.user.change_seq) {
		since = 0;
		reset = true;
	}
	// A client behind the tombstone-purge horizon cannot trust a delta:
	// deletions it never saw are gone. Full listing plus the content
	// reconcile instead.
	if (!full && since < auth.user.horizon_seq) {
		since = 0;
		reset = true;
	}
	const rows = await env.DB.prepare(
		`SELECT * FROM docs WHERE user_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ${CHANGES_PAGE + 1}`,
	)
		.bind(auth.user.id, since)
		.all<DocRow>();
	// Cut by count AND by bytes (at least one row, so a page always
	// advances); a cut page reports `more` whichever bound it hit.
	const page: DocRow[] = [];
	let bytes = 0;
	for (const row of rows.results.slice(0, CHANGES_PAGE)) {
		const size = (row.payload === null ? 0 : row.payload.length) + 512;
		if (page.length > 0 && bytes + size > CHANGES_PAGE_BYTES) {
			break;
		}
		page.push(row);
		bytes += size;
	}
	const more = rows.results.length > page.length;
	const seq = page.length > 0 ? page[page.length - 1].seq : since;
	const out: Record<string, unknown> = { seq, more, docs: page.map(wireDoc) };
	if (reset) {
		out.reset = true;
	}
	return json(out);
}

// --- sync: push ------------------------------------------------------------

function isHex64(s: unknown): s is string {
	return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

function validBlobRefs(raw: unknown): BlobRef[] | null | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (!Array.isArray(raw) || raw.length > 4) {
		return null;
	}
	const out: BlobRef[] = [];
	for (const r of raw as { h?: unknown; n?: unknown }[]) {
		if (
			!r ||
			!isHex64(r.h) ||
			typeof r.n !== 'number' ||
			!Number.isInteger(r.n) ||
			r.n <= 0 ||
			r.n > BLOB_MAX_STORED
		) {
			return null;
		}
		out.push({ h: r.h, n: r.n });
	}
	return out;
}

/** Validate one pushed doc; a string names the typed refusal. */
function validPushDoc(raw: unknown): PushDocIn | string {
	const d = raw as Partial<PushDocIn> | null;
	if (!d || typeof d !== 'object') {
		return 'bad-request';
	}
	if (!(COLLECTIONS as readonly string[]).includes(d.col as string)) {
		return 'bad-request';
	}
	if (typeof d.id !== 'string' || d.id === '' || d.id.length > 200) {
		return 'bad-request';
	}
	if (typeof d.baseRev !== 'number' || !Number.isInteger(d.baseRev) || d.baseRev < 0) {
		return 'bad-request';
	}
	if (
		typeof d.deleted !== 'boolean' ||
		typeof d.updatedAt !== 'number' ||
		!Number.isSafeInteger(d.updatedAt) ||
		d.updatedAt < 0
	) {
		return 'bad-request'; // an Infinity or a fraction would store as REAL and serve as null
	}
	if (typeof d.device !== 'string' || d.device.length > 80) {
		return 'bad-request';
	}
	if (typeof d.hash !== 'string' || d.hash.length > 128) {
		return 'bad-request';
	}
	if (!d.meta || typeof d.meta !== 'object') {
		return 'bad-request';
	}
	if (byteLength(JSON.stringify(d.meta)) > META_MAX_BYTES) {
		return 'doc-too-large';
	}
	const blobs = validBlobRefs(d.blobs);
	if (blobs === null) {
		return 'bad-request';
	}
	if (!d.deleted) {
		if (d.payload !== undefined) {
			if (
				typeof d.payload !== 'object' ||
				d.payload.alg !== 'none' ||
				typeof d.payload.data !== 'string'
			) {
				return 'bad-request';
			}
			if (byteLength(d.payload.data) > INLINE_MAX_BYTES) {
				return 'doc-too-large';
			}
		}
		if (d.payload === undefined && blobs === undefined) {
			return 'bad-request';
		}
	}
	const out: PushDocIn = {
		col: d.col as Collection,
		id: d.id,
		baseRev: d.baseRev,
		deleted: d.deleted,
		updatedAt: d.updatedAt,
		device: d.device,
		hash: d.hash,
		meta: d.meta,
	};
	if (!d.deleted && d.payload !== undefined) {
		out.payload = d.payload;
	}
	if (!d.deleted && blobs !== undefined) {
		out.blobs = blobs;
	}
	return out;
}

/** The recompute that keeps `bytes_used` honest without reading R2:
 *  inline payload bytes plus the LEDGER's stored size of every blob a
 *  doc references (never the size the ref itself claims). A closing
 *  batch statement, never delta bookkeeping. */
const BYTES_RECOMPUTE = `UPDATE users SET bytes_used =
	COALESCE((SELECT SUM(LENGTH(CAST(payload AS BLOB))) FROM docs
		WHERE user_id = ?1 AND payload IS NOT NULL), 0)
	+ COALESCE((SELECT SUM(b.n) FROM blobs b WHERE b.user_id = ?1 AND b.hash IN (
		SELECT json_extract(j.value, '$.h') FROM docs d, json_each(d.blob_refs) j
		WHERE d.user_id = ?1 AND d.blob_refs IS NOT NULL)), 0)
	WHERE id = ?1`;

/** Make sure every referenced blob is the account's: a hash the ledger
 *  knows passes; one the ledger lacks but R2 holds (an upload from
 *  before the ledger existed) gets its row from the object's own size;
 *  one R2 lacks too is a ref to nothing and names the refusal. */
async function ensureBlobsHeld(env: Env, uid: string, hashes: string[]): Promise<string | null> {
	const known = new Set<string>();
	for (let i = 0; i < hashes.length; i += SQL_IN_CHUNK) {
		const chunk = hashes.slice(i, i + SQL_IN_CHUNK);
		const marks = chunk.map((_, k) => `?${k + 2}`).join(', ');
		const rows = await env.DB.prepare(
			`SELECT hash FROM blobs WHERE user_id = ?1 AND hash IN (${marks})`,
		)
			.bind(uid, ...chunk)
			.all<{ hash: string }>();
		for (const r of rows.results) {
			known.add(r.hash);
		}
	}
	for (const h of hashes) {
		if (known.has(h)) {
			continue;
		}
		const obj = await env.BLOBS.head(blobKey(uid, h));
		if (!obj) {
			return h;
		}
		await env.DB.prepare(
			'INSERT OR IGNORE INTO blobs (user_id, hash, n, uploaded_at) VALUES (?1, ?2, ?3, ?4)',
		)
			.bind(uid, h, obj.size, Date.now())
			.run();
	}
	return null;
}

async function handlePush(request: Request, env: Env, auth: AuthResult): Promise<Response> {
	const body = (await readJsonCapped(request, PUSH_MAX_BODY)) as { docs?: unknown } | null;
	if (!body || !Array.isArray(body.docs) || body.docs.length === 0) {
		return errJson('bad-request', 400);
	}
	if (body.docs.length > PUSH_MAX_DOCS) {
		return errJson('too-many-docs', 413, { limit: PUSH_MAX_DOCS });
	}
	const docs: PushDocIn[] = [];
	for (const raw of body.docs) {
		const doc = validPushDoc(raw);
		if (typeof doc === 'string') {
			return errJson(doc, doc === 'bad-request' ? 400 : 413);
		}
		docs.push(doc);
	}
	// Quota and count pre-checks, approximate on purpose (the closing
	// recompute lands the truth; the blob PUT enforces actual sizes).
	const incoming = docs.reduce(
		(sum, d) =>
			sum +
			(d.payload ? byteLength(d.payload.data) : 0) +
			(d.blobs ? d.blobs.reduce((s, b) => s + b.n, 0) : 0),
		0,
	);
	if (auth.user.bytes_used + incoming > QUOTA_BYTES) {
		return errJson('quota-exceeded', 413, { quotaBytes: QUOTA_BYTES, bytesUsed: auth.user.bytes_used });
	}
	const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM docs WHERE user_id = ?1')
		.bind(auth.user.id)
		.first<{ n: number }>();
	if ((count?.n ?? 0) + docs.length > DOCS_MAX) {
		return errJson('too-many-docs', 413, { limit: DOCS_MAX });
	}
	const uid = auth.user.id;
	const refHashes = [...new Set(docs.flatMap((d) => (d.blobs ?? []).map((b) => b.h)))];
	if (refHashes.length > 0) {
		const unknown = await ensureBlobsHeld(env, uid, refHashes);
		if (unknown !== null) {
			return errJson('blob-unknown', 400, { hash: unknown });
		}
	}
	const now = Date.now();
	const stmts: D1PreparedStatement[] = [];
	const bump = env.DB.prepare('UPDATE users SET change_seq = change_seq + 1 WHERE id = ?1').bind(uid);
	const upsert = env.DB.prepare(
		`INSERT INTO docs (user_id, col, doc_id, rev, seq, deleted, updated_at, device_id,
			content_hash, meta_json, payload, blob_refs, server_at)
		VALUES (?1, ?2, ?3, 1, (SELECT change_seq FROM users WHERE id = ?1),
			?4, ?5, ?6, ?7, ?8, ?9, ?10, ?12)
		ON CONFLICT (user_id, col, doc_id) DO UPDATE SET
			rev = docs.rev + 1,
			seq = (SELECT change_seq FROM users WHERE id = ?1),
			deleted = excluded.deleted,
			updated_at = excluded.updated_at,
			device_id = excluded.device_id,
			content_hash = excluded.content_hash,
			meta_json = excluded.meta_json,
			payload = excluded.payload,
			blob_refs = excluded.blob_refs,
			server_at = excluded.server_at
		WHERE docs.rev = ?11
		RETURNING rev, seq`,
	);
	for (const d of docs) {
		stmts.push(bump);
		stmts.push(
			upsert.bind(
				uid,
				d.col,
				d.id,
				d.deleted ? 1 : 0,
				d.updatedAt,
				d.device,
				// A tombstone clears its payload AND its blob refs (the GC
				// convention) and hashes as ''.
				d.deleted ? '' : d.hash,
				JSON.stringify(d.meta),
				d.deleted || d.payload === undefined ? null : d.payload.data,
				d.deleted || d.blobs === undefined ? null : JSON.stringify(d.blobs),
				d.baseRev,
				now,
			),
		);
	}
	// A blob a pushed doc now references leaves the orphans ledger at
	// once (the sweep would heal it too, but until then the quota and the
	// ceilings would count the bytes twice: once in bytes_used, once
	// parked).
	stmts.push(
		env.DB.prepare(
			`DELETE FROM orphans WHERE user_id = ?1 AND hash IN (
				SELECT j.value->>'h' FROM docs, json_each(docs.blob_refs) AS j
				WHERE docs.user_id = ?1 AND docs.blob_refs IS NOT NULL)`,
		).bind(uid),
	);
	stmts.push(env.DB.prepare(BYTES_RECOMPUTE).bind(uid));
	const batch = await env.DB.batch(stmts);
	const results: Record<string, unknown>[] = [];
	for (let i = 0; i < docs.length; i++) {
		const rows = batch[i * 2 + 1].results as { rev: number; seq: number }[] | undefined;
		if (rows && rows.length > 0) {
			results.push({ ok: true, rev: rows[0].rev, seq: rows[0].seq });
			continue;
		}
		// The precondition failed: read the row and apply the idempotency
		// clause SERVER-side (a retried push whose intent already stands
		// answers ok, never a fabricated conflict).
		const d = docs[i];
		const server = await env.DB.prepare(
			'SELECT * FROM docs WHERE user_id = ?1 AND col = ?2 AND doc_id = ?3',
		)
			.bind(uid, d.col, d.id)
			.first<DocRow>();
		if (!server) {
			// Vanished between the batch and this read (a concurrent purge):
			// let the client retry.
			results.push({ ok: false, conflict: true, server: null });
			continue;
		}
		const serverDeleted = server.deleted !== 0;
		if (
			(d.deleted && serverDeleted) ||
			(!d.deleted && !serverDeleted && server.content_hash === d.hash)
		) {
			results.push({ ok: true, rev: server.rev, seq: server.seq });
		} else {
			results.push({ ok: false, conflict: true, server: wireDoc(server) });
		}
	}
	return json({ results });
}

// --- blobs -----------------------------------------------------------------

function blobKey(uid: string, hash: string): string {
	return `u/${uid}/b/${hash}`;
}

async function handleBlobPut(
	request: Request,
	env: Env,
	auth: AuthResult,
	hash: string,
): Promise<Response> {
	const existing = await env.BLOBS.head(blobKey(auth.user.id, hash));
	if (existing) {
		// Content-addressed: the same IGC imported on desktop and phone
		// stores once. The object is about to be referenced again, so a
		// grace clock ticking on it re-arms (the sweep could otherwise
		// delete it between this dedupe hit and the doc push), and an
		// object from before the ledger gets its row now.
		await env.DB.batch([
			env.DB.prepare(
				'INSERT OR IGNORE INTO blobs (user_id, hash, n, uploaded_at) VALUES (?1, ?2, ?3, ?4)',
			).bind(auth.user.id, hash, existing.size, Date.now()),
			env.DB.prepare(
				'UPDATE orphans SET orphaned_at = ?3, n = ?4 WHERE user_id = ?1 AND hash = ?2',
			).bind(auth.user.id, hash, Date.now(), existing.size),
		]);
		return json({ ok: true, existed: true });
	}
	const bytes = await readBytesCapped(request, BLOB_MAX_STORED);
	if (bytes === null) {
		return errJson('blob-too-large', 413, { limit: BLOB_MAX_STORED });
	}
	if (bytes.length === 0) {
		return errJson('bad-request', 400);
	}
	// Uploads count from the moment they land: bytes_used only sums
	// doc-referenced blobs, so the not-yet-pushed ones ride the orphans
	// table's n column (the sweep's heal removes the row once a doc
	// references the hash). Without this, 120 puts a minute x 25 MB
	// would park unbounded bytes for the whole 30-day grace.
	const parked = await env.DB.prepare(
		'SELECT COALESCE(SUM(n), 0) AS n FROM orphans WHERE user_id = ?1',
	)
		.bind(auth.user.id)
		.first<{ n: number }>();
	if (auth.user.bytes_used + (parked?.n ?? 0) + bytes.length > QUOTA_BYTES) {
		return errJson('quota-exceeded', 413, {
			quotaBytes: QUOTA_BYTES,
			bytesUsed: auth.user.bytes_used,
		});
	}
	await env.BLOBS.put(blobKey(auth.user.id, hash), bytes);
	// The ledger row carries the ACTUAL stored size (what the quota sums);
	// the orphans row is the grace clock until a doc references it.
	await env.DB.batch([
		env.DB.prepare(
			'INSERT OR REPLACE INTO blobs (user_id, hash, n, uploaded_at) VALUES (?1, ?2, ?3, ?4)',
		).bind(auth.user.id, hash, bytes.length, Date.now()),
		env.DB.prepare(
			'INSERT OR IGNORE INTO orphans (user_id, hash, orphaned_at, n) VALUES (?1, ?2, ?3, ?4)',
		).bind(auth.user.id, hash, Date.now(), bytes.length),
	]);
	return json({ ok: true, existed: false });
}

async function handleBlobGet(env: Env, auth: AuthResult, hash: string): Promise<Response> {
	const obj = await env.BLOBS.get(blobKey(auth.user.id, hash));
	if (!obj) {
		return errJson('not-found', 404);
	}
	return new Response(obj.body, {
		headers: {
			'content-type': 'application/octet-stream',
			// Never in the browser's HTTP cache, immutable as the content is:
			// the client lands blobs in IndexedDB, and a cached copy would
			// outlive the shared machine's wipe (URL-keyed, bearer ignored).
			'cache-control': 'no-store',
		},
	});
}

// --- account ---------------------------------------------------------------

async function handleAccountGet(env: Env, auth: AuthResult): Promise<Response> {
	const sessions = await env.DB.prepare(
		'SELECT id, device_name, mode, created_at, last_seen FROM sessions WHERE user_id = ?1 ORDER BY last_seen DESC',
	)
		.bind(auth.user.id)
		.all<{ id: string; device_name: string; mode: string; created_at: number; last_seen: number }>();
	return json({
		email: auth.user.email,
		bytesUsed: auth.user.bytes_used,
		quotaBytes: QUOTA_BYTES,
		status: auth.user.status,
		deleteAfter: auth.user.delete_after,
		sessions: sessions.results.map((s) => ({
			id: s.id,
			deviceName: s.device_name,
			mode: s.mode,
			createdAt: s.created_at,
			lastSeen: s.last_seen,
			current: s.id === auth.session.id,
		})),
	});
}

async function handleSessionPatch(request: Request, env: Env, auth: AuthResult): Promise<Response> {
	const body = (await readJsonCapped(request, 4 * 1024)) as { deviceName?: unknown } | null;
	if (typeof body?.deviceName !== 'string' || body.deviceName.trim() === '') {
		return errJson('bad-request', 400);
	}
	await env.DB.prepare('UPDATE sessions SET device_name = ?1 WHERE id = ?2')
		.bind(body.deviceName.trim().slice(0, 60), auth.session.id)
		.run();
	return json({ ok: true });
}

async function handleSessionDelete(env: Env, auth: AuthResult, id: string): Promise<Response> {
	await env.DB.prepare('DELETE FROM sessions WHERE id = ?1 AND user_id = ?2')
		.bind(id, auth.user.id)
		.run();
	return json({ ok: true });
}

async function handleSessionsDeleteAll(
	request: Request,
	env: Env,
	auth: AuthResult,
): Promise<Response> {
	const body = await readJsonCapped(request, 4 * 1024);
	if (!(await sudoOk(env, auth.user, body))) {
		return errJson('sudo-required', 403);
	}
	await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(auth.user.id).run();
	return json({ ok: true });
}

/** DELETE /v1/account (sudo): the STAGED deletion. Sessions are revoked
 *  immediately, so the account stops working the moment it is asked;
 *  the data purges 7 days later by the cron, and signing in during the
 *  window cancels it (the one irreversible thing a confused or annoyed
 *  user does at speed; docs/accounts-sync.md, Lifecycle). */
async function handleAccountDelete(request: Request, env: Env, auth: AuthResult): Promise<Response> {
	const body = await readJsonCapped(request, 4 * 1024);
	if (!(await sudoOk(env, auth.user, body))) {
		return errJson('sudo-required', 403);
	}
	const deleteAfter = Date.now() + DELETE_STAGE_MS;
	await env.DB.batch([
		env.DB.prepare("UPDATE users SET status = 'pending_delete', delete_after = ?1 WHERE id = ?2").bind(
			deleteAfter,
			auth.user.id,
		),
		env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(auth.user.id),
	]);
	return json({ ok: true, deleteAfter });
}

async function handleAccountRestore(env: Env, auth: AuthResult): Promise<Response> {
	if (deletionSealed(auth.user, Date.now())) {
		return errJson('account-pending-delete', 403, { deleteAfter: auth.user.delete_after });
	}
	if (auth.user.status !== 'pending_delete') {
		return json({ ok: true, status: auth.user.status });
	}
	await env.DB.prepare(
		"UPDATE users SET status = 'active', delete_after = NULL WHERE id = ?1",
	)
		.bind(auth.user.id)
		.run();
	return json({ ok: true, status: 'active' });
}

// --- cron ------------------------------------------------------------------

async function sweepPurgeStaged(env: Env, now: number): Promise<void> {
	const due = await env.DB.prepare(
		"SELECT id FROM users WHERE status = 'pending_delete' AND delete_after IS NOT NULL AND delete_after < ?1",
	)
		.bind(now)
		.all<{ id: string }>();
	for (const { id } of due.results) {
		// CLAIM before destruction, atomically: a restore landing between
		// the SELECT above and here must win, and one landing DURING the
		// R2 walk below must lose (it would otherwise revive a user row
		// whose docs and blobs are gone). `purging` refuses sign-in and
		// restore alike (deletionSealed).
		const claim = await env.DB.prepare(
			"UPDATE users SET status = 'purging' WHERE id = ?1 AND status = 'pending_delete' AND delete_after < ?2",
		)
			.bind(id, now)
			.run();
		if (claim.meta.changes === 0) {
			continue;
		}
		// The whole prefix, grace bypassed: the deletion was staged, warned
		// and waited for (docs/accounts-sync.md).
		let cursor: string | undefined;
		do {
			const listing = await env.BLOBS.list({
				prefix: `u/${id}/b/`,
				...(cursor !== undefined ? { cursor } : {}),
			});
			if (listing.objects.length > 0) {
				await env.BLOBS.delete(listing.objects.map((o) => o.key));
			}
			cursor = listing.truncated ? listing.cursor : undefined;
		} while (cursor !== undefined);
		await env.DB.batch([
			env.DB.prepare('DELETE FROM docs WHERE user_id = ?1').bind(id),
			env.DB.prepare('DELETE FROM orphans WHERE user_id = ?1').bind(id),
			env.DB.prepare('DELETE FROM blobs WHERE user_id = ?1').bind(id),
			env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id),
			env.DB.prepare("DELETE FROM users WHERE id = ?1 AND status = 'purging'").bind(id),
		]);
		logError('account-purged', { userId: id });
	}
}

async function sweepTombstones(env: Env, now: number): Promise<void> {
	const cutoff = now - TOMBSTONE_KEEP_MS;
	// The horizon moves BEFORE the rows go: a client whose `since`
	// predates it gets reset:true and reconciles by content instead of
	// trusting a delta with holes.
	// Retention keys on the SERVER stamp; rows from before the column
	// (server_at 0) fall back to the client clock they were stored with.
	const horizons = await env.DB.prepare(
		`SELECT user_id, MAX(seq) AS m FROM docs
		WHERE deleted = 1 AND COALESCE(NULLIF(server_at, 0), updated_at) < ?1 GROUP BY user_id`,
	)
		.bind(cutoff)
		.all<{ user_id: string; m: number }>();
	const stmts: D1PreparedStatement[] = horizons.results.map((h) =>
		env.DB.prepare('UPDATE users SET horizon_seq = MAX(horizon_seq, ?1) WHERE id = ?2').bind(
			h.m,
			h.user_id,
		),
	);
	stmts.push(
		env.DB.prepare(
			'DELETE FROM docs WHERE deleted = 1 AND COALESCE(NULLIF(server_at, 0), updated_at) < ?1',
		).bind(cutoff),
	);
	if (stmts.length > 0) {
		await env.DB.batch(stmts);
	}
}

/** The blob GC (docs/accounts-sync.md, Operating): a diff pass. The
 *  orphans table is the grace clock, first-seen-unreferenced; a
 *  re-reference heals; nothing is deleted before 30 days, so any D1
 *  state Time Travel can restore still finds its blobs. It also
 *  catches the uploaded-then-never-referenced blob (a client that
 *  crashed between PUT and push), which per-drop bookkeeping would
 *  leak forever. */
async function sweepOrphans(env: Env, now: number): Promise<void> {
	// Heal globally first: an orphan row whose hash is referenced again
	// is no orphan.
	await env.DB.prepare(
		`DELETE FROM orphans WHERE EXISTS (
			SELECT 1 FROM docs d, json_each(d.blob_refs) j
			WHERE d.user_id = orphans.user_id AND d.blob_refs IS NOT NULL
				AND json_extract(j.value, '$.h') = orphans.hash)`,
	).run();
	const users = await env.DB.prepare("SELECT id FROM users WHERE status != 'pending_delete'").all<{
		id: string;
	}>();
	for (const { id } of users.results) {
		const referenced = new Set(
			(
				await env.DB.prepare(
					`SELECT DISTINCT json_extract(j.value, '$.h') AS h
					FROM docs d, json_each(d.blob_refs) j
					WHERE d.user_id = ?1 AND d.blob_refs IS NOT NULL`,
				)
					.bind(id)
					.all<{ h: string }>()
			).results.map((r) => r.h),
		);
		const prefix = `u/${id}/b/`;
		let cursor: string | undefined;
		do {
			const listing = await env.BLOBS.list({
				prefix,
				...(cursor !== undefined ? { cursor } : {}),
			});
			for (const obj of listing.objects) {
				const hash = obj.key.slice(prefix.length);
				// The listing is also the ledger's backfill for objects stored
				// before it existed, at their real size.
				await env.DB.prepare(
					'INSERT OR IGNORE INTO blobs (user_id, hash, n, uploaded_at) VALUES (?1, ?2, ?3, ?4)',
				)
					.bind(id, hash, obj.size, now)
					.run();
				if (!referenced.has(hash)) {
					await env.DB.prepare(
						'INSERT OR IGNORE INTO orphans (user_id, hash, orphaned_at, n) VALUES (?1, ?2, ?3, ?4)',
					)
						.bind(id, hash, now, obj.size)
						.run();
				}
			}
			cursor = listing.truncated ? listing.cursor : undefined;
		} while (cursor !== undefined);
	}
	const due = await env.DB.prepare('SELECT user_id, hash FROM orphans WHERE orphaned_at < ?1')
		.bind(now - BLOB_GRACE_MS)
		.all<{ user_id: string; hash: string }>();
	for (const o of due.results) {
		// Re-checked per hash at delete time: a push can re-reference a
		// due orphan between the heal pass above and here, and a doc must
		// never end up pointing at a deleted blob.
		const gone = await env.DB.prepare(
			`DELETE FROM orphans WHERE user_id = ?1 AND hash = ?2 AND NOT EXISTS (
				SELECT 1 FROM docs d, json_each(d.blob_refs) j
				WHERE d.user_id = ?1 AND d.blob_refs IS NOT NULL
					AND json_extract(j.value, '$.h') = ?2)`,
		)
			.bind(o.user_id, o.hash)
			.run();
		if (gone.meta.changes > 0) {
			await env.BLOBS.delete(blobKey(o.user_id, o.hash));
			await env.DB.prepare('DELETE FROM blobs WHERE user_id = ?1 AND hash = ?2')
				.bind(o.user_id, o.hash)
				.run();
		}
	}
}

async function sweepExpiry(env: Env, now: number): Promise<void> {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM login_codes WHERE expires_at < ?1').bind(now),
		env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now),
		// bytes_used drift: the recompute over every account, correlated.
		env.DB.prepare(
			`UPDATE users SET bytes_used =
				COALESCE((SELECT SUM(LENGTH(CAST(payload AS BLOB))) FROM docs
					WHERE user_id = users.id AND payload IS NOT NULL), 0)
				+ COALESCE((SELECT SUM(b.n) FROM blobs b WHERE b.user_id = users.id AND b.hash IN (
					SELECT json_extract(j.value, '$.h') FROM docs d, json_each(d.blob_refs) j
					WHERE d.user_id = users.id AND d.blob_refs IS NOT NULL)), 0)`,
		),
	]);
}

/** The Monday report: accounts, activity, bytes, and the ceilings'
 *  headroom, the one number that matters (exceeding a free-tier ceiling
 *  is the failure that starts costing money quietly). */
async function weeklyReport(env: Env): Promise<void> {
	const totals = await env.DB.prepare(
		`SELECT COUNT(*) AS accounts, COALESCE(SUM(bytes_used), 0) AS bytes,
			SUM(CASE WHEN last_seen > ?1 THEN 1 ELSE 0 END) AS active
		FROM users`,
	)
		.bind(Date.now() - 7 * 86_400_000)
		.first<{ accounts: number; bytes: number; active: number }>();
	if (!totals || !env.REPORT_EMAIL) {
		return;
	}
	const maxAccounts = intVar(env.MAX_ACCOUNTS, DEFAULT_MAX_ACCOUNTS);
	const maxBytes = intVar(env.MAX_TOTAL_BYTES, DEFAULT_MAX_TOTAL_BYTES);
	const body =
		'Loxodrome account-api, weekly report\n\n' +
		`accounts: ${totals.accounts} of ${maxAccounts}\n` +
		`active last 7 days: ${totals.active ?? 0}\n` +
		`bytes stored: ${totals.bytes} of ${maxBytes} (${Math.round((totals.bytes / maxBytes) * 100)}%)\n`;
	try {
		await sendMail(env, env.REPORT_EMAIL, 'Loxodrome account-api weekly report', body);
	} catch (err) {
		logError('report-error', { detail: err instanceof Error ? err.message : String(err) });
	}
}

// --- router ----------------------------------------------------------------

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	const method = request.method;
	const ip = clientIp(request);

	if (path === '/v1/auth/code' && method === 'POST') {
		const rl = checkRateLimit('auth', ip);
		if (!rl.allowed) {
			return rateRefusal(rl.retryAfterS);
		}
		return handleAuthCode(request, env, ip);
	}
	if (path === '/v1/auth/verify' && method === 'POST') {
		const rl = checkRateLimit('auth', ip);
		if (!rl.allowed) {
			return rateRefusal(rl.retryAfterS);
		}
		return handleVerify(request, env, ip);
	}

	// Everything below rides the bearer.
	const bucket = path.startsWith('/v1/blobs/') ? 'blobs' : 'sync';
	const rl = checkRateLimit(bucket, ip);
	if (!rl.allowed) {
		return rateRefusal(rl.retryAfterS);
	}
	const auth = await bearerAuth(request, env);
	if (auth instanceof Response) {
		return auth;
	}
	if (auth.user.status === 'pending_delete' && !pendingDeleteAllowed(method, path)) {
		return errJson('account-pending-delete', 403, { deleteAfter: auth.user.delete_after });
	}

	if (path === '/v1/sync/changes' && method === 'GET') {
		return handleChanges(request, env, auth);
	}
	if (path === '/v1/sync/push' && method === 'POST') {
		return handlePush(request, env, auth);
	}
	const blobMatch = /^\/v1\/blobs\/([0-9a-f]{64})$/.exec(path);
	if (blobMatch) {
		if (method === 'PUT') {
			return handleBlobPut(request, env, auth, blobMatch[1]);
		}
		if (method === 'GET') {
			return handleBlobGet(env, auth, blobMatch[1]);
		}
	}
	if (path === '/v1/account' && method === 'GET') {
		return handleAccountGet(env, auth);
	}
	if (path === '/v1/account' && method === 'DELETE') {
		return handleAccountDelete(request, env, auth);
	}
	if (path === '/v1/account/restore' && method === 'POST') {
		return handleAccountRestore(env, auth);
	}
	if (path === '/v1/sessions/current' && method === 'PATCH') {
		return handleSessionPatch(request, env, auth);
	}
	if (path === '/v1/sessions/current' && method === 'DELETE') {
		return handleSessionDelete(env, auth, auth.session.id);
	}
	const sessionMatch = /^\/v1\/sessions\/([0-9a-f-]{36})$/.exec(path);
	if (sessionMatch && method === 'DELETE') {
		return handleSessionDelete(env, auth, sessionMatch[1]);
	}
	if (path === '/v1/sessions' && method === 'DELETE') {
		return handleSessionsDeleteAll(request, env, auth);
	}
	return errJson('not-found', 404);
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		// The tripwire: DEV_CODE fixes every code and bypasses Turnstile, so
		// a deploy carrying it beside the real Turnstile secret is a
		// production service anyone can sign into. Refuse to serve at all.
		if (env.DEV_CODE !== undefined && env.TURNSTILE_SECRET) {
			logError('misconfigured', { detail: 'DEV_CODE set beside TURNSTILE_SECRET' });
			return errJson('misconfigured', 500);
		}
		const origin = request.headers.get('Origin') ?? '';
		const allowed = (env.ALLOW_ORIGINS ?? DEFAULT_ALLOW_ORIGINS)
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const allowOrigin = allowed.includes(origin) ? origin : '';
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
		}
		// A browser context always sends Origin on cross-origin fetches; a
		// missing header is a non-browser caller (curl, a monitor), allowed
		// through since the bearer is the real gate. A PRESENT but foreign
		// Origin is refused, the two-workers convention.
		if (origin !== '' && allowOrigin === '') {
			return errJson('origin-not-allowed', 403);
		}
		try {
			return cors(await route(request, env), allowOrigin);
		} catch (err) {
			logError('unhandled', {
				path: new URL(request.url).pathname,
				detail: err instanceof Error ? err.message : String(err),
			});
			return cors(errJson('internal', 500), allowOrigin);
		}
	},

	scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
		const now = Date.now();
		const run = async (): Promise<void> => {
			await sweepPurgeStaged(env, now);
			await sweepTombstones(env, now);
			await sweepOrphans(env, now);
			await sweepExpiry(env, now);
			if (new Date(controller.scheduledTime).getUTCDay() === 1) {
				await weeklyReport(env);
			}
		};
		ctx.waitUntil(
			run().catch((err: unknown) => {
				logError('cron-error', { detail: err instanceof Error ? err.message : String(err) });
			}),
		);
	},
};
