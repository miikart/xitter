// Admin > Settings > Media: photos made smaller as they're stored, for
// instances short on disk. A photo is fitted inside the longest side the admin
// set and saved again as a JPEG at their quality; one with transparency stays a
// PNG. The smaller file wins, so nothing grows. GIFs and animated PNG and WebP
// are left alone: ffmpeg would keep only their first frame. Videos are done by
// video.ts with the same settings.
//
// Encoding again also drops what rode along in the file (EXIF, with a phone's
// GPS position), and turns the picture the way its EXIF orientation said.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "./db";
import { recordError } from "./errors";
import { newId } from "./ids";
import { AVATAR_SIDE, type Image, MEDIA_DIR, sniffImage } from "./media";
import { settings } from "./settings";
import { FFMPEG, recompressVideo, spawnLimited } from "./video";

const PHOTO_FORMATS = new Map([["image/jpeg", "jpeg_pipe"], ["image/png", "png_pipe"], ["image/webp", "webp_pipe"]]);
const PHOTO_MS = 30_000;
// decoding takes about 4 bytes a pixel: a 774 KB PNG of 16000x16000 held
// almost a gigabyte, two at a time. Bigger ones are kept as they came.
const MAX_PIXELS = 40_000_000;

// EXIF orientation 2-8 as ffmpeg filters; 1 is upright
const ORIENT: Record<number, string> = { 2: "hflip", 3: "hflip,vflip", 4: "vflip", 5: "transpose=0", 6: "transpose=1", 7: "transpose=3", 8: "transpose=2" };

export function exifOrientation(b: Buffer): number {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
	try {
		let i = 2;
		while (i + 4 <= b.length && b[i] === 0xff) {
			const marker = b[i + 1]!;
			if (marker === 0xda || marker === 0xd9) break;
			const len = b.readUInt16BE(i + 2);
			if (marker === 0xe1 && b.toString("latin1", i + 4, i + 10) === "Exif\0\0") {
				const t = i + 10;
				const le = b.toString("latin1", t, t + 2) === "II";
				const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
				const ifd = t + (le ? b.readUInt32LE(t + 4) : b.readUInt32BE(t + 4));
				for (let k = 0, n = u16(ifd); k < n; k++) {
					const entry = ifd + 2 + k * 12;
					if (u16(entry) !== 0x0112) continue;
					const v = u16(entry + 8);
					return v >= 1 && v <= 8 ? v : 1;
				}
				return 1;
			}
			i += 2 + len;
		}
	} catch {}
	return 1;
}

// whether the picture can be see-through, and whether it moves
function shapeOf(b: Buffer, mime: string): { alpha: boolean; animated: boolean } {
	if (mime === "image/png") {
		let alpha = b[25] === 4 || b[25] === 6;
		for (let i = 8; i + 8 <= b.length; ) {
			const len = b.readUInt32BE(i);
			const type = b.toString("latin1", i + 4, i + 8);
			if (type === "acTL") return { alpha, animated: true };
			if (type === "tRNS") alpha = true;
			if (type === "IDAT") break;
			i += 12 + len;
		}
		return { alpha, animated: false };
	}
	if (mime === "image/webp") {
		const chunk = b.toString("latin1", 12, 16);
		if (chunk === "VP8X") return { alpha: !!(b[20]! & 0x10), animated: !!(b[20]! & 0x02) };
		if (chunk === "VP8L") return { alpha: !!((b.readUInt32LE(21) >> 28) & 1), animated: false };
	}
	return { alpha: false, animated: false };
}

// quality 30-100 as the JPEG encoder's scale, where 2 is best and 31 worst:
// 80 is 6, about a fifth smaller than 4 and hard to tell apart from it
const qscale = (quality: number) => Math.max(2, Math.min(31, Math.round(2 + (100 - quality) / 5)));

// a few at a time beside the server, like the video queue
const MAX_RUNNING = 2;
let running = 0;
const waiting: (() => void)[] = [];
async function inTurn<T>(job: () => Promise<T>): Promise<T> {
	if (running >= MAX_RUNNING) await new Promise<void>((go) => waiting.push(go));
	running++;
	try {
		return await job();
	} finally {
		running--;
		waiting.shift()?.();
	}
}

// why the last photo couldn't be encoded, for the sweep to report
let failure: string | undefined;

