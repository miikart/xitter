// A pinned build out of a saved client page: what scripts/install-build.ts and
// Admin > Client's archive import both take. Only build data is kept; the
// page's account details are thrown away.

import type { Build } from "./build";

// 2020-era pages spaced the assignments and put the metadata first
const STATE = /window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*;\s*(?:window\.|<\/script>)/s;
const META = /window\.__META_DATA__\s*=\s*(\{.*?\})\s*;\s*(?:window\.|<\/script>)/s;
const META_KEYS = ["env", "isCanary", "isTwoffice", "hasMultiAccountCookie", "uaParserTags", "userAgentTags", "cookies", "xchatEmbedBuild"];

// `runtimeScript` is set for the 2018-2019 pages, whose module loader is a file
// of its own: `runtime` is then only the chunk map the page inlines, and the
// loader file (kept out of `build.scripts`) goes after it.
export function snapshotPage(html: string, fetchedAt: Date = new Date()): { build: Build; runtime: string; runtimeScript?: string } {
	const all = [...html.matchAll(/<script\b[^>]*\ssrc\s*=\s*(["'])(?:(?:https?:)?\/\/(?:abs|ma)(?:-\d+)?\.twimg\.com)?((?:\/twitter-assets)?\/responsive-web\/[A-Za-z0-9-]+\/[^"'<>]+\.js)\1/g)].map((x) => x[2]);
	const st = STATE.exec(html);
	const mt = META.exec(html);
	if (!st || !mt) {
		if (all.length) throw new Error("Wayback saved web app script references, but the page is missing the startup data this importer needs");
		if (/\/twitter-mobile\/[0-9a-f]+\/(?:assets|javascripts)\//i.test(html))
			throw new Error("Wayback saved the older server-rendered mobile site for this capture. There is no Twitter Lite build to import");
		throw new Error("Wayback did not save a recognizable web app on this page");
	}
	const state = JSON.parse(st[1]);
	const meta = JSON.parse(mt[1]);
	const runtimeScript = all.find((p) => /\/runtime\.[0-9a-f]+\.js$/.test(p));
	const scripts = all.filter((p) => p !== runtimeScript);
	const inline = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
	const runtime = runtimeScript
		? inline.find((b) => b.includes("window.webpackChunkManifest"))
		: (inline.find((b) => b.includes("__SCRIPTS_LOADED__.runtime=!0")) ?? inline.find((b) => /__SCRIPTS_LOADED__\s*=\s*\{\}/.test(b) && b.length > 1000));
	if (!scripts.length) throw new Error("that page has no client entry scripts");
	if (!runtime) throw new Error("that page has no module loader");
	// older builds kept one config, with no separate guest defaults
	const fs = state.featureSwitch;
	if (!fs?.config && !fs?.user?.config) throw new Error("that page has no feature switches");
	const config = fs.user?.config ?? fs.config;
	// before 2020 the page doesn't name its build: the entry files' content hashes do
	const sha = /^[0-9a-f]{7,40}$/.test(String(meta.sha ?? "")) ? meta.sha : new Bun.CryptoHasher("sha1").update(scripts.join("\n")).digest("hex");
	return {
		build: {
			sha,
			scripts,
			featureSwitch: {
				defaultConfig: fs.defaultConfig ?? fs.config ?? config,
				config,
				featureSetToken: fs.featureSetToken,
				settingsVersion: fs.user?.settingsVersion ?? fs.settingsVersion,
				// the state keeps the switches in featureSwitch.config itself (shell.ts initialState)
				...(fs.user ? {} : { flat: true }),
			},
			meta: Object.fromEntries(META_KEYS.filter((k) => k in meta).map((k) => [k, meta[k]])),
			fetchedAt: fetchedAt.toISOString(),
		},
		runtime,
		...(runtimeScript ? { runtimeScript } : {}),
	};
}
