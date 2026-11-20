import { expect, test } from "bun:test";
import { clientPathAllowed } from "../src/client-cache";
import { snapshotPage } from "../src/client-snapshot";
import { switchReport } from "../src/shell";
import { runInNewContext } from "node:vm";
import { BROWSER_BUILD_SCRIPT } from "../src/client-preference";

const entry = "/twitter-assets/responsive-web/web/ltr/main.aabbccdd.js";
const runtime = "/twitter-assets/responsive-web/web/ltr/runtime.11223344.js";
const entryScript = `<script src="https://ma-0.twimg.com${entry}"></script>`;

test("rejects classic desktop init.js pages", () => {
	const html = '<script src="https://abs.twimg.com/c/swift/en/init.0123456789abcdef.js"></script>';
	expect(() => snapshotPage(html)).toThrow("recognizable web app");
});

test("reports when Wayback saved the server-rendered mobile site", () => {
	const html = '<script src="https://ma.twimg.com/twitter-mobile/aabbccdd/assets/base.js"></script>';
	expect(() => snapshotPage(html)).toThrow("older server-rendered mobile site");
});

test("reports missing startup data for a capture with Twitter Lite scripts", () => {
	expect(() => snapshotPage(entryScript)).toThrow("missing the startup data");
});

test("recognizes Twitter Lite asset paths in a supported startup page", () => {
	const html = `<script>window.__INITIAL_STATE__={"featureSwitch":{"config":{}}};window.__META_DATA__={"sha":"11223344"};</script>
<script>window.webpackChunkManifest={};</script>
<script src='//ma-0.twimg.com${runtime}'></script>${entryScript}`;
	const snapshot = snapshotPage(html);
	expect(snapshot.build.scripts).toEqual([entry]);
	expect(snapshot.runtimeScript).toBe(runtime);
	expect(clientPathAllowed(entry)).toBe(true);
	expect(clientPathAllowed("/twitter-assets/twitter-mobile/aabbccdd/assets/base.js")).toBe(false);
});

test("lists switches from the selected build with Xitter's defaults", () => {
	const html = `<script>window.__INITIAL_STATE__={"featureSwitch":{"defaultConfig":{"responsive_web_side_nav_enabled":{"value":false}},"config":{"responsive_web_unified_cards_moment_enabled":{"value":true}}}};window.__META_DATA__={"sha":"11223344"};</script>
<script>window.webpackChunkManifest={};</script><script src="${runtime}"></script>${entryScript}`;
	const { build } = snapshotPage(html);
	expect(switchReport(build)).toEqual([
		{ name: "responsive_web_side_nav_enabled", build: false },
		{ name: "responsive_web_unified_cards_moment_enabled", build: true, xitter: false },
	]);
});

test("only same-origin client API requests carry the tab's build", () => {
	const sha = "11223344";
	const origin = "https://example.test";
	const calls: Headers[] = [];
	const window = {
		__XITTER__: { buildSha: sha },
		fetch: (_input: string | Request, init?: RequestInit) => calls.push(new Headers(init?.headers)),
	};
	class Xhr {
		headers = new Headers();
		open(_method: string, _url: string) {}
		setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
	}
	runInNewContext(BROWSER_BUILD_SCRIPT, { window, URL, Headers, location: { origin, href: origin + "/home" }, XMLHttpRequest: Xhr });
	window.fetch(new Request(origin + "/2/timeline/home.json", { headers: { "x-csrf-token": "example" } }));
	window.fetch("/abs/vendor.js");
	window.fetch("https://other.test/2/timeline/home.json");
	expect(calls.map((call) => call.get("x-xitter-build"))).toEqual([sha, null, null]);
	expect(calls[0].get("x-csrf-token")).toBe("example");
	const xhr = new Xhr();
	xhr.open("GET", "/1.1/users/show.json");
	expect(xhr.headers.get("x-xitter-build")).toBe(sha);
});
