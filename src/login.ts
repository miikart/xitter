// The rules page, and sign-in by form post for scripts. People sign in and up
// in X's own dialog, served by onboarding.ts.

import { recordSignIn, requestCountry, requestIp } from "./login-history";
import { signInCookies } from "./accounts";
import { login, parseCookies, SECURE, sessionCookies, startSession } from "./auth";
import { sql } from "./db";
import { checkSignupCode, sendSignupCode } from "./email-address";
import { checkSignup, normalizeCode, signUp, SignupError, validInviteCode } from "./invites";
import { mailEnabled } from "./mail";
import { webSource } from "./platforms";
import { loadLook, nightModeCookies } from "./themes/api";
import { hit, passwordTry } from "./ratelimit";
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
	body { margin: 0; min-height: 100vh; display: grid; grid-template-rows: 1fr auto; background: #000; color: #e7e9ea; font: 15px system-ui, sans-serif; }
	main { display: grid; place-items: center; }
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
	.source { padding: 12px 16px; text-align: center; color: #71767b; font-size: 13px; }
</style>
</head>
<body>
<main>
${body}
</main>
<footer class="source">${esc(settings().instance_name)} runs <a href="${esc(settings().source_url)}">open source</a> software (AGPL-3.0)</footer>
</body>
</html>`;

export const html = (body: string, status = 200) =>
	new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

async function signedIn(session: { token: string; csrf: string; userId: string }, cookies = sessionCookies(session)): Promise<Response> {
	const headers = new Headers({ location: "/home" });
	for (const c of cookies) headers.append("set-cookie", c);
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
	const refund = username ? passwordTry(account) : () => {};
	if (!refund) return new Response("Too many tries for this account. Wait 15 minutes.", { status: 429 });
	const session = username && password ? await login(username, password) : undefined;
	if (!session) return new Response("Wrong username or password.", { status: 401 });
	refund();
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
	${settings().signup_mode === "closed" ? "" : '<p class="alt"><a href="/signup">Create an account</a></p>'}
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

function signupPage(values: Record<string, string> = {}, message = "", status = 200, verification?: { token: string; email: string }): Response {
	const mode = settings().signup_mode;
	const body = mode === "closed"
		? "<p>Sign-up is closed on this instance.</p>"
		: verification
			? `<p>Enter the code sent to ${esc(verification.email)}.</p>
	<input name="token" type="hidden" value="${esc(verification.token)}">
	<label for="email-code">Email verification code</label>
	<input id="email-code" name="email_code" inputmode="numeric" autocomplete="one-time-code" required autofocus>
	<button>Verify email</button>`
			: `<label for="username">Username</label>
	<input id="username" name="username" value="${esc(values.username ?? "")}" minlength="3" maxlength="15" pattern="[A-Za-z0-9_]+" autocomplete="username" autocapitalize="none" required autofocus>
	<label for="name">Display name (optional)</label>
	<input id="name" name="name" value="${esc(values.name ?? "")}" maxlength="50" autocomplete="nickname">
	<label for="email">Email</label>
	<input id="email" name="email" type="email" value="${esc(values.email ?? "")}" maxlength="254" autocomplete="email" required>
	<label for="password">Password</label>
	<input id="password" name="password" type="password" minlength="8" maxlength="256" autocomplete="new-password" required>
	<label for="invite">Invite code${mode === "open" ? " (optional)" : ""}</label>
	<input id="invite" name="invite" value="${esc(values.invite ?? "")}" ${mode === "invite" ? "required" : ""}>
	<p class="alt">Read the <a href="/rules">instance rules</a> before signing up.</p>
	<button>Create account</button>`;
	return html(layout("Create an account", `<form method="post" action="/signup">
	<img class="logo" src="/public/logo-dark.png" alt="${esc(settings().instance_name)}">
	<h1>Create an account</h1>
	${message ? `<p class="error" role="alert">${esc(message)}</p>` : ""}
	${body}
	<p class="alt">Already have an account? <a href="/login">Log in</a>.</p>
</form>`), mode === "closed" ? 403 : status);
}

export async function signupRoute(req: Request, url: URL): Promise<Response> {
	const mode = settings().signup_mode;
	if (mode === "closed") return signupPage();
	if (req.method === "GET") {
		const linked = url.searchParams.get("code");
		if (linked) {
			const code = normalizeCode(linked);
			return new Response(null, { status: 302, headers: {
				location: "/signup",
				"cache-control": "no-store",
				"set-cookie": `xitter_invite=${code}; Path=/; Max-Age=1800; SameSite=Lax; HttpOnly${SECURE}`,
			} });
		}
		return signupPage({ invite: parseCookies(req).xitter_invite ?? "" });
	}
	const ip = requestIp(req);
	if (!hit("auth", ip ?? "unknown").ok) return signupPage({}, "Too many attempts. Try again later.", 429);
	const { password = "", token, email_code, ...values } = await fields(req);
	const country = requestCountry(req) ?? null;
	const source = webSource();
	let userId: string;
	let verification: { token: string; email: string } | undefined;
	try {
		if (token) {
			if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(token)) throw new SignupError("Start sign-up again to get a new code.");
			const [row] = await sql`select code, pending from signup_sessions
				where token = ${token}::uuid and pending is not null and created_at > now() - interval '30 minutes'`;
			if (!row) throw new SignupError("Start sign-up again to get a new code.");
			verification = { token, email: row.pending.email };
			const result = await checkSignupCode(token, email_code ?? "");
			if (result === "wrong") throw new SignupError("That email code is incorrect.");
			if (result === "expired") {
				verification = undefined;
				throw new SignupError("That email code has expired. Start sign-up again.");
			}
			userId = await signUp({ ...row.pending, code: row.code, emailVerified: true, ip: ip ?? row.pending.ip });
			await sql`delete from signup_sessions where token = ${token}::uuid`;
		} else {
			const invite = values.invite?.trim();
			const code = invite ? await validInviteCode(invite) : "";
			if (code === undefined || (mode === "invite" && !code)) throw new SignupError("That invite code is not valid or has been used up.");
			const form = { code, screenName: values.username ?? "", name: values.name ?? "", email: values.email ?? "", password, ip };
			if (mailEnabled()) {
				const checked = await checkSignup(form);
				if (!hit("mail", ip ?? "unknown").ok) return signupPage(values, "Too many codes sent from here. Wait an hour.", 429);
				const pending = { ...checked, ip, country, source, passwordHash: await Bun.password.hash(password) };
				const token = crypto.randomUUID();
				await sql`delete from signup_sessions where created_at < now() - interval '30 minutes'`;
				await sql`insert into signup_sessions (token, username, code, pending)
					values (${token}::uuid, ${pending.screenName}, ${code}, ${JSON.stringify(pending)}::text::jsonb)`;
				try {
					await sendSignupCode(token, pending.email);
				} catch {
					await sql`delete from signup_sessions where token = ${token}::uuid`;
					return signupPage(values, "The email code could not be sent. Try again later.", 503);
				}
				return signupPage({}, "", 200, { token, email: pending.email });
			}
			userId = await signUp({ ...form, country, source });
		}
	} catch (e) {
		if (!(e instanceof SignupError)) throw e;
		return signupPage(values, e.message, 400, verification);
	}
	const session = await startSession(userId);
	const response = await signedIn(session, await signInCookies(req, session));
	response.headers.append("set-cookie", `xitter_invite=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${SECURE}`);
	return response;
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