// The smaller of the photo and its re-encoding; the photo itself when it's
// left alone (animated, or too big to decode); undefined when it couldn't be
// tried (not a photo, or ffmpeg failed), so it can be tried again later.
export function shrinkPhoto(data: Buffer, image: Image) {
	const { photo_max_side: side, photo_quality: quality } = settings().media;
	return encodePhoto(data, image, `scale='min(iw,${side})':'min(ih,${side})':force_original_aspect_ratio=decrease`, quality);
}

async function encodePhoto(data: Buffer, image: Image, resize: string, quality: number, profile?: "avatar" | "variant" | "typed-variant"): Promise<{ data: Buffer; image: Image } | undefined> {
	const format = PHOTO_FORMATS.get(image.mime);
	if (!format) return undefined;
	const shape = shapeOf(data, image.mime);
	if (shape.animated) return { data, image };
	if (image.width < 1 || image.height < 1 || image.width * image.height > MAX_PIXELS) return profile === "avatar" ? undefined : { data, image };
	const filters = [ORIENT[exifOrientation(data)], resize].filter(Boolean).join(",");
	const typed = profile === "typed-variant";
	let codec = ["-c:v", "mjpeg", "-q:v", String(qscale(quality)), "-pix_fmt", profile === "avatar" ? "yuvj444p" : "yuvj420p"];
	if (typed && image.mime === "image/webp") codec = ["-c:v", "libwebp", "-quality", String(quality)];
	else if (shape.alpha || (typed && image.mime === "image/png")) codec = ["-c:v", "png", "-pred", "mixed"];
	return inTurn(async () => {
		const p = spawnLimited(
			[FFMPEG, "-hide_banner", "-loglevel", "error", "-filter_threads", "1", "-threads", "1", "-noautorotate", "-protocol_whitelist", "pipe", "-f", format, "-i", "pipe:0",
				"-frames:v", "1", "-vf", filters, "-map_metadata", "-1", ...codec, "-threads", "1", "-f", "image2pipe", "pipe:1"],
			PHOTO_MS,
			"ignore",
			data,
		);
		const [bytes, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), p.exited]);
		if (code !== 0) {
			failure = `ffmpeg exited with ${code}`;
			return undefined;
		}
		const out = Buffer.from(bytes);
		const made = sniffImage(out);
		if (!made || made.width < 1 || made.height < 1) {
			failure = "ffmpeg made no picture";
			return undefined;
		}
		const resized = made.width !== image.width || made.height !== image.height;
		return profile === "avatar" || out.length < data.length || (profile && resized) ? { data: out, image: made } : { data, image };
	}).catch((e) => {
		failure = e instanceof Error ? e.message : String(e);
		return undefined;
	});
}

function profileResize(width: number, height: number) {
	const crop = `crop='min(iw,ih*${width}/${height})':'min(ih,iw*${height}/${width})':exact=1`;
	return `${crop},scale='min(iw,${width})':'min(ih,${height})':flags=lanczos,setsar=1`;
}

export function encodeAvatar(data: Buffer, image: Image) {
	return encodePhoto(data, image, profileResize(AVATAR_SIDE, AVATAR_SIDE), 85, "avatar");
}

type ProfileVariant = { body: Blob; mime: string; etag: string };
const profileVariants = new Map<string, ProfileVariant | undefined>();
const profileJobs = new Map<string, Promise<ProfileVariant | undefined>>();
let profileBytes = 0;

export async function profileVariant(id: string, source: Blob, mime: string, width: number, height: number, keepFormat = false): Promise<ProfileVariant | undefined> {
	const modified = (source as Blob & { lastModified?: number }).lastModified;
	if (!modified || !PHOTO_FORMATS.has(mime) || source.size > 32 * 1024 * 1024) return;
	const key = `${id}-${modified}-${source.size}-${width}x${height}${keepFormat ? `-${mime}` : ""}`;
	if (profileVariants.has(key)) {
		const hit = profileVariants.get(key);
		profileVariants.delete(key);
		profileVariants.set(key, hit);
		return hit;
	}
	const pending = profileJobs.get(key);
	if (pending) return pending;
	if (profileJobs.size >= 16) return;
	const job = (async () => {
		const bytes = Buffer.from(await source.arrayBuffer());
		const image = sniffImage(bytes);
		if (!image || image.mime !== mime) return;
		const fits = width === height && image.width === image.height && image.width <= width;
		const encoded = fits && exifOrientation(bytes) === 1
			? { data: bytes, image }
			: await encodePhoto(bytes, image, profileResize(width, height), 80, keepFormat ? "typed-variant" : "variant");
		if (!encoded) return;
		const variant = encoded.data === bytes ? undefined : {
			body: new Blob([new Uint8Array(encoded.data)]),
			mime: encoded.image.mime,
			etag: `"${Bun.hash(encoded.data).toString(36)}-profile"`,
		};
		profileVariants.set(key, variant);
		profileBytes += variant?.body.size ?? 0;
		for (const [oldKey, old] of profileVariants) {
			if (profileVariants.size <= 256 && profileBytes <= 16 * 1024 * 1024) break;
			profileVariants.delete(oldKey);
			profileBytes -= old?.body.size ?? 0;
		}
		return variant;
	})().catch(() => undefined).finally(() => profileJobs.delete(key));
	profileJobs.set(key, job);
	return job;
}

