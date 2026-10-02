/* A browser just large enough for Leaflet 1.9.4 to load, build a map and run
 * a canvas renderer in Node, for the specs that need Leaflet's own code rather
 * than a stand-in (the projection pinned bit for bit, the canvas layers and
 * their worker, the tile layers, the lines the paint strokes against the ones
 * Leaflet strokes). Install it BEFORE importing leaflet: the UMD build binds
 * requestAnimationFrame and reads its browser flags once, at import.
 *
 * The DOM is the handful of properties Leaflet touches, markers included: tag
 * names upper-case as the browser reports them (DivIcon.createIcon reuses an
 * icon only when its tagName is 'DIV', and a spec about what survives a
 * setIcon depends on that reuse), attributes (a keyboard-reachable marker sets
 * its role), and a global Element class for DivIcon's `html instanceof
 * Element` test, and a box at the viewport's origin, so a pointer's client
 * position IS its container point (Map.mouseEventToContainerPoint reads the
 * box and the borders). The canvas counts its
 * size writes and resets its context on each, as the HTML spec has it (a
 * write clears the store and the context state even at an unchanged value);
 * its context records the transform, the clears and the strokes. Animation
 * frames queue until the spec runs them. No touch, and by default no 3D
 * transforms, so Leaflet positions with left / top and never animates a zoom
 * by itself; `any3d` claims them, which is also what makes Leaflet honour a
 * fractional zoomSnap (Map._limitZoom snaps to whole zooms without 3D).
 * `bitmap` adds OffscreenCanvas and a canvas `bitmaprenderer` context, whose
 * bitmaps record whether they were closed and what was shown. `svg` adds
 * document.createElementNS, so the renderer Leaflet makes for a pane is an
 * L.SVG (its Browser.svg probe, read at import, answers true), whose viewBox
 * and each path's d say what a browser would draw; Browser.inlineSvg stays
 * false. The context also records the images it draws, the rectangles it
 * fills, the image data put on it and the text it writes, and makes patterns
 * whose transform is kept; `imageData` adds ImageData and DOMMatrix, for a
 * layer that paints pixels (the terrain shading's bitmaps, its no-data
 * dither, the radar's frame). `raster` gives each canvas its pixels: image
 * data put on it, rectangles cleared under an identity transform, and
 * another canvas drawn on it unscaled at whole pixels; a translucent pixel
 * drawn over one already there leaves BLENDED, a blend this stand-in does
 * not compute (a canvas that needed clearing first shows it). A document
 * fragment is a plain element, so a tile layer's batched insert of its tiles
 * runs (the fragment itself becomes the child, which no spec reads). */

/** An element: a style bag, a class name, children, and a size the spec sets. */
export class FakeElement {
	style: Record<string, string> = {};
	className = '';
	parentNode: FakeElement | null = null;
	readonly childNodes: FakeElement[] = [];
	clientWidth = 0;
	clientHeight = 0;
	clientLeft = 0;
	clientTop = 0;
	readonly tagName: string;
	private readonly attributes = new Map<string, string>();

	constructor(tagName: string) {
		this.tagName = tagName.toUpperCase();
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, String(value));
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number; x: number; y: number } {
		return {
			left: 0,
			top: 0,
			right: this.clientWidth,
			bottom: this.clientHeight,
			width: this.clientWidth,
			height: this.clientHeight,
			x: 0,
			y: 0,
		};
	}

	get firstChild(): FakeElement | null {
		return this.childNodes[0] ?? null;
	}

	/** Every child is an element here (GridLayer counts a level's tiles). */
	get children(): FakeElement[] {
		return this.childNodes;
	}

	get lastChild(): FakeElement | null {
		return this.childNodes[this.childNodes.length - 1] ?? null;
	}

	appendChild<T extends FakeElement>(child: T): T {
		child.parentNode?.removeChild(child);
		child.parentNode = this;
		this.childNodes.push(child);
		return child;
	}

	removeChild<T extends FakeElement>(child: T): T {
		const i = this.childNodes.indexOf(child);
		if (i >= 0) {
			this.childNodes.splice(i, 1);
		}
		child.parentNode = null;
		return child;
	}

	addEventListener(): void {}

	removeEventListener(): void {}
}

/** An element of the SVG namespace, as Leaflet's SVG renderer makes them
 *  (SVG.create): a plain element whose root answers the probe Leaflet's
 *  Browser.svg makes at import. */
