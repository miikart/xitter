import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Build } from "./build";
import { BUILDS_DIR, listBuilds } from "./client-update";
import { getClientFile, readUpTo } from "./client-cache";
import { snapshotPage } from "./client-snapshot";
import catalogData from "./client-archive-catalog.json";

const ARCHIVE = "https://web.archive.org";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
export const ARCHIVE_FIRST_YEAR = Number(catalogData[0].timestamp.slice(0, 4));
const CATALOG = catalogData as { timestamp: string; page: string; kind: "responsive" | "indexed" }[];
const LITE_PAGES = ["mobile.twitter.com/", "mobile.twitter.com/home"];
// pages that boot the web app (the archive has them from different years;
// each capture is checked on import, so a page that was the old site is refused)
const PAGES = [
	"twitter.com/home", "twitter.com/", "twitter.com/explore", "twitter.com/search", "twitter.com/notifications", "twitter.com/messages",
	"twitter.com/settings", "twitter.com/i/trends", "twitter.com/i/bookmarks", "twitter.com/compose/tweet",
	"twitter.com/login", "twitter.com/i/flow/login", "twitter.com/i/flow/signup",
	"twitter.com/i/tweetdeck", "x.com/i/tweetdeck", "x.com/explore",
];
const ID_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const STAMP = /^\d{14}$/;

type ArchiveImport = { id: string; sha: string; date: string; existing: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let queue: Promise<unknown> = Promise.resolve();
let lastAt = 0;

// one request at a time, a second apart; waits and retries when throttled
async function archiveFetch(url: string, tries = 4): Promise<Response> {
	const run = async () => {
		let last: unknown;
		for (let i = 0; i < tries; i++) {
			await sleep(Math.max(0, lastAt + 1000 - Date.now()));
			try {
				const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(60_000) });
				lastAt = Date.now();
				if (res.status !== 429 && res.status < 500) return res;
				last = new Error(`the archive answered ${res.status}`);
			} catch (e) {
				lastAt = Date.now();
				last = e;
			}
			await sleep(5000 * 2 ** i);
		}
		throw new Error(`The Internet Archive isn't answering (${(last as Error)?.message ?? last}). It limits fast clients; try again in a few minutes.`);
	};
	const next = queue.then(run, run);
	queue = next.catch(() => {});
	return next;
}

const dateOf = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

export function listCaptures(from: number, to: number) {
	return CATALOG.filter(({ timestamp }) => {
		const year = Number(timestamp.slice(0, 4));
		return year >= from && year <= to;
	}).map((capture) => ({ ...capture, date: dateOf(capture.timestamp) }));
}

let busy = false;

async function captureHtml(timestamp: string, page: string) {
	const res = await archiveFetch(`${ARCHIVE}/web/${timestamp}id_/https://${page}`);
	if (!res.ok) throw new Error(`Wayback could not check ${page} (${res.status}).`);
	const html = await readUpTo(res, 8 * 1024 * 1024);
	if (!html?.length) throw new Error("The capture is empty or too large.");
	return html.toString("utf8");
}

export async function importCapture(timestamp: string, page: string, id?: string): Promise<ArchiveImport> {
	if (!STAMP.test(timestamp)) throw new Error("Bad capture time.");
	if (!PAGES.includes(page) && !LITE_PAGES.includes(page)) throw new Error("That page isn't one the archive import knows.");
	const name = id?.trim();
	if (name && (!ID_NAME.test(name) || name === "." || name === ".." || name.startsWith(".import-"))) throw new Error("Enter a valid build name using letters, numbers, dots, dashes or underscores.");
	if (busy) throw new Error("An archive import is already running.");
	busy = true;
	try {
		const html = await captureHtml(timestamp, page);
		let snap: ReturnType<typeof snapshotPage>;
		try {
			snap = snapshotPage(html, new Date(`${dateOf(timestamp)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}Z`));
		} catch (e) {
			throw new Error(`That capture isn't usable: ${(e as Error).message}.`);
		}
		const same = listBuilds().find((b) => b.sha === snap.build.sha);
		if (same) return { id: same.id, sha: same.sha, date: dateOf(timestamp), existing: true };

		const buildId = name || `${dateOf(timestamp).slice(0, 7)}-${snap.build.sha.slice(0, 8)}`;
		const dir = join(BUILDS_DIR, buildId);
		if (existsSync(join(dir, "build.json"))) throw new Error(`There is already a build called ${buildId}.`);

		let runtime = snap.runtime;
		if (snap.runtimeScript) {
			const loader = await getClientFile(snap.runtimeScript);
			if (!loader) throw new Error(`${snap.runtimeScript} is neither on the CDN nor in the archive, so this build can't be run.`);
			runtime += `\n${loader.toString("utf8")}`;
		}
		for (const path of snap.build.scripts)
			if (!(await getClientFile(path))) throw new Error(`${path} is neither on the CDN nor in the archive, so this build can't be run.`);

		// archived sign-in dialogs call endpoints that no longer exist: guests get the form
		const build: Build = { ...snap.build, legacy_login: true };
		mkdirSync(dir, { recursive: true });
		try {
			writeFileSync(join(dir, "build.json"), JSON.stringify(build, null, "\t"));
			writeFileSync(join(dir, "runtime.js"), runtime);
		} catch (e) {
			rmSync(dir, { recursive: true, force: true });
			throw e;
		}
		return { id: buildId, sha: build.sha, date: dateOf(timestamp), existing: false };
	} finally {
		busy = false;
	}
}
