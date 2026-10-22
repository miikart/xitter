// Admin > Client: re-pin the client to the build x.com serves now, as
// `bun scripts/fetch-client.ts --latest` does, keeping the previous pin to go
// back to. The guest page is what can be fetched without an account, so a pin
// taken with --token loses its signed-in feature switches here.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { BUILD_FILE, type Build, RUNTIME_FILE, loadBuild, reloadBuild } from "./build";
import { CLIENT_DIR, getClientFile } from "./client-cache";
import { brandText, clearPatchCache, patchText } from "./patch";

const PREVIOUS = { build: join(CLIENT_DIR, "build.previous.json"), runtime: join(CLIENT_DIR, "runtime.previous.js") };

// Admin > Client keeps other pins here so switching is instant. Each folder is
// a build.json + runtime.js pair; their entry files share client/abs/ because
// every build's asset names are content-hashed, so builds don't collide.
export const BUILDS_DIR = join(CLIENT_DIR, "builds");
const ID_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export function clientStatus() {
	const b = loadBuild()?.build;
	const previous = existsSync(PREVIOUS.build) ? (JSON.parse(readFileSync(PREVIOUS.build, "utf8")) as { sha: string; fetchedAt: string }) : null;
	return { sha: b?.sha ?? null, fetchedAt: b?.fetchedAt ?? null, previous: previous && { sha: previous.sha, fetchedAt: previous.fetchedAt } };
}

