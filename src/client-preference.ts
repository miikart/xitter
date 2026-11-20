import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { loadNamedBuild } from "./build";
import { sql } from "./db";
import { settings } from "./settings";

const LABELS: Record<string, string> = {
	"2018-06-twitter-lite": "June 2018 · Twitter Lite",
	"2019-07-15-new-twitter": "July 15, 2019 · New Twitter",
	"2019-07-new-twitter": "July 20, 2019 · New Twitter",
};

export async function frontendRoute(req: Request, viewer: Viewer): Promise<Response> {
	const options = settings().member_client_builds.flatMap((id) => {
		const loaded = loadNamedBuild(id);
		return loaded ? [{ id, label: Object.hasOwn(LABELS, id) ? LABELS[id] : id }] : [];
	});
	const current = options.some(({ id }) => id === viewer.clientBuild) ? viewer.clientBuild : "";
	let error = "";
	if (req.method === "POST") {
		const form = await req.formData().catch(() => null);
		const pick = form?.get("build");
		if (form?.get("csrf") !== viewer.csrf) error = "That form is out of date. Try again.";
		else if (pick !== "" && (typeof pick !== "string" || !options.some(({ id }) => id === pick))) error = "That frontend is unavailable.";
		else {
			if (pick === "") await sql`update users set preferences = coalesce(preferences, '{}') - 'client_build' where id = ${viewer.id}::bigint`;
			else await sql`update users set preferences = jsonb_set(coalesce(preferences, '{}'), '{client_build}', to_jsonb(${pick}::text)) where id = ${viewer.id}::bigint`;
			return new Response(null, { status: 303, headers: { location: "/home", "cache-control": "no-store" } });
		}
	} else if (req.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
	return accountPage({
		req,
		viewer,
		title: "Frontend",
		back: { href: "/home", label: "Back to Home" },
		status: error ? 400 : 200,
		body: '<h1>Frontend</h1><p class="dim">Choose the web client for this account.</p>' +
			(error ? '<p class="error" role="alert">' + esc(error) + '</p>' : "") +
			'<form method="post" action="/account/frontend" target="_top"><input type="hidden" name="csrf" value="' + esc(viewer.csrf) +
			'"><label for="build">Web client</label><select id="build" name="build"><option value="">Instance default</option>' +
			options.map(({ id, label }) => '<option value="' + esc(id) + '"' + (id === current ? " selected" : "") + '>' + esc(label) + '</option>').join("") +
			'</select><p><button type="submit">Save and reload</button></p></form>',
	});
}

export const BROWSER_BUILD_SCRIPT = String.raw`(function(){
	var sha=(window.__XITTER__||{}).buildSha;
	if(!sha)return;
	function localApi(input){
		try{
			var u=new URL(typeof input==="object"&&input.url||input,location.href);
			return u.origin===location.origin&&/^\/(?:i\/(?:api|jfapi|media)\/|(?:1\.1|1|2|v2|graphql|fleets)\/|xchat\/embed-v1\.json$)/.test(u.pathname);
		}catch(e){return false}
	}
	var fetch0=window.fetch;
	if(fetch0)window.fetch=function(input,init){
		if(!localApi(input))return fetch0.apply(this,arguments);
		var headers=new Headers(init&&init.headers!==undefined?init.headers:input.headers);
		headers.set("x-xitter-build",sha);
		return fetch0.call(this,input,Object.assign({},init,{headers:headers}));
	};
	var open0=XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open=function(method,url){
		var result=open0.apply(this,arguments);
		if(localApi(url))this.setRequestHeader("x-xitter-build",sha);
		return result;
	};
})();`;
