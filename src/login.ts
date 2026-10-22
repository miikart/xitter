// The rules page, and sign-in by form post for scripts. People sign in and up
// in X's own dialog, served by onboarding.ts.

import { recordSignIn } from "./login-history";
import { login, sessionCookies } from "./auth";
import { loadLook, nightModeCookies } from "./themes/api";
import { hit, used } from "./ratelimit";
import { settings } from "./settings";

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const layout = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(settings().instance_name)}</title>
<link rel="icon" type="image/png" href="/public/favicon.png">
<style>
	.logo { width: 200px; margin: 0 0 16px; }
	body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; color: #e7e9ea; font: 15px system-ui, sans-serif; }
	form { width: min(560px, calc(100vw - 32px)); display: grid; gap: 12px; padding: 32px 0; }
	h1 { margin: 0 0 8px; font-size: 28px; }
	.alt { margin: 8px 0 0; color: #71767b; }
	.rules { margin: 0 0 4px; white-space: pre-wrap; line-height: 1.45; }
	a { color: var(--xt-accent, #1d9bf0); text-decoration: none; }
	label { color: #71767b; font-size: 13px; }
	input, textarea { padding: 12px; border: 1px solid #333639; border-radius: 4px; background: #000; color: inherit; font: inherit; }
	input:focus, textarea:focus { outline: 2px solid var(--xt-accent, #1d9bf0); border-color: transparent; }
	textarea { min-height: 120px; resize: vertical; }
	button { padding: 12px 20px; border: 0; border-radius: 999px; background: #eff3f4; color: #0f1419; font: inherit; font-weight: 700; cursor: pointer; }
	button.ghost { justify-self: start; padding: 6px 16px; background: none; border: 1px solid #536471; color: #eff3f4; }
	button:disabled { opacity: .5; cursor: default; }
	.item { border: 1px solid #2f3336; border-radius: 16px; padding: 16px; display: grid; gap: 8px; }
	.item p { margin: 0; white-space: pre-wrap; line-height: 1.45; }
	.item .meta { color: #71767b; font-size: 13px; }
	.item.strike { border-color: rgba(244,33,46,.5); }
	.item.warning { border-color: rgba(255,212,0,.4); }
	.error { color: #f4212e; margin: 0; }
	[hidden] { display: none !important; }
	.source { position: fixed; bottom: 12px; left: 0; right: 0; text-align: center; color: #71767b; font-size: 13px; }
</style>
</head>
<body>
${body}
<p class="source">${esc(settings().instance_name)} runs <a href="${esc(settings().source_url)}">open source</a> software (AGPL-3.0)</p>
</body>
</html>`;

export const html = (body: string, status = 200) =>
	new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

async function signedIn(session: { token: string; csrf: string; userId: string }): Promise<Response> {
	const headers = new Headers({ location: "/home" });
	for (const c of sessionCookies(session)) headers.append("set-cookie", c);
	for (const c of nightModeCookies(await loadLook(session.userId))) headers.append("set-cookie", c);
	return new Response(null, { status: 303, headers });
}

async function fields(req: Request): Promise<Record<string, string>> {
	const form = await req.formData().catch(() => undefined);
	const out: Record<string, string> = {};
	if (form) for (const [k, v] of form) if (typeof v === "string") out[k] = v;
	return out;
}

// For scripts and tests; people sign in through X's own dialog (onboarding.ts).
export async function handleLogin(req: Request): Promise<Response> {
	const f = await fields(req);
	const username = (f.username ?? "").replace(/^@/, "").trim();
	const password = f.password ?? "";
	const account = username.toLowerCase();
	if (username && used("password", account)) return new Response("Too many tries for this account. Wait 15 minutes.", { status: 429 });
	const session = username && password ? await login(username, password) : undefined;
	if (!session) {
		if (username) hit("password", account);
		return new Response("Wrong username or password.", { status: 401 });
	}
	await recordSignIn(req, session);
	return signedIn(session);
}

// A plain sign-in form. The 2026 client signs in inside X's own dialog, but an
// archived build (Admin > Client, "form login") sends "Log in" to
// /i/flow/login, which used to bounce back to "/" and loop. This page answers
// that route and GET /login. POST /login already existed for scripts.
export function loginPage(message = "", status = 200): Response {
	return html(
		layout(
			"Log in",
			`<form method="post" action="/login">
	<img class="logo" src="/public/logo-dark.png" alt="${esc(settings().instance_name)}">
	<h1>Log in to ${esc(settings().instance_name)}</h1>
	${message ? `<p class="error">${esc(message)}</p>` : ""}
	<label for="username">Username</label>
	<input id="username" name="username" autocomplete="username" autocapitalize="none" required autofocus>
	<label for="password">Password</label>
	<input id="password" name="password" type="password" autocomplete="current-password" required>
	<button>Log in</button>
	<p class="alt">Sign-up on this instance is invite-only; an admin makes accounts.</p>
</form>`,
		),
		status,
	);
}

// The form's POST: handleLogin's plain-text answer replaced by the page
export async function loginForm(req: Request): Promise<Response> {
	const answer = await handleLogin(req);
	if (answer.status === 303) return answer;
	if (answer.status === 429) return loginPage("Too many tries. Wait a few minutes.", 429);
	return loginPage("Wrong username or password.", 401);
}

// An archived client's "Sign up" goes to /i/flow/signup; sign-up here is invite-only
export function signupPage(): Response {
	return html(
		layout(
			"Sign up",
			`<form>
	<img class="logo" src="/public/logo-dark.png" alt="${esc(settings().instance_name)}">
	<h1>Sign-up is invite-only</h1>
	<p class="alt">Ask an admin of ${esc(settings().instance_name)} for an invite code, or have them make the account for you. If you already have one, <a href="/login">log in</a>.</p>
</form>`,
		),
	);
}

// shown while an admin has maintenance mode on: to signed-in accounts, and to
// guests, who get a way to the sign-in form so staff can still get in
export function maintenancePage(staffLink = false): Response {
	return html(
		layout(
			"Maintenance",
			`<form>
	<img class="logo" src="/public/logo-dark.png" alt="${esc(settings().instance_name)}">
	<h1>Back soon</h1>
	<p class="rules">${esc(settings().operations.message)}</p>${staffLink ? `\n\t<p class="alt"><a href="/?staff=1">Staff sign in</a></p>` : ""}
</form>`,
		),
		503,
	);
}

// X's own suspension notice: a block at the top of the timeline, under the
// header, not a dialog. The account stays signed in and can still sign out
// from the account menu. It is only inserted on the home timeline
// (/ and /home) and removed again on any other page.
export function suspendedBanner(until: Date | null, dark = true, brand = "X"): string {
	const rules = `<a href="/rules">${esc(brand)} Rules</a>`;
	const appeal = `<a href="/appeal">submit an appeal</a>`;
	const body = until
		? `After careful review, we determined your account broke the ${rules}. Your account is suspended until ${esc(until.toUTCString())}. While it’s suspended, you can’t post, Repost, or Like content. If you think we got this wrong, you can ${appeal}.`
		: `After careful review, we determined your account broke the ${rules}. Your account is permanently in read-only mode, which means you can’t post, Repost, or Like content. You won’t be able to create new accounts. If you think we got this wrong, you can ${appeal}.`;
	return `<style>
#xitter-suspended{box-sizing:border-box;padding:16px;border-bottom:1px solid rgba(127,127,127,.35);background:transparent;color:#0f1419;font-family:TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;text-align:left}
#xitter-suspended h1{margin:0 0 8px;font-size:31px;line-height:36px;font-weight:800;letter-spacing:-.02em}
#xitter-suspended p{margin:0;font-size:15px;line-height:20px;font-weight:400;color:#536471}
#xitter-suspended a{color:#1d9bf0;text-decoration:none}
#xitter-suspended a:hover{text-decoration:underline}
#xitter-suspended.xitter-suspended-dark{color:#e7e9ea}
#xitter-suspended.xitter-suspended-dark p{color:#71767b}
html[data-xitter-theme] #xitter-suspended{color:var(--xt-text)}
html[data-xitter-theme] #xitter-suspended p{color:var(--xt-secondary)}
html[data-xitter-theme] #xitter-suspended a{color:var(--xt-link)}
@media (max-width:500px){#xitter-suspended{text-align:center}#xitter-suspended h1{font-size:23px;line-height:28px}}
</style>
<div id="xitter-suspended" class="${dark ? "xitter-suspended-dark" : ""}" role="status" hidden><h1>Your account is suspended</h1><p>${body}</p></div>
<script>(function(){
var box=document.getElementById("xitter-suspended");
if(!box)return;
function tone(from){
	for(var n=from;n;n=n.parentElement){
		var m=/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?/.exec(getComputedStyle(n).backgroundColor);
		if(m&&(m[4]===undefined||+m[4]>0.5)){box.classList.toggle("xitter-suspended-dark",(+m[1]*299+ +m[2]*587+ +m[3]*114)/1000<128);return;}
	}
}
function home(){var p=location.pathname;return p==="/"||p==="/home";}
function put(){
	if(!home()){box.hidden=true;if(box.parentNode)box.parentNode.removeChild(box);return false;}
	var col=document.querySelector('[data-testid="primaryColumn"]');
	if(!col)return false;
	var tl=col.querySelector('[aria-label^="Timeline:"]');
	if(!tl||!tl.parentNode)return false;
	tone(col);
	var parent=tl.parentNode;
	if(box.parentNode===parent&&box.nextSibling===tl){box.hidden=false;return true;}
	parent.insertBefore(box,tl);
	box.hidden=false;
	return true;
}
function schedule(){if(!schedule.pending){schedule.pending=true;requestAnimationFrame(function(){schedule.pending=false;put();});}}
var root=document.getElementById("react-root")||document.body;
new MutationObserver(schedule).observe(root,{childList:true,subtree:true});
put();
})();</script>`;
}

// the instance's rules, as written in the admin panel: blank lines split paragraphs
export function rulesPage(): Response {
	const rules = settings().rules.trim();
	const body = rules ? rules.split(/\n\s*\n/).map((p) => `<p class="rules">${esc(p)}</p>`).join("") : `<p class="alt">This instance hasn't written any rules yet.</p>`;
	return html(
		layout(
			"Rules",
			`<form>
	<img class="logo" src="/public/logo-dark.png" alt="${esc(settings().instance_name)}">
	<h1>Rules</h1>
	${body}
	<p class="alt"><a href="/">Sign in or create an account</a></p>
</form>`,
		),
	);
}
