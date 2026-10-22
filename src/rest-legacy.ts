// The rest of the v1.1 and v2 endpoints the 2018-2022 web clients call: account
// and user lookups, follower and block lists, lists, bookmarks, pins, search and
// the reaction timelines. Each runs the GraphQL handler or the function behind it
// and reshapes the answer; what this server has nothing behind (direct messages
// in the old format, trends, moments, device registration) answers as empty, so
// the client draws its page instead of stopping on a missing response.
// Posting, liking and the conversation and profile timelines are in rest-timeline.ts.

import type { Viewer } from "./auth";
import { blockedIds } from "./blocks";
import { callOperation } from "./graphql";
import { legacyUser } from "./model";
import { PostError, setPinned } from "./posts";
import { followList, setFollow, userById, userByName, usersByIds } from "./users";
import { unreadCount } from "./notifications";
import { failure, gone, restNotifications, restStatus, restTimeline, restUser, status } from "./rest-timeline";

type Obj = Record<string, any>;
type Handler = (viewer: Viewer, q: URLSearchParams) => Promise<unknown> | unknown;

const isId = (v: unknown): v is string => typeof v === "string" && /^\d{1,19}$/.test(v);
const truthy = (v: string | null) => v === "true" || v === "1";
const NOT_FOUND = () => new PostError("Sorry, that page does not exist.", 34);

const emptyObjects = () => ({ tweets: {}, users: {}, notifications: {}, moments: {}, cards: {}, places: {}, media: {}, broadcasts: {}, topics: {}, lists: {} });
const emptyTimeline = (id: string) => ({ globalObjects: emptyObjects(), timeline: { id, instructions: [] } });

const page = (key: string, items: unknown[]) => ({ [key]: items, next_cursor: 0, next_cursor_str: "0", previous_cursor: 0, previous_cursor_str: "0" });

// the account a request names: user_id, screen_name, or the viewer
async function target(viewer: Viewer, q: URLSearchParams) {
	const id = q.get("user_id") ?? q.get("id");
	const name = q.get("screen_name");
	const user = isId(id) ? await userById(viewer.id, id) : name ? await userByName(viewer.id, name.replace(/^@/, "")) : await userById(viewer.id, viewer.id);
	if (!user) throw new PostError("User not found.", 50);
	return user;
}

// every item of a GraphQL timeline, modules included
function itemsOf(timeline: Obj | undefined): Obj[] {
	const out: Obj[] = [];
	for (const instruction of timeline?.instructions ?? [])
		for (const e of instruction.entries ?? []) {
			const c = e.content ?? {};
			if (c.items) for (const i of c.items) out.push(i.item?.itemContent ?? {});
			else out.push(c.itemContent ?? {});
		}
	return out;
}

// "Wed Oct 21 00:35:39 +0000 2026"
function twitterDate(ms: unknown) {
	const [wd, d, mon, y, time] = new Date(Number(ms) || Date.now()).toUTCString().replace(",", "").split(" ");
	return `${wd} ${mon} ${d} ${time} +0000 ${y}`;
}

