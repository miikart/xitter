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

// after build.json changed under the running server (client-update.ts)
export function reloadBuild() {
	cached = undefined;
}

export function loadBuild(): { build: Build; runtime: string } | undefined {
	if (cached) return cached;
	if (!existsSync(BUILD_FILE) || !existsSync(RUNTIME_FILE)) return undefined;
	cached = { build: JSON.parse(readFileSync(BUILD_FILE, "utf8")), runtime: readFileSync(RUNTIME_FILE, "utf8") };
	return cached;
}
