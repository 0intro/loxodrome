/* An in-memory origin private file system with Chromium's semantics, probed
 * on 2026-10-01 in Chromium 151 and the Android WebView 133:
 *   - a writable is staged in a swap file beside its target, `<name>.crswap`,
 *     or `<name>.1.crswap` and on while that name is taken, renamed over the
 *     target at close() and removed by abort(); keepExistingData copies the
 *     target into it;
 *   - a sync access handle takes an EXCLUSIVE lock: while one is open, a
 *     second handle, a writable, removeEntry and move are refused with
 *     NoModificationAllowedError (and an open writable refuses a handle);
 *     getFile() still answers, unflushed bytes included;
 *   - move() onto an existing name replaces it.
 * Every operation that changes a file is logged on the root, so a spec can
 * check the ORDER of writes. `releaseLocks()` is what the browser does for a
 * killed context; `flushed` is what a flush made durable. */

export type OpfsLog = string[];

function lockError(what: string): DOMException {
	return new DOMException(`${what}: locked`, 'NoModificationAllowedError');
}

export interface FakeSyncHandle {
	write(buffer: Uint8Array, opts?: { at?: number }): number;
	read(buffer: Uint8Array, opts?: { at?: number }): number;
	getSize(): number;
	truncate(size: number): void;
	flush(): void;
	close(): void;
}

export class FakeFile {
	readonly kind = 'file';
	/** Bytes as of the last flush of a sync handle (what survives a power loss). */
	flushed = new Uint8Array(0);
	syncOpen = false;
	writables = 0;
	/** A hook a spec sets to make the next sync write short (returns the count). */
	shortWrite: ((requested: number) => number) | null = null;
	constructor(
		readonly parent: FakeDir,
		public name: string,
		public data: Uint8Array = new Uint8Array(0),
	) {}

	private get log(): OpfsLog {
		return this.parent.root.log;
	}

	get locked(): boolean {
		return this.syncOpen;
	}

	getFile(): Promise<File> {
		if (this.locked && this.parent.root.getFileThrowsWhenLocked) {
			return Promise.reject(lockError(`getFile ${this.name}`));
		}
		return Promise.resolve(new File([this.data.slice()], this.name));
	}

	createWritable(opts: { keepExistingData?: boolean } = {}): Promise<unknown> {
		if (this.syncOpen) {
			return Promise.reject(lockError(`createWritable ${this.name}`));
		}
		let swapName = `${this.name}.crswap`;
		for (let n = 1; this.parent.entries_.has(swapName); n++) {
			swapName = `${this.name}.${n}.crswap`;
		}
		const swap = new FakeFile(this.parent, swapName, opts.keepExistingData ? this.data.slice() : undefined);
		this.parent.entries_.set(swapName, swap);
		this.writables++;
		let pos = 0;
		let open = true;
		const end = (): void => {
			if (open) {
				open = false;
				this.writables--;
			}
		};
		return Promise.resolve({
			seek: (p: number) => {
				pos = p;
				return Promise.resolve();
			},
			write: (chunk: Uint8Array | string) => {
				const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
				swap.data = splice(swap.data, bytes, pos);
				pos += bytes.length;
				return Promise.resolve();
			},
			truncate: (size: number) => {
				swap.data = resize(swap.data, size);
				pos = Math.min(pos, size);
				return Promise.resolve();
			},
			close: () => {
				end();
				if (this.parent.entries_.get(swapName) !== swap) {
					return Promise.reject(new DOMException('swap file gone', 'NotFoundError'));
				}
				this.parent.entries_.delete(swapName);
				this.data = swap.data;
				this.parent.entries_.set(this.name, this);
				this.log.push(`commit ${this.name} ${this.data.length}`);
				return Promise.resolve();
			},
			abort: () => {
				end();
				this.parent.entries_.delete(swapName);
				return Promise.resolve();
			},
		});
	}

	createSyncAccessHandle(): Promise<FakeSyncHandle> {
		if (this.syncOpen || this.writables > 0) {
			return Promise.reject(lockError(`createSyncAccessHandle ${this.name}`));
		}
		this.syncOpen = true;
		let open = true;
		const live = (): void => {
			if (!open) {
				throw new DOMException('closed', 'InvalidStateError');
			}
		};
		this.log.push(`lock ${this.name}`);
		const handle: FakeSyncHandle = {
			write: (buffer, opts = {}) => {
				live();
				const at = opts.at ?? 0;
				const n = this.shortWrite ? this.shortWrite(buffer.length) : buffer.length;
				this.data = splice(this.data, buffer.subarray(0, Math.max(0, n)), at);
				this.log.push(`write ${this.name} ${at} ${Math.max(0, n)}`);
				return n;
			},
			read: (buffer, opts = {}) => {
				live();
				const at = opts.at ?? 0;
				const part = this.data.subarray(at, at + buffer.length);
				buffer.set(part);
				return part.length;
			},
			getSize: () => {
				live();
				return this.data.length;
			},
			truncate: (size) => {
				live();
				this.data = resize(this.data, size);
				this.log.push(`truncate ${this.name} ${size}`);
			},
			flush: () => {
				live();
				this.flushed = this.data.slice();
				this.log.push(`flush ${this.name} ${this.data.length}`);
			},
			close: () => {
				if (!open) {
					return;
				}
				open = false;
				this.syncOpen = false;
				this.log.push(`close ${this.name}`);
			},
		};
		this.parent.root.openHandles.add({ file: this, close: () => handle.close() });
		return Promise.resolve(handle);
	}