export class FakeSvgElement extends FakeElement {
	createSVGRect(): Record<string, never> {
		return {};
	}
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** A canvas pattern: what it repeats, and the transform it was given. */
export class FakePattern {
	transform: unknown = null;
	constructor(readonly source: unknown) {}
	setTransform(m: unknown): void {
		this.transform = m;
	}
}

/** One drawImage: the image, its source rectangle (the whole image when
 *  none was named), where it went, and the transform it was drawn under. */
export interface DrawnImage {
	image: unknown;
	sx: number;
	sy: number;
	sw: number;
	sh: number;
	dx: number;
	dy: number;
	dw: number;
	dh: number;
	transform: Matrix;
	/** How many clears came before it: a painting's images share it. */
	after: number;
}

/** What `raster` writes where a translucent pixel was drawn over another. */
export const BLENDED = 0xdeadbeef;

/** Whether canvases hold pixels (installLeafletNode's `raster`). */
let rasterMode = false;

const isIdentity = (m: Matrix): boolean => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;

/** The 2d context calls Leaflet's canvas renderer makes, recorded. */
export class FakeContext2D {
	/** putImageData calls made on every context, since the file loaded. */
	static puts = 0;
	/** The canvas it draws on, whose pixels `raster` keeps. */
	canvas: FakeCanvas | null = null;
	/** Every drawImage, in order. */
	readonly images: DrawnImage[] = [];
	/** Every fillRect, with the style it was filled with. */
	readonly fills: { x: number; y: number; w: number; h: number; style: unknown; transform: Matrix; after: number }[] = [];
	/** Every putImageData, with the part of the data put (all of it when
	 *  none was named). */
	readonly putData: { data: unknown; x: number; y: number; dirty: { x: number; y: number; w: number; h: number } }[] = [];
	/** Every fillText and strokeText: the text, where, and how drawn. */
	readonly texts: { text: string; x: number; y: number; how: 'fill' | 'stroke'; after: number }[] = [];
	font = '';
	textAlign = '';
	textBaseline = '';
	imageSmoothingEnabled = true;
	/** The current transform, as setTransform takes it. */
	transform: Matrix = [...IDENTITY];
	/** Every clearRect, with the transform it was made under. */
	readonly clears: { x: number; y: number; w: number; h: number; transform: Matrix }[] = [];
	/** The strokeStyle of every stroke, in order: one entry per path drawn. */
	readonly strokes: string[] = [];
	globalAlpha = 1;
	fillStyle: unknown = '';
	strokeStyle = '';
	lineWidth = 1;
	lineCap = '';
	lineJoin = '';
	private stack: Matrix[] = [];

	/** What a size write does to the context: every state back to its initial value. */
	reset(): void {
		this.transform = [...IDENTITY];
		this.stack = [];
	}

	save(): void {
		this.stack.push([...this.transform]);
	}

	restore(): void {
		const t = this.stack.pop();
		if (t) {
			this.transform = t;
		}
	}

	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
		this.transform = [a, b, c, d, e, f];
	}

	scale(x: number, y: number): void {
		const [a, b, c, d, e, f] = this.transform;
		this.transform = [a * x, b * x, c * y, d * y, e, f];
	}

	translate(x: number, y: number): void {
		const [a, b, c, d, e, f] = this.transform;
		this.transform = [a, b, c, d, e + a * x + c * y, f + b * x + d * y];
	}

	clearRect(x: number, y: number, w: number, h: number): void {
		this.clears.push({ x, y, w, h, transform: [...this.transform] });
		const c = this.canvas;
		if (c?.pixels && isIdentity(this.transform)) {
			for (let yy = Math.max(0, y); yy < Math.min(c.height, y + h); yy++) {
				c.pixels.fill(0, yy * c.width + Math.max(0, x), yy * c.width + Math.min(c.width, x + w));
			}
		}
	}

	stroke(): void {
		this.strokes.push(this.strokeStyle);
	}

	fillRect(x: number, y: number, w: number, h: number): void {
		this.fills.push({ x, y, w, h, style: this.fillStyle, transform: [...this.transform], after: this.clears.length });
	}

	drawImage(image: { width?: number; height?: number }, ...a: number[]): void {
		const whole = { sx: 0, sy: 0, sw: image.width ?? 0, sh: image.height ?? 0 };
		const at =
			a.length >= 8
				? { sx: a[0], sy: a[1], sw: a[2], sh: a[3], dx: a[4], dy: a[5], dw: a[6], dh: a[7] }
				: a.length >= 4
					? { ...whole, dx: a[0], dy: a[1], dw: a[2], dh: a[3] }
					: { ...whole, dx: a[0], dy: a[1], dw: whole.sw, dh: whole.sh };
		this.images.push({ image, ...at, transform: [...this.transform], after: this.clears.length });
		const c = this.canvas;
		const src = image instanceof FakeCanvas ? image.pixels : null;
		if (!c?.pixels || !src || !isIdentity(this.transform) || at.sw !== at.dw || at.sh !== at.dh) {
			return;
		}
		if (![at.sx, at.sy, at.dx, at.dy].every((v) => Number.isInteger(v))) {
			return;
		}
		const from = image as FakeCanvas;
		for (let yy = 0; yy < at.sh; yy++) {
			const ty = at.dy + yy;
			const sy = at.sy + yy;
			if (ty < 0 || ty >= c.height || sy < 0 || sy >= from.height) {
				continue;
			}
			for (let xx = 0; xx < at.sw; xx++) {
				const tx = at.dx + xx;
				const sx = at.sx + xx;
				if (tx < 0 || tx >= c.width || sx < 0 || sx >= from.width) {
					continue;
				}
				const v = src[sy * from.width + sx];
				const k = ty * c.width + tx;
				const alpha = v >>> 24;
				if (alpha === 255 || c.pixels[k] === 0) {
					c.pixels[k] = v;
				} else if (alpha !== 0) {
					c.pixels[k] = BLENDED;
				}
			}
		}
	}

