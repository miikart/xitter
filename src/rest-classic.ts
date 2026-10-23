// The v1.1 endpoints the 2013 mobile apps use beyond the home timeline: the profile,
// mentions and favorites timelines, photo tweets, direct messages in the original
// format, the friendship lookups and the tabs that have nothing behind them here.
// Timelines are paged the old way: max_id and since_id trim what the GraphQL handler
// returns, and more pages are fetched until count statuses remain.

import type { Viewer } from "./auth";
import { sql } from "./db";
import { callOperation } from "./graphql";
import { mediaUpload } from "./media";
import { apiDate, legacyUser } from "./model";
import { PUBLIC_ORIGIN } from "./config";
import { PostError } from "./posts";
import { userById, userByName } from "./users";
import { failure, gone, pageOf, restStatus, restUser, status, statusPages, withText } from "./rest-timeline";
import { trendScope } from "./explore-settings";
import { cachedTrends } from "./search";

type Obj = Record<string, any>;

const isId = (v: unknown): v is string => typeof v === "string" && /^\d{1,19}$/.test(v);

async function target(viewer: Viewer, q: URLSearchParams) {
	const id = q.get("user_id") ?? q.get("id");
	const name = q.get("screen_name");
	const user = isId(id) ? await userById(viewer.id, id) : name ? await userByName(viewer.id, name.replace(/^@/, "")) : await userById(viewer.id, viewer.id);
	if (!user) throw new PostError("User not found.", 50);
	return user;
}

const json = (v: unknown) => Response.json(v, { headers: { "content-type": "application/json;charset=utf-8" } });

// --- direct messages -------------------------------------------------------------
// The chat of this server is end-to-end encrypted; the 2013 apps' messages are plain
// text, so they live in their own table and are only seen by the apps that send them.

const dmRow = async (viewerId: string, r: Obj) => {
	const [sender, recipient] = await Promise.all([userById(viewerId, String(r.sender_id)), userById(viewerId, String(r.recipient_id))]);
	const u = (x: typeof sender) => (x ? { ...legacyUser(x), id_str: x.id, created_at: apiDate(x.created_at) } : undefined);
	return {
		id_str: String(r.id),
		created_at: apiDate(new Date(r.created_at)),
		text: r.text,
		sender_id_str: String(r.sender_id),
		sender_screen_name: sender?.screen_name,
		sender: u(sender),
		recipient_id_str: String(r.recipient_id),
		recipient_screen_name: recipient?.screen_name,
		recipient: u(recipient),
		entities: { hashtags: [], urls: [], user_mentions: [], symbols: [] },
	};
};

async function dmList(viewer: Viewer, q: URLSearchParams, sent: boolean) {
	const count = Math.min(Math.max(Number(q.get("count")) || 20, 1), 200);
	const since = isId(q.get("since_id")) ? q.get("since_id")! : "0";
	const max = isId(q.get("max_id")) ? q.get("max_id")! : "9223372036854775807";
	const rows = await sql`select id::text, sender_id::text, recipient_id::text, text, created_at from classic_dms
		where ${sent ? sql`sender_id` : sql`recipient_id`} = ${viewer.id}::bigint and id > ${since}::bigint and id <= ${max}::bigint
		and not ${sent ? sql`sender_deleted` : sql`recipient_deleted`} order by id desc limit ${count}`;
	return json(await Promise.all(rows.map((r: Obj) => dmRow(viewer.id, r))));
}

async function dmNew(viewer: Viewer, q: URLSearchParams) {
	const text = (q.get("text") ?? "").trim();
	if (!text) return gone("Text is required.", 38, 403);
	if (text.length > 10000) return gone("That message is too long.", 354, 403);
	const to = await target(viewer, q);
	if (to.id === viewer.id) return gone("You cannot send messages to yourself.", 150, 403);
	const [row] = await sql`insert into classic_dms (sender_id, recipient_id, text) values (${viewer.id}::bigint, ${to.id}::bigint, ${text}) returning id::text, sender_id::text, recipient_id::text, text, created_at`;
	return json(await dmRow(viewer.id, row));
}