	move(name: string): Promise<void> {
		if (this.locked || this.writables > 0) {
			return Promise.reject(lockError(`move ${this.name}`));
		}
		const existing = this.parent.entries_.get(name);
		if (existing instanceof FakeFile && existing.locked) {
			return Promise.reject(lockError(`move onto ${name}`));
		}
		this.parent.entries_.delete(this.name);
		this.log.push(`move ${this.name} ${name}`);
		this.name = name;
		this.parent.entries_.set(name, this);
		return Promise.resolve();
	}
}

export class FakeDir {
	readonly kind = 'directory';
	readonly entries_ = new Map<string, FakeFile | FakeDir>();
	readonly root: FakeRoot;
	constructor(
		readonly name: string,
		root?: FakeRoot,
	) {
		this.root = root ?? (this as unknown as FakeRoot);
	}

	getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeDir> {
		let d = this.entries_.get(name);
		if (!d && opts.create) {
			d = new FakeDir(name, this.root);
			this.entries_.set(name, d);
		}
		return d instanceof FakeDir ? Promise.resolve(d) : Promise.reject(new DOMException(name, 'NotFoundError'));
	}

	getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeFile> {
		let f = this.entries_.get(name);
		if (!f && opts.create) {
			f = new FakeFile(this, name);
			this.entries_.set(name, f);
			this.root.log.push(`create ${name}`);
		}
		return f instanceof FakeFile ? Promise.resolve(f) : Promise.reject(new DOMException(name, 'NotFoundError'));
	}

	removeEntry(name: string): Promise<void> {
		const e = this.entries_.get(name);
		if (!e) {
			return Promise.reject(new DOMException(name, 'NotFoundError'));
		}
		if (e instanceof FakeFile && (e.locked || e.writables > 0)) {
			return Promise.reject(lockError(`removeEntry ${name}`));
		}
		this.entries_.delete(name);
		this.root.log.push(`remove ${name}`);
		return Promise.resolve();
	}

	async *keys(): AsyncGenerator<string> {
		for (const k of [...this.entries_.keys()]) {
			yield await Promise.resolve(k);
		}
	}

	async *values(): AsyncGenerator<FakeFile | FakeDir> {
		for (const v of [...this.entries_.values()]) {
			yield await Promise.resolve(v);
		}
	}

	async *entries(): AsyncGenerator<[string, FakeFile | FakeDir]> {
		for (const e of [...this.entries_.entries()]) {
			yield await Promise.resolve(e);
		}
	}

	/** A file as a killed process leaves it. */
	put(name: string, bytes: number | string | Uint8Array): FakeFile {
		const data =
			bytes instanceof Uint8Array
				? bytes.slice()
				: typeof bytes === 'string'
					? new TextEncoder().encode(bytes)
					: new Uint8Array(bytes).fill(7);
		const f = new FakeFile(this, name, data);
		this.entries_.set(name, f);
		return f;
	}

	file(name: string): FakeFile | undefined {
		const f = this.entries_.get(name);
		return f instanceof FakeFile ? f : undefined;
	}

	text(name: string): string | undefined {
		const f = this.file(name);
		return f ? new TextDecoder().decode(f.data) : undefined;
	}

	names(): string[] {
		return [...this.entries_.keys()].sort();
	}
}

export class FakeRoot extends FakeDir {
	readonly log: OpfsLog = [];
	readonly openHandles = new Set<{ file: FakeFile; close: () => void }>();
	/** Make getFile() refuse a locked file (not Chromium's behaviour, which
	 *  answers: a spec uses it to prove a path never asks). */
	getFileThrowsWhenLocked = false;
	constructor() {
		super('');
	}

	/** What the browser does for a killed context: its locks go, its bytes
	 *  stay (they were in the page cache). */
	releaseLocks(): void {
		for (const h of this.openHandles) {
			h.file.syncOpen = false;
		}
		this.openHandles.clear();
	}
}

function splice(data: Uint8Array, bytes: Uint8Array, at: number): Uint8Array {
	const end = at + bytes.length;
	const out = end > data.length ? resize(data, end) : data.slice();
	out.set(bytes, at);
	return out;
}

function resize(data: Uint8Array, size: number): Uint8Array {
	const out = new Uint8Array(size);
	out.set(data.subarray(0, Math.min(size, data.length)));
	return out;
}

/** A fresh root installed as navigator.storage, for vi.stubGlobal. */
export function fakeStorage(root: FakeRoot): { storage: { getDirectory: () => Promise<FakeRoot> } } {
	return { storage: { getDirectory: () => Promise.resolve(root) } };
}
