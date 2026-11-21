// The pinned client build: what scripts/fetch-client.ts took from a signed-in
// page. Kept next to the archived bundle, outside the repository.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_DIR } from "./client-cache";
import { settings } from "./settings";
import type { Viewer } from "./auth";

export type Build = {
	sha: string;
	// CDN paths of the entry scripts, in page order (vendor, i18n, main)
	scripts: string[];
	featureSwitch: { defaultConfig: Record<string, unknown>; config: Record<string, unknown>; featureSetToken: string; settingsVersion: string; flat?: boolean };
	// page metadata minus anything about the account it was taken from
	meta: Record<string, unknown>;
	fetchedAt: string;
	// an archived build whose own sign-in dialog can't complete against this
	// server (the 2022 client sends people to /i/flow/login): guests get the
	// plain form at /login instead. Set by scripts/install-build.ts.
	legacy_login?: boolean;
};

export const BUILD_FILE = join(CLIENT_DIR, "build.json");
// webpack runtime with the chunk map; the page inlines it, there is no file for it
export const RUNTIME_FILE = join(CLIENT_DIR, "runtime.js");

export type LoadedBuild = { build: Build; runtime: string };

export function clientKnowsSwitch(build: Build | undefined, name: string): boolean {
	return !!build && (Object.hasOwn(build.featureSwitch.config, name) || Object.hasOwn(build.featureSwitch.defaultConfig, name));
}
let cached: LoadedBuild | undefined;
const namedCache = new Map<string, LoadedBuild>();

// after build.json changed under the running server (client-update.ts)
export function reloadBuild() {
	cached = undefined;
	namedCache.clear();
}

export function loadBuild(): { build: Build; runtime: string } | undefined {
	if (cached) return cached;
	if (!existsSync(BUILD_FILE) || !existsSync(RUNTIME_FILE)) return undefined;
	cached = { build: JSON.parse(readFileSync(BUILD_FILE, "utf8")), runtime: readFileSync(RUNTIME_FILE, "utf8") };
	return cached;
}

export function loadNamedBuild(name: string): LoadedBuild | undefined {
	if (!/^[A-Za-z0-9._-]{1,80}$/.test(name) || name === "." || name === "..") return undefined;
	const dir = join(CLIENT_DIR, "builds", name);
	const bf = join(dir, "build.json");
	const rf = join(dir, "runtime.js");
	if (!existsSync(bf) || !existsSync(rf)) return undefined;
	const hit = namedCache.get(name);
	if (hit) return hit;
	try {
		const build = JSON.parse(readFileSync(bf, "utf8")) as Build;
		if (!/^[0-9a-f]{7,40}$/.test(build.sha) || !build.featureSwitch || !build.meta || !Array.isArray(build.scripts) || !build.scripts.length) return undefined;
		const loaded = { build, runtime: readFileSync(rf, "utf8") };
		if (!loaded.runtime) return undefined;
		namedCache.set(name, loaded);
		return loaded;
	} catch {
		return undefined;
	}
}

export function browserBuild(viewer?: Pick<Viewer, "clientBuild">, sha?: string | null): LoadedBuild | undefined {
	const active = loadBuild();
	if (!viewer) return active;
	const approved = settings().member_client_builds;
	const chosen = viewer.clientBuild && approved.includes(viewer.clientBuild) ? loadNamedBuild(viewer.clientBuild) : undefined;
	if (!sha || sha === chosen?.build.sha || !/^[0-9a-f]{7,40}$/.test(sha)) return chosen ?? active;
	if (sha === active?.build.sha) return active;
	for (const name of approved) {
		const candidate = loadNamedBuild(name);
		if (candidate?.build.sha === sha) return candidate;
	}
	const editor = momentMakerBuild(chosen ?? active);
	return editor?.build.sha === sha ? editor : chosen ?? active;
}

// Returns the build that provides Twitter's real React `bundle.MomentMaker`:
// the active build if it already has it (e.g. 2020-2022), otherwise the archived 2022-11 build.
export function momentMakerBuild(active = loadBuild()): LoadedBuild | undefined {
	if (active?.runtime.includes('"bundle.MomentMaker"')) return active;
	const archived = loadNamedBuild("2022-11");
	return archived?.runtime.includes('"bundle.MomentMaker"') ? archived : undefined;
}