	putImageData(data: unknown, x: number, y: number, dirtyX = 0, dirtyY = 0, dirtyW?: number, dirtyH?: number): void {
		FakeContext2D.puts++;
		const size = data as { width?: number; height?: number };
		const w = dirtyW ?? size.width ?? 0;
		const h = dirtyH ?? size.height ?? 0;
		this.putData.push({ data, x, y, dirty: { x: dirtyX, y: dirtyY, w, h } });
		const c = this.canvas;
		if (!c?.pixels || !(data instanceof FakeImageData)) {
			return;
		}
		const src = new Uint32Array(data.data.buffer);
		for (let yy = dirtyY; yy < dirtyY + h; yy++) {
			const ty = y + yy;
			if (ty < 0 || ty >= c.height) {
				continue;
			}
			for (let xx = dirtyX; xx < dirtyX + w; xx++) {
				const tx = x + xx;
				if (tx >= 0 && tx < c.width) {
					c.pixels[ty * c.width + tx] = src[yy * data.width + xx];
				}
			}
		}
	}

	createPattern(source: unknown): FakePattern {
		return new FakePattern(source);
	}

	fillText(text: string, x: number, y: number): void {
		this.texts.push({ text, x, y, how: 'fill', after: this.clears.length });
	}

	strokeText(text: string, x: number, y: number): void {
		this.texts.push({ text, x, y, how: 'stroke', after: this.clears.length });
	}

	beginPath(): void {}
	closePath(): void {}
	moveTo(): void {}
	lineTo(): void {}
	arc(): void {}
	rect(): void {}
	clip(): void {}
	fill(): void {}
	setLineDash(): void {}
}

/** An ImageBitmap: its size, and whether it was closed or transferred. */
export class FakeBitmap {
	static made = 0;
	readonly id = ++FakeBitmap.made;
	closed = false;
	constructor(
		readonly width: number,
		readonly height: number,
	) {}
	close(): void {
		this.closed = true;
	}
}

/** A `bitmaprenderer` context: what it was last handed. */
export class FakeBitmapRenderer {
	shown: FakeBitmap | null = null;
	transfers = 0;
	transferFromImageBitmap(b: FakeBitmap | null): void {
		this.shown = b;
		this.transfers++;
	}
}

/** An OffscreenCanvas: a recording 2d context, and a bitmap to transfer. */
export class FakeOffscreenCanvas {
	readonly ctx = new FakeContext2D();
	constructor(
		public width: number,
		public height: number,
	) {}
	getContext(kind: string): FakeContext2D | null {
		return kind === '2d' ? this.ctx : null;
	}
	transferToImageBitmap(): FakeBitmap {
		return new FakeBitmap(this.width, this.height);
	}
}

/** Whether canvases offer a `bitmaprenderer` context (installLeafletNode). */
let bitmapRenderer = false;

/** A canvas whose backing-store size writes are counted. */
export class FakeCanvas extends FakeElement {
	/** Writes to width or height since creation. */
	sizeWrites = 0;
	readonly ctx = new FakeContext2D();
	/** Set once asked for: a canvas keeps the first kind of context it gave. */
	renderer: FakeBitmapRenderer | null = null;
	private kind: string | null = null;
	private w = 300;
	private h = 150;
	/** Its pixels, packed RGBA, row by row (`raster` only); a size write
	 *  clears them, as it clears a canvas. */
	pixels: Uint32Array | null = rasterMode ? new Uint32Array(300 * 150) : null;

	constructor() {
		super('canvas');
		this.ctx.canvas = this;
	}

	get width(): number {
		return this.w;
	}

	set width(v: number) {
		this.w = v;
		this.sizeWrites++;
		this.ctx.reset();
		this.pixels = rasterMode ? new Uint32Array(this.w * this.h) : null;
	}

	get height(): number {
		return this.h;
	}

	set height(v: number) {
		this.h = v;
		this.sizeWrites++;
		this.ctx.reset();
		this.pixels = rasterMode ? new Uint32Array(this.w * this.h) : null;
	}