// a GraphQL list as v1.1 lists look
function restList(list: Obj): Obj {
	const owner = list.user_results?.result;
	const slug = String(list.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "list";
	return {
		id: Number(list.id_str),
		id_str: list.id_str,
		name: list.name,
		slug,
		description: list.description ?? "",
		mode: String(list.mode ?? "Public").toLowerCase(),
		member_count: list.member_count ?? 0,
		subscriber_count: list.subscriber_count ?? 0,
		created_at: twitterDate(list.created_at),
		following: !!list.following,
		uri: owner ? `/${owner.core?.screen_name}/lists/${slug}` : `/i/lists/${list.id_str}`,
		...(owner ? { user: restUser(owner) } : {}),
	};
}

const listsOf = (timeline: Obj | undefined) => itemsOf(timeline).flatMap((c) => (c.list ? [restList(c.list)] : []));
const usersOf = (timeline: Obj | undefined) => itemsOf(timeline).flatMap((c) => (c.user_results?.result?.rest_id ? [restUser(c.user_results.result)] : []));
const statusesOf = (timeline: Obj | undefined) => itemsOf(timeline).flatMap((c) => { const s = restStatus(c.tweet_results?.result); return s ? [s] : []; });

const listId = (q: URLSearchParams) => {
	const id = q.get("list_id");
	if (!isId(id)) throw NOT_FOUND();
	return id;
};

const userList = async (viewer: Viewer, ids: string[]) => {
	const users = await usersByIds(viewer.id, ids);
	return page("users", ids.flatMap((id) => (users.has(id) ? [legacyUser(users.get(id)!)] : [])));
};

// direct messages: the old format is not kept, so the inbox is empty
const dmState = (cursor = "0") => ({ last_seen_event_id: "0", trusted_last_seen_event_id: "0", untrusted_last_seen_event_id: "0", cursor, entries: [], users: {}, conversations: {} });
const noDirectMessages = () => gone("Direct messages are not available here.", 214, 403);

const GET: Record<string, Handler> = {
	"/1.1/account/verify_credentials.json": async (v) => legacyUser((await userById(v.id, v.id))!),
	"/1.1/users/show.json": async (v, q) => legacyUser(await target(v, q)),
	"/1.1/followers/list.json": async (v, q) => userList(v, (await followList(v.id, (await target(v, q)).id, "followers")).map((u) => u.id)),
	"/1.1/friends/list.json": async (v, q) => userList(v, (await followList(v.id, (await target(v, q)).id, "following")).map((u) => u.id)),
	"/1.1/blocks/list.json": async (v) => userList(v, await blockedIds(v.id, "blocks")),
	"/1.1/mutes/users/list.json": async (v) => userList(v, await blockedIds(v.id, "mutes")),

	"/1.1/lists/show.json": async (v, q) => {
		const out: Obj = await callOperation("ListByRestId", v, { listId: listId(q) });
		if (!out.data.list) throw NOT_FOUND();
		return restList(out.data.list);
	},
	"/1.1/lists/ownerships.json": async (v, q) => page("lists", listsOf(((await callOperation("ListOwnerships", v, { userId: (await target(v, q)).id })) as Obj).data.user.result.timeline.timeline)),
	"/1.1/lists/memberships.json": async (v, q) => page("lists", listsOf(((await callOperation("ListMemberships", v, { userId: (await target(v, q)).id })) as Obj).data.user.result.timeline.timeline)),
	"/1.1/lists/subscriptions.json": async (v, q) => {
		const out: Obj = await callOperation("CombinedLists", v, { userId: (await target(v, q)).id });
		return page("lists", listsOf(out.data.user.result.timeline.timeline).filter((l) => l.following));
	},
	"/1.1/lists/members.json": async (v, q) => page("users", usersOf(((await callOperation("ListMembers", v, { listId: listId(q) })) as Obj).data.list.members_timeline.timeline)),
	"/1.1/lists/subscribers.json": async (v, q) => page("users", usersOf(((await callOperation("ListSubscribers", v, { listId: listId(q) })) as Obj).data.list.subscribers_timeline.timeline)),
	"/1.1/lists/statuses.json": async (v, q) => {
		const count = Number(q.get("count"));
		const out: Obj = await callOperation("ListLatestTweetsTimeline", v, { listId: listId(q), ...(count > 0 ? { count } : {}) });
		return statusesOf(out.data.list.tweets_timeline.timeline);
	},

	"/1.1/dm/user_inbox.json": () => ({ user_inbox: { ...dmState(), inbox_timelines: { trusted: { status: "AT_END", min_entry_id: "0" }, untrusted: { status: "AT_END", min_entry_id: "0" } } } }),
	"/1.1/dm/user_updates.json": () => ({ user_events: dmState() }),
	"/1.1/dm/permissions.json": () => ({ permissions: { id_str: {}, user_ids: {} } }),

	// no trends of its own to show here (Explore has its own)
	"/1.1/trends/available.json": () => [],
	"/1.1/trends/plus.json": () => ({ modules: [], timestamp: Date.now() }),
	"/1.1/activity/about_me.json": () => [],
	"/1.1/activity/about_me/unread.json": () => ({ unread_count: 0 }),
	"/1.1/application/rate_limit_status.json": () => ({ rate_limit_context: { access_token: "" }, resources: {} }),
	"/1.1/account/personalization/app_graph.json": () => ({ app_graph: [] }),
	"/1.1/account/personalization/partner_interests.json": () => ({ interests: [] }),
	"/1.1/account/personalization/twitter_interests.json": () => ({ interests: [] }),
	"/1.1/broadcasts/show.json": () => ({ broadcasts: {} }),
	"/1.1/collections/entries.json": () => ({ objects: {}, response: { results: [], position: null } }),
	"/1.1/foundmedia/categories.json": () => ({ categories: [] }),
	"/1.1/foundmedia/search.json": () => ({ data: [], next: "" }),
	"/1.1/interests/suggestions.json": () => [],
	"/1.1/prompts/suggest.json": () => ({}),
	"/1.1/storystream/stories.json": () => ({ stories: [] }),
	"/1.1/users/extended_profile.json": () => ({}),
	"/1.1/users/phone_number_available.json": () => ({ valid: false, msg: "Phone numbers are not used here.", available: false }),
};

// POSTs with nothing to change or nothing to report
const ACK = [
	"/1.1/activity/about_me/unread.json",
	"/1.1/device/register.json",
	"/1.1/device/register_complete.json",
	"/1.1/device/unregister.json",
	"/1.1/geo/delete_location_data.json",
	"/1.1/mobile/settings/get.json",
	"/1.1/mobile/settings/save.json",
	"/1.1/moments/like.json",
	"/1.1/moments/unlike.json",
	"/1.1/moments/subscribe.json",
	"/1.1/moments/unsubscribe.json",
	"/1.1/onboarding/task.json",
	"/1.1/prompts/record_event.json",
	"/1.1/push_destinations/destroy.json",
	"/1.1/timelines/feedback.json",
	"/1.1/direct_messages/report_spam.json",
	"/1.1/dm/update_last_seen_event_id.json",
];

const POST: Record<string, Handler> = {
	"/1.1/account/pin_tweet.json": async (v, q) => {
		const id = q.get("id");
		if (!isId(id) || !(await setPinned(v.id, id))) throw new PostError("You can only pin your own posts.", 144);
		return legacyUser((await userById(v.id, v.id))!);
	},
	"/1.1/account/unpin_tweet.json": async (v) => {
		await setPinned(v.id, null);
		return legacyUser((await userById(v.id, v.id))!);
	},
	"/1.1/bookmark/entries/add.json": async (v, q) => marked(v, q, "CreateBookmark"),
	"/1.1/bookmark/entries/remove.json": async (v, q) => marked(v, q, "DeleteBookmark"),
	"/1.1/friendships/create_all.json": async (v, q) => {
		const users = [];
		for (const id of (q.get("user_id") ?? "").split(",").filter(isId).slice(0, 100)) {
			await setFollow(v.id, id, true);
			const user = await userById(v.id, id);
			if (user) users.push(legacyUser(user));
		}
		return users;
	},
	"/1.1/lists/create.json": async (v, q) => {
		const out: Obj = await callOperation("CreateList", v, { name: q.get("name") ?? "", description: q.get("description") ?? "", isPrivate: q.get("mode") === "private" });
		return restList(out.data.list);
	},
	"/1.1/lists/members/create.json": async (v, q) => {
		const userId = q.get("user_id");
		if (!isId(userId)) throw new PostError("User not found.", 50);
		const id = listId(q);
		await callOperation("ListAddMember", v, { listId: id, userId });
		return restList(((await callOperation("ListByRestId", v, { listId: id })) as Obj).data.list);
	},
	// Muting a conversation is not kept; the tweet comes back as it was
	"/1.1/mutes/conversations/create.json": async (v, q) => shown(v, q),
	"/1.1/mutes/conversations/destroy.json": async (v, q) => shown(v, q),
	"/1.1/account/password_strength.json": () => ({ valid: true, score: 1 }),
	"/1.1/guest/activate.json": () => ({ guest_token: String(Date.now()) }),
	"/1.1/signup/sms_verify_begin.json": () => gone("Phone numbers are not used here.", 214, 403),
	"/1.1/dm/new.json": noDirectMessages,
	"/1.1/dm/destroy.json": noDirectMessages,
};

async function shown(viewer: Viewer, q: URLSearchParams) {
	const id = q.get("tweet_id") ?? q.get("id");
	const out = isId(id) ? await status(viewer, id) : undefined;
	if (!out) throw new PostError("No status found with that ID.", 144);
	return out;
}

async function marked(viewer: Viewer, q: URLSearchParams, op: "CreateBookmark" | "DeleteBookmark") {
	const id = q.get("tweet_id");
	if (!isId(id)) throw new PostError("No status found with that ID.", 144);
	await callOperation(op, viewer, { tweet_id: id });
	return shown(viewer, q);
}

// timelines of tweets or accounts, as the 2018 clients' "URT" endpoints answer
const URT = async (path: string, viewer: Viewer, q: URLSearchParams): Promise<unknown | undefined> => {
	const count = Number(q.get("count"));
	const cursor = q.get("cursor") ?? undefined;
	const paged = { ...(count > 0 ? { count } : {}), ...(cursor ? { cursor } : {}) };
	const reindexed = (timeline: Obj, id: string) => restTimeline(timeline, id, true);
	if (path === "/2/timeline/bookmark.json") return reindexed(((await callOperation("Bookmarks", viewer, paged)) as Obj).data.bookmark_timeline_v2.timeline, "bookmark");
	if (path === "/2/timeline/list.json") return reindexed(((await callOperation("ListLatestTweetsTimeline", viewer, { listId: listId(q), ...paged })) as Obj).data.list.tweets_timeline.timeline, "list");
	if (path === "/2/timeline/retweeted_by.json" || path === "/2/timeline/liked_by.json") {
		const liked = path.includes("liked_by");
		const out: Obj = await callOperation(liked ? "Favoriters" : "Retweeters", viewer, { tweetId: q.get("tweet_id") ?? "" });
		return reindexed(out.data[liked ? "favoriters_timeline" : "retweeters_timeline"].timeline, liked ? "liked_by" : "retweeted_by");
	}
	if (path === "/2/search/adaptive.json") {
		const filter = q.get("result_filter");
		const product = filter === "user" ? "People" : filter === "image" || filter === "video" ? "Media" : q.get("tweet_search_mode") === "live" || filter === "tweets" ? "Latest" : "Top";
		const out: Obj = await callOperation("SearchTimeline", viewer, { rawQuery: q.get("q") ?? "", product, ...paged });
		return reindexed(out.data.search_by_raw_query.search_timeline.timeline, "search");
	}
	const notes = /^\/2\/notifications\/(all|mentions)(\/unread_count)?\.json$/.exec(path);
	if (notes?.[2]) return { unread_count: await unreadCount(viewer.id) };
	if (notes) {
		const out: Obj = await callOperation("NotificationsTimeline", viewer, { timeline_type: notes[1] === "mentions" ? "Mentions" : "All", ...paged });
		return restNotifications(out.data.viewer_v2.user_results.result.notification_timeline.timeline);
	}
	if (path === "/2/badge_count/badge_count.json") {
		const n = await unreadCount(viewer.id);
		return { ntab_unread_count: n, dm_unread_count: 0, total_unread_count: n };
	}
	if (path === "/2/guide/topic.json") return emptyTimeline("topic");
	if (path === "/2/moments/list_user_moments.json") return emptyTimeline("moments");
	if (/^\/2\/(live_event\/timeline|moments\/capsule)\//.test(path)) return emptyTimeline("event");
	return undefined;
};

export async function restLegacyRoute(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	try {
		const q = new URLSearchParams(new URL(req.url).search);
		if (method === "GET") {
			const answer = GET[path] ? await GET[path](viewer, q) : await URT(path, viewer, q);
			return answer === undefined ? undefined : answer instanceof Response ? answer : Response.json(answer);
		}
		if (method !== "POST") return undefined;
		if (!ACK.includes(path) && !POST[path]) return undefined;
		const f = await req.formData().catch(() => undefined);
		if (f) for (const [k, v] of f) if (typeof v === "string") q.set(k, v);
		if (ACK.includes(path)) return Response.json({});
		const answer = await POST[path](viewer, q);
		return answer instanceof Response ? answer : Response.json(answer);
	} catch (e) {
		return failure(e);
	}
}