async function dmShowOrDestroy(viewer: Viewer, q: URLSearchParams, destroy: boolean) {
	const id = q.get("id");
	if (!isId(id)) return gone("No direct message with that ID found.", 34, 404);
	const [row] = await sql`select id::text, sender_id::text, recipient_id::text, text, created_at from classic_dms where id = ${id}::bigint and (sender_id = ${viewer.id}::bigint or recipient_id = ${viewer.id}::bigint)`;
	if (!row) return gone("No direct message with that ID found.", 34, 404);
	if (destroy) {
		if (row.sender_id === viewer.id) await sql`update classic_dms set sender_deleted = true where id = ${id}::bigint`;
		if (row.recipient_id === viewer.id) await sql`update classic_dms set recipient_deleted = true where id = ${id}::bigint`;
	}
	return json(await dmRow(viewer.id, row));
}

// --- photo tweets ----------------------------------------------------------------

export async function uploadPhoto(viewer: Viewer, file: File): Promise<string> {
	const call = async (query: Record<string, string>, form?: FormData) => {
		const url = new URL(`${PUBLIC_ORIGIN}/i/media/upload.json?${new URLSearchParams(query)}`);
		const res = await mediaUpload(new Request(url, { method: "POST", body: form }), url, viewer);
		const out = res.status === 204 ? {} : await res.json().catch(() => ({}));
		if (res.status >= 400) throw new PostError((out as Obj)?.errors?.[0]?.message ?? "That photo could not be uploaded.", 324);
		return out as Obj;
	};
	const init = await call({ command: "INIT", total_bytes: String(file.size), media_type: file.type || "image/jpeg", media_category: "tweet_image" });
	const id = String(init.media_id_string);
	const part = new FormData();
	part.set("media", file, "media");
	await call({ command: "APPEND", media_id: id, segment_index: "0" }, part);
	await call({ command: "FINALIZE", media_id: id });
	return id;
}

async function updateWithMedia(viewer: Viewer, req: Request) {
	const form = await req.formData();
	const q = new URLSearchParams();
	const files: File[] = [];
	for (const [k, v] of form) {
		if (typeof v === "string") q.set(k, v);
		else if (/^media/.test(k) && v.size) files.push(v);
	}
	const ids: string[] = [];
	for (const f of files.slice(0, 4)) ids.push(await uploadPhoto(viewer, f));
	const out: Obj = await callOperation("CreateTweet", viewer, {
		tweet_text: q.get("status") ?? "",
		...(isId(q.get("in_reply_to_status_id")) ? { reply: { in_reply_to_tweet_id: q.get("in_reply_to_status_id"), exclude_reply_user_ids: [] } } : {}),
		media: { media_entities: ids.map((media_id) => ({ media_id, tagged_users: [] })), possibly_sensitive: q.get("possibly_sensitive") === "true" },
	});
	return json(withText(restStatus(out.data.create_tweet.tweet_results.result)));
}

// --- activity --------------------------------------------------------------------
// The Connect tab: who followed, liked, reposted or mentioned the viewer.

const ACTION: Record<string, string> = { heart_icon: "favorite", retweet_icon: "retweet", person_icon: "follow" };

async function aboutMe(viewer: Viewer, q: URLSearchParams) {
	const count = Math.min(Math.max(Number(q.get("count")) || 20, 1), 100);
	const out: Obj = await callOperation("NotificationsTimeline", viewer, { timeline_type: "All", count: 40 });
	const events: Obj[] = [];
	const me = await userById(viewer.id, viewer.id);
	const self = me ? { ...legacyUser(me), created_at: apiDate(me.created_at) } : undefined;
	for (const instruction of out.data.viewer_v2.user_results.result.notification_timeline.timeline.instructions ?? []) {
		for (const e of instruction.entries ?? []) {
			const ic = e.content?.itemContent ?? {};
			const at = String(ic.timestamp_ms ?? e.sortIndex ?? Date.now());
			const base = { created_at: apiDate(new Date(Number(at))), max_position: at, min_position: at };
			if (ic.__typename === "TimelineNotification") {
				const action = ACTION[ic.notification_icon];
				if (!action) continue;
				const sources = (ic.template?.from_users ?? []).flatMap((u: Obj) => (u.user_results?.result?.rest_id ? [restUser(u.user_results.result)] : []));
				const tweets = (ic.template?.target_objects ?? []).flatMap((t: Obj) => { const x = withText(restStatus(t.tweet_results?.result)); return x ? [x] : []; });
				if (!sources.length || (action !== "follow" && !tweets.length)) continue;
				const targets = action === "follow" ? (self ? [self] : []) : tweets;
				// the list rows of a repost read the post from target_objects; the repost itself is not kept apart, so the original stands in
				const objects = action === "retweet" ? tweets : [];
				events.push({ action, ...base, sources, sources_size: sources.length, targets, targets_size: targets.length, target_objects: objects, target_objects_size: objects.length });
			} else if (ic.tweet_results?.result) {
				const t = withText(restStatus(ic.tweet_results.result));
				if (!t || t.user_id_str === viewer.id) continue;
				const reply = t.in_reply_to_user_id_str === viewer.id;
				// a reply's target is the post it answers (a post); a mention's is the account
				const parent = reply && isId(t.in_reply_to_status_id_str) ? withText(await status(viewer, t.in_reply_to_status_id_str)) : undefined;
				const targets = reply ? (parent ? [parent] : []) : self ? [self] : [];
				if (!targets.length) continue;
				events.push({ action: reply ? "reply" : "mention", ...base, sources: t.user ? [t.user] : [], sources_size: 1, targets, targets_size: 1, target_objects: [t], target_objects_size: 1 });
			}
		}
	}
	return json(events.slice(0, count));
}

