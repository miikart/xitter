// Admin > Client > Archive: find the web client as the Internet Archive kept it
// (pages from 2018 on) and add a capture to client/builds/ like any other pin.
//
// Only some captures are the web app. Early ones, and most of mobile.twitter.com
// before the app replaced it, are server-rendered pages with nothing to run, so
// every capture is checked when it is imported. The archive throttles clients
// that ask quickly: requests here go one at a time and wait on a 429.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Build } from "./build";
import { BUILDS_DIR, listBuilds } from "./client-update";
import { getClientFile } from "./client-cache";
import { snapshotPage } from "./client-snapshot";

const ARCHIVE = "https://web.archive.org";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
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

export type Capture = { timestamp: string; page: string; date: string };

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

// one capture a month of each page that boots the app, oldest first
export async function listCaptures(from: number, to: number): Promise<Capture[]> {
	const found = new Map<string, Capture>();
	for (const page of PAGES) {
		const url = `${ARCHIVE}/cdx/search/cdx?url=${encodeURIComponent(page)}&from=${from}&to=${to}&output=txt&fl=timestamp&filter=statuscode:200&collapse=timestamp:6`;
		const res = await archiveFetch(url);
		if (!res.ok) throw new Error(`The archive's index answered ${res.status}.`);
		for (const timestamp of (await res.text()).split("\n").map((l) => l.trim()).filter((l) => STAMP.test(l)))
			found.set(`${page}@${timestamp}`, { timestamp, page, date: dateOf(timestamp) });
	}
	return [...found.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

let busy = false;

// Take one capture into the library as <id>. The entry scripts are downloaded
// now, so a build that can't be rebuilt from the archive is refused rather than
// left half there.
export async function importCapture(timestamp: string, page: string, id?: string): Promise<{ id: string; sha: string; date: string; existing: boolean }> {
	if (!STAMP.test(timestamp)) throw new Error("Bad capture time.");
	if (!PAGES.includes(page)) throw new Error("That page isn't one the archive import knows.");
	if (busy) throw new Error("An archive import is already running.");
	busy = true;
	try {
		const res = await archiveFetch(`${ARCHIVE}/web/${timestamp}id_/https://${page}`);
		if (!res.ok) throw new Error(`The archive has no usable copy of ${page} at that time (${res.status}).`);
		const html = await res.text();
		let snap: ReturnType<typeof snapshotPage>;
		try {
			// the capture's own time, not the (nearest) one the archive returned
			snap = snapshotPage(html, new Date(`${dateOf(timestamp)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}Z`));
		} catch (e: any) {
			throw new Error(`That capture isn't usable: ${e.message}.`);
		}
		const same = listBuilds().find((b) => b.sha === snap.build.sha);
		if (same) return { id: same.id, sha: same.sha, date: dateOf(timestamp), existing: true };

		const name = id && id.trim() ? id.trim() : `${dateOf(timestamp).slice(0, 7)}-${snap.build.sha.slice(0, 8)}`;
		if (!ID_NAME.test(name)) throw new Error("Use letters, numbers, dots, dashes or underscores.");
		const dir = join(BUILDS_DIR, name);
		if (existsSync(join(dir, "build.json"))) throw new Error(`There is already a build called ${name}.`);

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
		return { id: name, sha: build.sha, date: dateOf(timestamp), existing: false };
	} finally {
		busy = false;
	}
}
