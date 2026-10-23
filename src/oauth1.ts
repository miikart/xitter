// OAuth 1.0a for the old mobile clients (2011-2016 Twitter apps and the third-party
// clients of that time): the three-legged flow (request_token, authenticate,
// access_token) and xAuth, where the app's own sign-in form sends the username and
// password straight to access_token (or auth/1/xauth_password.json).
//
// The access token is an ordinary session: oauth_token is the session token and
// oauth_token_secret its csrf value, so signing out anywhere ends it. A request
// signed with that token is authenticated by oauth_token alone (auth.ts); the
// signature itself is not checked, since the consumer secret of an archived app is
// not something this instance has. The token is as unguessable as the cookie it
// stands in for.

import { login, type Session } from "./auth";
import { esc, html, layout } from "./login";
import { recordSignIn, requestIp } from "./login-history";
import { headerParams } from "./oauth1-header";
import { hit, used } from "./ratelimit";
import { sql } from "./db";
import { settings } from "./settings";

type Params = Record<string, string>;
type Pending = { secret: string; callback: string; verifier: string; session?: Session; expires: number };

const TTL_MS = 15 * 60_000;
const MAX_PENDING = 5000;
const pending = new Map<string, Pending>();

const randomHex = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
const form = (o: Params) => new URLSearchParams(o).toString();
// text/html is what Twitter sent for these, and the 2013 Android app refuses a form-urlencoded content type
const formResponse = (o: Params) => new Response(form(o), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const failure = (status: number, code: number, message: string) => Response.json({ errors: [{ code, message }] }, { status, headers: { "cache-control": "no-store" } });

// header, then query string, then a form body: where a client may put any field
async function params(req: Request, url: URL): Promise<Params> {
	const out: Params = { ...headerParams(req) };
	for (const [k, v] of url.searchParams) out[k] ??= v;
	if (req.method === "POST" && /x-www-form-urlencoded/i.test(req.headers.get("content-type") ?? "")) {
		for (const [k, v] of new URLSearchParams(await req.text().catch(() => ""))) out[k] ??= v;
	}
	return out;
}

function prune() {
	const now = Date.now();
	for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
	// a flood of request_tokens drops the oldest rather than growing without end
	while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
}

// A callback the browser is sent to afterwards: any scheme but the ones that run code
const safeCallback = (cb: string) => cb === "oob" || (/^[a-z][a-z0-9+.-]*:/i.test(cb) && !/^(javascript|data|vbscript|file):/i.test(cb));

// a password check with the same limits as the sign-in form's
async function signIn(req: Request, username: string, password: string): Promise<Session | undefined> {
	const name = username.replace(/^@/, "").trim();
	const account = name.toLowerCase();
	if (!name || !password) return undefined;
	if (!hit("auth", requestIp(req) ?? "unknown").ok || used("password", account)) return undefined;
	const session = await login(name, password);
	if (!session) {
		hit("password", account);
		return undefined;
	}
	await recordSignIn(req, session);
	return session;
}

async function grant(session: Session): Promise<Params> {
	const [u] = await sql`select screen_name from users where id = ${session.userId}::bigint`;
	return { oauth_token: session.token, oauth_token_secret: session.csrf, user_id: session.userId, screen_name: u?.screen_name ?? "", x_auth_expires: "0" };
}

// xAuth: the app sends the account's username and password itself
async function xauth(req: Request, p: Params, json: boolean): Promise<Response> {
	const session = await signIn(req, p.x_auth_username ?? p.x_auth_identifier ?? "", p.x_auth_password ?? "");
	if (!session) return failure(401, 32, "Could not authenticate you.");
	const g = await grant(session);
	return json || p.x_auth_json_response === "true" ? Response.json(g, { headers: { "cache-control": "no-store" } }) : formResponse(g);
}

async function requestToken(req: Request, url: URL): Promise<Response> {
	const p = await params(req, url);
	const callback = p.oauth_callback ?? "oob";
	if (!safeCallback(callback)) return failure(400, 415, "Callback URL not approved for this client application.");
	prune();
	const token = randomHex(16);
	pending.set(token, { secret: randomHex(16), callback, verifier: randomHex(8), expires: Date.now() + TTL_MS });
	return formResponse({ oauth_token: token, oauth_token_secret: pending.get(token)!.secret, oauth_callback_confirmed: "true" });
}

const signInPage = (token: string, error = "") =>
	html(
		layout(
			"Authorize",
			`<form method="post" action="/oauth/authenticate">
	<img class="logo" src="/public/logo-dark.png" alt="${esc(settings().instance_name)}">
	<h1>Sign in to continue</h1>${error ? `\n\t<p class="error">${esc(error)}</p>` : ""}
	<input type="hidden" name="oauth_token" value="${esc(token)}">
	<label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="off" required>
	<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
	<button type="submit">Authorize app</button>
</form>`,
		),
	);

async function authenticate(req: Request, url: URL): Promise<Response> {
	const p = await params(req, url);
	const token = p.oauth_token ?? "";
	const entry = pending.get(token);
	if (!entry || entry.expires < Date.now()) return html(layout("Authorize", `<form><h1>That sign-in has expired</h1><p class="alt">Go back to the app and try again.</p></form>`), 400);
	if (req.method !== "POST") return signInPage(token);
	const session = await signIn(req, p.username ?? "", p.password ?? "");
	if (!session) return signInPage(token, "Wrong username or password.");
	entry.session = session;
	if (entry.callback === "oob") {
		return html(layout("Authorized", `<form><h1>You're signed in</h1><p class="alt">Enter this PIN in the app:</p><h1>${esc(entry.verifier)}</h1></form>`));
	}
	const to = new URL(entry.callback);
	to.searchParams.set("oauth_token", token);
	to.searchParams.set("oauth_verifier", entry.verifier);
	return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
}

async function accessToken(req: Request, url: URL): Promise<Response> {
	const p = await params(req, url);
	if (p.x_auth_mode === "client_auth") return xauth(req, p, false);
	const token = p.oauth_token ?? "";
	const entry = pending.get(token);
	if (!entry || entry.expires < Date.now() || !entry.session || (p.oauth_verifier ?? "") !== entry.verifier) return failure(401, 32, "Could not authenticate you.");
	pending.delete(token);
	return formResponse(await grant(entry.session));
}

// OAuth 2 application-only: the bearer token the old Twitter apps fetch with their
// consumer key and secret before anything else. Nothing is readable with it, so it
// is not remembered or checked; it only has to be shaped like the real one.
async function appOnlyToken(req: Request, url: URL): Promise<Response> {
	const p = await params(req, url);
	if (p.grant_type !== "client_credentials") return failure(403, 99, "Unable to verify your credentials");
	return Response.json({ token_type: "bearer", access_token: `AAAAAAAAAAAAAAAAAAAAA%2F${randomHex(20)}` }, { headers: { "cache-control": "no-store" } });
}

// The config lookups the old apps make right after signing in. Some go out without the
// token, and a 401 or a redirect there makes the app discard the session it just got,
// so they answer the same to everyone. Nothing here is per account.
function publicConfig(req: Request, p: string): Response | undefined {
	if (req.method !== "GET") return undefined;
	if (p === "/i/config" || p === "/1.1/help/settings.json" || p === "/1.1/help/configuration.json") return Response.json({}, { headers: { "cache-control": "no-store" } });
	return undefined;
}

export async function oauth1Route(req: Request, url: URL): Promise<Response | undefined> {
	const p = url.pathname;
	const config = publicConfig(req, p);
	if (config) return config;
	if (p === "/oauth/request_token" && req.method === "POST") return requestToken(req, url);
	// /oauth/authorize is also OAuth 2's (oauth.ts); a 1.0a client names an oauth_token
	const classic = p === "/oauth/authenticate" || (p === "/oauth/authorize" && !url.searchParams.has("response_type") && (url.searchParams.has("oauth_token") || req.method === "POST"));
	if (classic && (req.method === "GET" || req.method === "POST")) return authenticate(req, url);
	if (p === "/oauth/access_token" && req.method === "POST") return accessToken(req, url);
	if (p === "/oauth2/token" && req.method === "POST") return appOnlyToken(req, url);
	if (p === "/auth/1/xauth_password.json" && req.method === "POST") return xauth(req, await params(req, url), true);
	return undefined;
}