// GET /1.1/activity/by_friends.json: what the accounts the viewer follows have done lately,
// as far as the home timeline shows it: their reposts
async function byFriends(viewer: Viewer, q: URLSearchParams) {
	const count = Math.min(Math.max(Number(q.get("count")) || 20, 1), 100);
	const out: Obj = await callOperation("HomeLatestTimeline", viewer, { count: 60 });
	const events: Obj[] = [];
	for (const t of pageOf(out.data.home.home_timeline_urt).statuses) {
		const original = t.retweeted_status ? withText(t.retweeted_status) : undefined;
		if (!original || !t.user || t.user_id_str === viewer.id) continue;
		const at = String(Number((BigInt(t.id_str) >> 22n) + 1288834974657n));
		events.push({ action: "retweet", created_at: t.created_at, max_position: at, min_position: at, sources: [t.user], sources_size: 1, targets: [original], targets_size: 1, target_objects: [original], target_objects_size: 1 });
	}
	return json(events.slice(0, count));
}

// --- friendships -----------------------------------------------------------------

async function friendship(viewer: Viewer, u: Obj) {
	const perspective = (await userById(viewer.id, u.id)) as Obj | undefined;
	return perspective?.stats ?? {};
}

async function lookupFriendships(viewer: Viewer, q: URLSearchParams) {
	const users: Obj[] = [];
	for (const id of (q.get("user_id") ?? "").split(",").filter(isId)) { const u = await userById(viewer.id, id); if (u) users.push(u); }
	for (const n of (q.get("screen_name") ?? "").split(",").filter(Boolean)) { const u = await userByName(viewer.id, n.replace(/^@/, "")); if (u) users.push(u); }
	return json(await Promise.all(users.slice(0, 100).map(async (u) => {
		const s = await friendship(viewer, u);
		const connections = [...(s.followedByViewer ? ["following"] : []), ...(s.requestedByViewer ? ["following_requested"] : []), ...(s.followsViewer ? ["followed_by"] : []), ...(s.blocking ? ["blocking"] : []), ...(s.muting ? ["muting"] : [])];
		return { name: u.name, screen_name: u.screen_name, id_str: u.id, connections: connections.length ? connections : ["none"] };
	})));
}

async function showFriendship(viewer: Viewer, q: URLSearchParams) {
	const a = await (q.get("source_id") || q.get("source_screen_name") ? target(viewer, new URLSearchParams({ ...(q.get("source_id") ? { user_id: q.get("source_id")! } : {}), ...(q.get("source_screen_name") ? { screen_name: q.get("source_screen_name")! } : {}) })) : userById(viewer.id, viewer.id).then((u) => u!));
	const b = await target(viewer, new URLSearchParams({ ...(q.get("target_id") ? { user_id: q.get("target_id")! } : {}), ...(q.get("target_screen_name") ? { screen_name: q.get("target_screen_name")! } : {}) }));
	const [sa, sb] = await Promise.all([friendship(viewer, a), friendship(viewer, b)]);
	const mine = a.id === viewer.id;
	return json({
		relationship: {
			source: { id_str: a.id, screen_name: a.screen_name, following: mine ? !!sb.followedByViewer : false, followed_by: mine ? !!sb.followsViewer : false, can_dm: !!mine, blocking: mine ? !!sb.blocking : false, muting: mine ? !!sb.muting : false, notifications_enabled: false, want_retweets: true, all_replies: false, marked_spam: false },
			target: { id_str: b.id, screen_name: b.screen_name, following: mine ? !!sb.followsViewer : false, followed_by: mine ? !!sb.followedByViewer : false },
		},
	});
}