// an upload on its way to disk; `compressed` marks it done for the sweep below
export async function compressUpload(data: Buffer, image: Image): Promise<{ data: Buffer; image: Image; compressed: boolean }> {
	if (!settings().media.compress) return { data, image, compressed: false };
	const smaller = await shrinkPhoto(data, image);
	return smaller ? { ...smaller, compressed: true } : { data, image, compressed: false };
}

async function recompressPhoto(id: string): Promise<{ before: number; after: number } | undefined> {
	const file = join(MEDIA_DIR, id);
	if (!existsSync(file)) return undefined;
	const data = readFileSync(file);
	const image = sniffImage(data);
	const smaller = image && (await shrinkPhoto(data, image));
	if (!smaller) return undefined;
	if (smaller.data !== data) {
		const temp = `${file}.part${newId()}`;
		writeFileSync(temp, smaller.data);
		renameSync(temp, file);
		// marked in the same statement: a stop between two would encode it twice
		await sql`update media set mime = ${smaller.image.mime}, size = ${smaller.data.length}, width = ${smaller.image.width}, height = ${smaller.image.height}, compressed = true
			where id = ${id}::bigint`;
	}
	return { before: data.length, after: smaller.data.length };
}

// "Compress stored files": this instance's own photos and videos that were
// stored before compression was on, one at a time, oldest first. Files on other
// instances' posts are only copies and are left alone. It stops when
// compression is switched off, and a restart ends it; started again, it picks
// up with what's still not done.
export type Sweep = { running: boolean; files: number; done: number; before: number; after: number; error?: string };
let sweep: Sweep = { running: false, files: 0, done: 0, before: 0, after: 0 };
export const sweepState = (): Sweep => sweep;

const waitingFiles = () => sql`remote_instance is null and state = 'ready' and not compressed and not detached
	and (kind = 'video' or mime in ('image/jpeg', 'image/png', 'image/webp'))`;

export function startSweep(): boolean {
	if (sweep.running) return false;
	const state: Sweep = (sweep = { running: true, files: 0, done: 0, before: 0, after: 0 });
	let failed = 0;
	failure = undefined;
	void (async () => {
		const [{ n }] = await sql`select count(*)::int as n from media where ${waitingFiles()}`;
		state.files = n;
		let after = "0";
		while (settings().media.compress) {
			const rows = await sql`select id::text, kind from media where ${waitingFiles()} and id > ${after}::bigint order by id limit 50`;
			if (!rows.length) break;
			for (const r of rows) {
				if (!settings().media.compress) break;
				after = r.id;
				const saved = r.kind === "video" ? await recompressVideo(MEDIA_DIR, r.id) : await recompressPhoto(r.id);
				state.done++;
				if (!saved) {
					failed++;
					continue;
				}
				state.before += saved.before;
				state.after += saved.after;
				await sql`update media set compressed = true where id = ${r.id}::bigint`;
			}
		}
		// a missing or broken ffmpeg otherwise reads as "0 MB saved"
		if (failed) {
			state.error = `${failed} ${failed === 1 ? "file" : "files"} couldn't be compressed${failure ? `: ${failure}` : ""}`;
			await recordError("job", new Error(state.error), { path: "media compression" });
		}
	})()
		.catch((e) => {
			state.error = e instanceof Error ? e.message : String(e);
			return recordError("job", e, { path: "media compression" });
		})
		.finally(() => {
			state.running = false;
		});
	return true;
}
