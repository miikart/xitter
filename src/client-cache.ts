// Local archive of the pinned web client. Files are stored exactly as the CDN
// served them; patching happens at serve time so the archive stays pristine.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

export const CLIENT_DIR = process.env.CLIENT_DIR ?? "client";
export const CDN_ORIGIN = "https://abs.twimg.com";
// Builds from before the CDN's retention are fetched from the Internet Archive
// instead: asset names are content-hashed, so any capture of the URL is the file.
const ARCHIVE_ORIGIN = "https://web.archive.org/web/2id_";
const downloads = new Map<string, Promise<Buffer | undefined>>();

function localPath(cdnPath: string): string | undefined {
	const clean = normalize(cdnPath).replace(/^([/\\])+/, "");
	if (clean.startsWith("..")) return undefined;
	return join(CLIENT_DIR, "abs", clean);
}

export function readCached(cdnPath: string): Buffer | undefined {
	const p = localPath(cdnPath);
	// a directory (someone asked for /abs/.../) is not a file to serve
	return p && existsSync(p) && statSync(p).isFile() ? readFileSync(p) : undefined;
}

// Returns the file from the archive, downloading it from the CDN on first use.
export async function getClientFile(cdnPath: string, allowFetch = true): Promise<Buffer | undefined> {
	const cached = readCached(cdnPath);
	if (cached || !allowFetch) return cached;
	const p = localPath(cdnPath);
	if (!p || (existsSync(p) && !statSync(p).isFile())) return undefined;
	let pending = downloads.get(p);
	if (!pending) {
		pending = (async () => {
			let res = await fetch(CDN_ORIGIN + cdnPath).catch(() => undefined);
			// 2018 pages used the abs-0 alias, which is what the archive captured
			for (const host of [CDN_ORIGIN, "https://abs-0.twimg.com"])
				if (!res?.ok) res = await fetch(`${ARCHIVE_ORIGIN}/${host}${cdnPath}`, { redirect: "follow" }).catch(() => undefined);
			if (!res?.ok) return undefined;
			// the archive answers a missing file with a page, not a 404
			if (/\.js$/.test(cdnPath) && (res.headers.get("content-type") ?? "").includes("text/html")) return undefined;
			const buf = Buffer.from(await res.arrayBuffer());
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, buf);
			return buf;
		})();
		downloads.set(p, pending);
		void pending.then(() => downloads.delete(p), () => downloads.delete(p));
	}
	return pending;
}

export async function getClientFilePath(cdnPath: string): Promise<string | undefined> {
	const p = localPath(cdnPath);
	if (!p) return undefined;
	if (existsSync(p)) return statSync(p).isFile() ? p : undefined;
	return (await getClientFile(cdnPath)) ? p : undefined;
}