// --- saved searches -----------------------------------------------------------------

const savedSearch = (r: Obj) => ({ id_str: r.id, name: r.query, query: r.query, position: null, created_at: apiDate(r.created_at) });

async function savedSearches(viewer: Viewer) {
	const rows = await sql`select id::text, query, created_at from classic_saved_searches where user_id = ${viewer.id}::bigint order by id desc limit 25`;
	return json(rows.map(savedSearch));
}

async function saveSearch(viewer: Viewer, p: URLSearchParams) {
	const query = (p.get("query") ?? p.get("q") ?? "").trim().slice(0, 500);
	if (!query) throw new PostError("Missing query.", 44);
	const [row] = await sql`insert into classic_saved_searches (user_id, query) values (${viewer.id}::bigint, ${query})
		on conflict (user_id, query) do update set query = excluded.query returning id::text, query, created_at`;
	return json(savedSearch(row));
}

async function forgetSearch(viewer: Viewer, id: string) {
	const [row] = await sql`delete from classic_saved_searches where id = ${id}::bigint and user_id = ${viewer.id}::bigint returning id::text, query, created_at`;
	if (!row) return gone("Sorry, that page does not exist", 34, 404);
	return json(savedSearch(row));
}

// --- routes ----------------------------------------------------------------------

// Search and Discover answer in "modules": each is one result of a kind (a post, an
// account) with its data and a little metadata, the app reads them top to bottom
const module = (kind: "status" | "user", data: Obj, resultType: string) => ({ [kind]: { data, metadata: { result_type: resultType } } });

// the accounts a GraphQL timeline lists, in order
function usersOf(timeline: Obj | undefined): Obj[] {
	const out: Obj[] = [];
	for (const instruction of timeline?.instructions ?? [])
		for (const e of instruction.entries ?? []) {
			const c = e.content ?? {};
			for (const ic of c.items ? c.items.map((i: Obj) => i.item?.itemContent ?? {}) : [c.itemContent ?? {}])
				if (ic.user_results?.result?.rest_id) out.push(restUser(ic.user_results.result));
		}
	return out;
}

// GET /1.1/search/universal.json: posts (and for the top tab a few accounts) matching q
async function searchUniversal(viewer: Viewer, q: URLSearchParams) {
	const latest = q.get("result_type") === "recent";
	const cursor = q.get("cursor") ?? undefined;
	const out: Obj = await callOperation("SearchTimeline", viewer, { rawQuery: q.get("q") ?? "", product: latest ? "Latest" : "Top", count: 20, ...(cursor ? { cursor } : {}) });
	const timeline = out.data.search_by_raw_query.search_timeline.timeline;
	const { statuses, next } = pageOf(timeline);
	const people = latest || cursor ? [] : usersOf(timeline).slice(0, 3);
	return json({
		modules: [...people.map((u) => module("user", u, "user")), ...statuses.map((s) => module("status", withText(s), latest ? "recent" : "popular"))],
		metadata: next ? { cursor: next } : {},
	});
}

// GET /1.1/discover/universal.json: what is being posted, with accounts to follow in front.
// Its modules are a post ("status") or a set of accounts ("wtf").
async function discoverUniversal(viewer: Viewer, q: URLSearchParams) {
	const cursor = q.get("cursor") ?? q.get("next_cursor") ?? undefined;
	const out: Obj = await callOperation("HomeTimeline", viewer, { count: 20, ...(cursor ? { cursor } : {}) });
	const { statuses, next } = pageOf(out.data.home.home_timeline_urt);
	const people: Obj[] = cursor ? [] : (await callOperation("ConnectTabTimeline", viewer, {}).then((r: Obj) => usersOf(r.data.connect_tab_timeline.timeline)).catch(() => [])).slice(0, 3);
	return json({
		modules: [...(people.length ? [{ wtf: { data: { users: people.map((u) => ({ user: u, token: `xitter-${u.id_str}` })) } } }] : []), ...statuses.map((s) => module("status", withText(s), "popular"))],
		metadata: { ...(next ? { next_cursor: next } : {}) },
	});
}

// the trends of the user's Explore settings, as the first API listed them
async function trendsPlace(viewer: Viewer) {
	const scope = await trendScope(viewer.id);
	const now = apiDate(new Date());
	const trends = (await cachedTrends(7, 10, scope)).map((t) => ({ name: t.tag, query: encodeURIComponent(t.tag), url: `${PUBLIC_ORIGIN}/search?q=${encodeURIComponent(t.tag)}`, promoted_content: null, events: null }));
	return json([{ trends, as_of: now, created_at: now, locations: [{ name: scope.label || "Worldwide", woeid: 1 }] }]);
}