export async function latestSha(): Promise<string> {
	const html = await (await fetch("https://x.com/i/tweetdeck", { headers: { "user-agent": UA } })).text();
	const sha = /window\.__META_DATA__=\{.*?"sha":"([0-9a-f]{40})"/s.exec(html)?.[1];
	if (!sha) throw new Error("x.com didn't return the client page.");
	return sha;
}

// the entry scripts must still parse once patched and branded (patch.ts)
async function entryScriptsParse(): Promise<string | undefined> {
	const build = loadBuild()?.build;
	if (!build) return "no build pinned";
	const parser = new Bun.Transpiler({ loader: "js" });
	for (const path of build.scripts) {
		const raw = await getClientFile(path);
		if (!raw) return `${path} couldn't be downloaded`;
		try {
			parser.transformSync(brandText(patchText(raw.toString("utf8")), "%%%", !path.includes("/i18n/")));
		} catch {
			return `${path} doesn't parse once branded`;
		}
	}
}

function swap(from: { build: string; runtime: string }, to: { build: string; runtime: string }) {
	copyFileSync(from.build, to.build);
	copyFileSync(from.runtime, to.runtime);
}

function reload() {
	reloadBuild();
	clearPatchCache();
}

let busy = false;

export async function updateClient(): Promise<{ sha: string; changed: boolean }> {
	if (busy) throw new Error("An update is already running.");
	busy = true;
	const before = loadBuild()?.build.sha ?? null;
	const current = { build: BUILD_FILE, runtime: RUNTIME_FILE };
	const kept = existsSync(BUILD_FILE) && existsSync(RUNTIME_FILE);
	const backup = { build: `${BUILD_FILE}.updating`, runtime: `${RUNTIME_FILE}.updating` };
	try {
		if (kept) swap(current, backup);
		const run = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/fetch-client.ts"), "--latest"], { stdout: "pipe", stderr: "pipe" });
		const [code, out, err] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
		if (code !== 0) throw new Error(`fetch-client failed: ${(err || out).trim().split("\n").pop()}`);
		reload();
		const sha = loadBuild()?.build.sha ?? "";
		if (sha === before) return { sha, changed: false };
		const broken = await entryScriptsParse();
		if (broken) throw new Error(`The new build was not kept: ${broken}.`);
		if (kept) swap(backup, PREVIOUS);
		return { sha, changed: true };
	} catch (e) {
		if (kept) swap(backup, current);
		reload();
		throw e;
	} finally {
		for (const f of Object.values(backup)) if (existsSync(f)) unlinkSync(f);
		busy = false;
	}
}

export type StoredBuild = {
	id: string;
	sha: string;
	fetchedAt: string | null;
	scripts: number;
	legacyLogin: boolean;
	active: boolean;
};

// Every build kept in client/builds/, newest pin first
export function listBuilds(): StoredBuild[] {
	const active = loadBuild()?.build.sha ?? null;
	if (!existsSync(BUILDS_DIR)) return [];
	const out: StoredBuild[] = [];
	for (const id of readdirSync(BUILDS_DIR)) {
		const dir = join(BUILDS_DIR, id);
		const build = join(dir, "build.json");
		const runtime = join(dir, "runtime.js");
		if (!existsSync(build) || !existsSync(runtime)) continue;
		try {
			const b = JSON.parse(readFileSync(build, "utf8")) as { sha?: string; fetchedAt?: string; scripts?: string[]; legacy_login?: boolean };
			if (!b?.sha) continue;
			out.push({
				id,
				sha: b.sha,
				fetchedAt: b.fetchedAt ?? null,
				scripts: b.scripts?.length ?? 0,
				legacyLogin: !!b.legacy_login,
				active: b.sha === active,
			});
		} catch {}
	}
	return out.sort((a, b) => (b.fetchedAt ?? "").localeCompare(a.fetchedAt ?? ""));
}

// A build from the library, whole (its feature switches too)
export function readStoredBuild(id: string): Build | undefined {
	if (!ID_NAME.test(id)) return undefined;
	try {
		return JSON.parse(readFileSync(join(BUILDS_DIR, id, "build.json"), "utf8")) as Build;
	} catch {
		return undefined;
	}
}

// Serve a stored build. What was serving becomes "previous", so the panel's
// rollback button still works after a switch. Assets are fetched from the CDN
// on first use (client-cache.ts) or already sit in client/abs/.
export function useBuild(id: string): string {
	if (busy) throw new Error("An update is running.");
	if (!ID_NAME.test(id)) throw new Error("Bad build name.");
	const dir = join(BUILDS_DIR, id);
	const build = join(dir, "build.json");
	const runtime = join(dir, "runtime.js");
	if (!existsSync(build) || !existsSync(runtime)) throw new Error("That build isn't in the library.");
	let sha: string;
	try {
		sha = (JSON.parse(readFileSync(build, "utf8")) as { sha?: string }).sha ?? "";
	} catch {
		throw new Error("That build.json isn't readable.");
	}
	if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("That build.json has no sha.");
	if (existsSync(BUILD_FILE) && existsSync(RUNTIME_FILE)) swap({ build: BUILD_FILE, runtime: RUNTIME_FILE }, PREVIOUS);
	copyFileSync(build, BUILD_FILE);
	copyFileSync(runtime, RUNTIME_FILE);
	reload();
	return loadBuild()?.build.sha ?? "";
}

// Keep the build that is serving now in the library under a name, so it can be
// switched back to after trying another one.
export function saveCurrentBuild(id?: string): StoredBuild {
	const b = loadBuild()?.build;
	if (!b) throw new Error("No build is pinned.");
	const name = id && id.trim() ? id.trim() : b.sha.slice(0, 12);
	if (!ID_NAME.test(name)) throw new Error("Use letters, numbers, dots, dashes or underscores.");
	mkdirSync(join(BUILDS_DIR, name), { recursive: true });
	copyFileSync(BUILD_FILE, join(BUILDS_DIR, name, "build.json"));
	copyFileSync(RUNTIME_FILE, join(BUILDS_DIR, name, "runtime.js"));
	return { id: name, sha: b.sha, fetchedAt: b.fetchedAt ?? null, scripts: b.scripts.length, legacyLogin: !!b.legacy_login, active: true };
}

// the previous pin and the current one trade places
export function rollbackClient(): string {
	if (busy) throw new Error("An update is running.");
	if (!existsSync(PREVIOUS.build) || !existsSync(PREVIOUS.runtime)) throw new Error("There is no previous build.");
	const temp = { build: `${BUILD_FILE}.swap`, runtime: `${RUNTIME_FILE}.swap` };
	swap({ build: BUILD_FILE, runtime: RUNTIME_FILE }, temp);
	swap(PREVIOUS, { build: BUILD_FILE, runtime: RUNTIME_FILE });
	swap(temp, PREVIOUS);
	for (const f of Object.values(temp)) unlinkSync(f);
	reload();
	return loadBuild()?.build.sha ?? "";
}