	getContext(kind: string): FakeContext2D | FakeBitmapRenderer | null {
		if (this.kind !== null && this.kind !== kind) {
			return null;
		}
		if (kind === '2d') {
			this.kind = kind;
			return this.ctx;
		}
		if (kind === 'bitmaprenderer' && bitmapRenderer) {
			this.kind = kind;
			this.renderer ??= new FakeBitmapRenderer();
			return this.renderer;
		}
		return null;
	}
}

export interface LeafletNode {
	/** The window Leaflet reads; set devicePixelRatio on it between cases. */
	window: { devicePixelRatio: number };
	/** A detached element of the given size, for L.map(). */
	container(width: number, height: number): FakeElement;
	/** The animation frames queued and not yet run or cancelled. */
	pendingFrames(): number;
	/** Run the queued frames, and any they queue, in order; returns how many ran. */
	runFrames(): number;
	/** Run the frames queued now, and not those they queue; returns how many ran. */
	runFrame(): number;
}

/** Install the stand-ins on globalThis. Leaflet stays loaded for the rest of
 *  the file, so nothing is taken back down. */
/** ImageData: its size and its bytes. */
export class FakeImageData {
	readonly data: Uint8ClampedArray;
	constructor(
		readonly width: number,
		readonly height: number,
	) {
		this.data = new Uint8ClampedArray(width * height * 4);
	}
}

/** DOMMatrix, from the six-number array form: the translation is what a
 *  pattern's anchoring sets. */
export class FakeDOMMatrix {
	readonly a: number;
	readonly b: number;
	readonly c: number;
	readonly d: number;
	readonly e: number;
	readonly f: number;
	constructor(m: number[] = [1, 0, 0, 1, 0, 0]) {
		[this.a, this.b, this.c, this.d, this.e, this.f] = m;
	}
}

export function installLeafletNode(
	options: { any3d?: boolean; bitmap?: boolean; svg?: boolean; imageData?: boolean; raster?: boolean } = {},
): LeafletNode {
	rasterMode = !!options.raster;
	if (options.imageData || options.raster) {
		Object.assign(globalThis, { ImageData: FakeImageData, DOMMatrix: FakeDOMMatrix });
	}
	if (options.bitmap) {
		// What bitmapDrawLayer.ts probes for: paintings made off screen, shown
		// whole through a bitmaprenderer context.
		bitmapRenderer = true;
		Object.assign(globalThis, {
			OffscreenCanvas: FakeOffscreenCanvas,
			ImageBitmapRenderingContext: FakeBitmapRenderer,
		});
	}
	let nextFrame = 1;
	const frames = new Map<number, FrameRequestCallback>();
	const win = {
		devicePixelRatio: 1,
		screen: {},
		requestAnimationFrame: (cb: FrameRequestCallback): number => {
			const id = nextFrame++;
			frames.set(id, cb);
			return id;
		},
		cancelAnimationFrame: (id: number): void => {
			frames.delete(id);
		},
		setTimeout: globalThis.setTimeout.bind(globalThis),
		clearTimeout: globalThis.clearTimeout.bind(globalThis),
		addEventListener(): void {},
		removeEventListener(): void {},
	};
	const documentElement = new FakeElement('html');
	if (options.any3d) {
		// What Leaflet's Browser.any3d probes for (gecko3d), and the property
		// its DomUtil.setTransform then writes.
		documentElement.style = { transform: '', MozPerspective: '' };
	}
	const doc = {
		documentElement,
		body: new FakeElement('body'),
		createElement: (tag: string): FakeElement => (tag === 'canvas' ? new FakeCanvas() : new FakeElement(tag)),
		createDocumentFragment: (): FakeElement => new FakeElement('#document-fragment'),
		...(options.svg ? { createElementNS: (_ns: string, tag: string): FakeElement => new FakeSvgElement(tag) } : {}),
		getElementById: (): null => null,
		addEventListener(): void {},
		removeEventListener(): void {},
	};
	Object.assign(globalThis, { window: win, document: doc, Element: FakeElement });
	return {
		window: win,
		container(width, height) {
			const el = new FakeElement('div');
			el.clientWidth = width;
			el.clientHeight = height;
			return el;
		},
		pendingFrames: () => frames.size,
		runFrame() {
			const now = [...frames.entries()];
			frames.clear();
			for (const [, cb] of now) {
				cb(0);
			}
			return now.length;
		},
		runFrames() {
			let ran = 0;
			for (let next = frames.entries().next(); !next.done; next = frames.entries().next()) {
				const [id, cb] = next.value;
				frames.delete(id);
				cb(ran);
				if (++ran > 10_000) {
					throw new Error('animation frames never settle');
				}
			}
			return ran;
		},
	};
}