export async function restClassicRoute(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	const q = new URL(req.url).searchParams;
	try {
		if (method === "GET") {
			switch (path) {
				case "/1.1/statuses/user_timeline.json": {
					const u = await target(viewer, q);
					const op = q.get("exclude_replies") === "true" ? "UserTweets" : "UserTweetsAndReplies";
					return json(await statusPages(q, async (cursor) => ((await callOperation(op, viewer, { userId: u.id, count: 40, ...(cursor ? { cursor } : {}) })) as Obj).data.user.result.timeline.timeline));
				}
				case "/1.1/statuses/media_timeline.json": {
					const u = await target(viewer, q);
					return json(await statusPages(q, async (cursor) => ((await callOperation("UserMedia", viewer, { userId: u.id, count: 40, ...(cursor ? { cursor } : {}) })) as Obj).data.user.result.timeline.timeline));
				}
				case "/1.1/favorites/list.json": {
					const u = await target(viewer, q);
					return json(await statusPages(q, async (cursor) => ((await callOperation("Likes", viewer, { userId: u.id, count: 40, ...(cursor ? { cursor } : {}) })) as Obj).data.user.result.timeline.timeline));
				}
				case "/1.1/statuses/mentions_timeline.json":
					return json(await statusPages(q, async (cursor) => ((await callOperation("NotificationsTimeline", viewer, { timeline_type: "Mentions", count: 40, ...(cursor ? { cursor } : {}) })) as Obj).data.viewer_v2.user_results.result.notification_timeline.timeline));
				case "/1.1/direct_messages.json":
					return dmList(viewer, q, false);
				case "/1.1/direct_messages/sent.json":
					return dmList(viewer, q, true);
				case "/1.1/direct_messages/show.json":
					return dmShowOrDestroy(viewer, q, false);
				case "/1.1/activity/by_friends.json":
					return byFriends(viewer, q);
				case "/1.1/activity/about_me.json":
					return aboutMe(viewer, q);
				case "/1.1/friendships/lookup.json":
					return lookupFriendships(viewer, q);
				case "/1.1/friendships/show.json":
					return showFriendship(viewer, q);
				case "/1.1/saved_searches/list.json":
					return savedSearches(viewer);
				case "/1.1/conversation/show.json": {
					const id = q.get("id");
					if (!isId(id)) throw new PostError("Missing id.", 25);
					const out: Obj = await callOperation("TweetDetail", viewer, { focalTweetId: id });
					const seen = new Set<string>();
					return json(pageOf(out.data.threaded_conversation_with_injections_v2).statuses.filter((t) => !seen.has(t.id_str) && seen.add(t.id_str)));
				}
				case "/1.1/search/universal.json":
					return await searchUniversal(viewer, q);
				case "/1.1/discover/universal.json":
					return await discoverUniversal(viewer, q);
				case "/1/trends/1.json":
				case "/1.1/trends/place.json":
					return await trendsPlace(viewer);
				case "/1.1/trends/available.json":
					return json([{ name: "Worldwide", woeid: 1, placeType: { code: 19, name: "Supername" }, country: "", countryCode: null }]);
				case "/1.1/users/suggestions.json":
					return json([]);
			}
		} else if (method === "POST") {
			const destroy = /^\/1\.1\/saved_searches\/destroy\/(\d{1,19})\.json$/.exec(path);
			if (destroy) return await forgetSearch(viewer, destroy[1]);
			switch (path) {
				case "/1.1/saved_searches/create.json": {
					const p = new URLSearchParams(q);
					const f = await req.formData().catch(() => undefined);
					if (f) for (const [k, v] of f) if (typeof v === "string") p.set(k, v);
					return await saveSearch(viewer, p);
				}
				case "/1.1/statuses/update_with_media.json":
					return await updateWithMedia(viewer, req);
				case "/1.1/direct_messages/new.json":
				case "/1.1/direct_messages/destroy.json": {
					const f = await req.formData().catch(() => undefined);
					const p = new URLSearchParams(q);
					if (f) for (const [k, v] of f) if (typeof v === "string") p.set(k, v);
					return path.endsWith("/new.json") ? await dmNew(viewer, p) : await dmShowOrDestroy(viewer, p, true);
				}
			}
		}
	} catch (e) {
		return failure(e);
	}
	return undefined;
}
