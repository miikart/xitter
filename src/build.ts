// The pinned client build: what scripts/fetch-client.ts took from a signed-in
// page. Kept next to the archived bundle, outside the repository.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_DIR } from "./client-cache";

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

let cached: { build: Build; runtime: string } | undefined;
const namedCache = new Map<string, { build: Build; runtime: string }>();

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

export function loadNamedBuild(name: string): { build: Build; runtime: string } | undefined {
	const hit = namedCache.get(name);
	if (hit) return hit;
	const dir = join(CLIENT_DIR, "builds", name);
	const bf = join(dir, "build.json");
	const rf = join(dir, "runtime.js");
	if (!existsSync(bf) || !existsSync(rf)) return undefined;
	const loaded = { build: JSON.parse(readFileSync(bf, "utf8")), runtime: readFileSync(rf, "utf8") };
	namedCache.set(name, loaded);
	return loaded;
}

// Returns the build that provides Twitter's real React `bundle.MomentMaker`:
// the active build if it already has it (e.g. 2020-2022), otherwise the archived 2022-11 build.
export function momentMakerBuild(): { build: Build; runtime: string } | undefined {
	const active = loadBuild();
	if (active?.runtime.includes('"bundle.MomentMaker"')) return active;
	const archived = loadNamedBuild("2022-11");
	return archived?.runtime.includes('"bundle.MomentMaker"') ? archived : undefined;
}
