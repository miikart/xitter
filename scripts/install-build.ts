// Adds a pinned client build to client/builds/ so Admin > Client can switch to
// it. Sources: a directory with build.json + runtime.js, or a saved copy of a
// client page (the same snapshot scripts/fetch-client.ts takes).
//
//   bun scripts/install-build.ts <dir> [name] [--legacy-login] [--date=YYYY-MM-DD]
//   bun scripts/install-build.ts --page <page.html> [name] [--legacy-login] [--date=...]
//
// --legacy-login marks a build whose own sign-in dialog can't complete here
// (the 2022 client sends people to /i/flow/login): guests get the plain form
// at /login. --date sets the "pinned" date shown in the panel.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_DIR } from "../src/client-cache";
import { snapshotPage } from "../src/client-snapshot";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const legacy = flags.has("--legacy-login");
const dateArg = args.find((a) => a.startsWith("--date="));
const pinnedAt = dateArg ? new Date(dateArg.slice("--date=".length)) : undefined;
if (dateArg && Number.isNaN(pinnedAt!.getTime())) throw new Error("--date wants a date, e.g. --date=2022-11-24");

let build: { sha?: string; scripts?: string[]; fetchedAt?: string; legacy_login?: boolean };
let runtime: string;

if (flags.has("--page")) {
	const page = positional[0];
	if (!page) throw new Error("usage: bun scripts/install-build.ts --page <page.html> [name] [--legacy-login]");
	if (!existsSync(page)) throw new Error(`${page} doesn't exist`);
	({ build, runtime } = snapshotPage(readFileSync(page, "utf8"), pinnedAt));
} else {
	const dir = positional[0];
	if (!dir) throw new Error("usage: bun scripts/install-build.ts <dir> [name] [--legacy-login]");
	const buildFile = join(dir, "build.json");
	const runtimeFile = join(dir, "runtime.js");
	if (!existsSync(buildFile) || !existsSync(runtimeFile)) throw new Error(`${dir} needs build.json and runtime.js`);
	build = JSON.parse(readFileSync(buildFile, "utf8"));
	runtime = readFileSync(runtimeFile, "utf8");
}

if (!/^[0-9a-f]{7,40}$/.test(String(build.sha ?? ""))) throw new Error("build.json has no sha");
if (!Array.isArray(build.scripts) || !build.scripts.length) throw new Error("build.json has no entry scripts");
// --date wins for a directory source too, whose build.json may say "now"
if (pinnedAt) build.fetchedAt = pinnedAt.toISOString();

const name = positional[1] || build.sha!.slice(0, 12);
if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error("name: letters, numbers, dots, dashes, underscores");

if (legacy) build.legacy_login = true;

const out = join(CLIENT_DIR, "builds", name);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "build.json"), JSON.stringify(build, null, "\t"));
writeFileSync(join(out, "runtime.js"), runtime);
console.log(`installed ${name}: ${build.sha.slice(0, 12)}, ${build.scripts.length} entry scripts${legacy ? ", form login" : ""}`);

// the first build installed on a fresh instance is also the serving one
const active = join(CLIENT_DIR, "build.json");
if (!existsSync(active)) {
	copyFileSync(join(out, "build.json"), active);
	copyFileSync(join(out, "runtime.js"), join(CLIENT_DIR, "runtime.js"));
	console.log("no pin was serving: this one is now");
} else {
	console.log("switch to it in Admin > Client");
}
