// The home timeline as the web clients before November 2022 ask for it:
// GET /2/timeline/home.json and home_latest.json answer with the REST v2 shape
// (globalObjects plus a timeline of entries that point into it). Later clients
// use GraphQL; this runs the same handler and reshapes its result, so the
// ranking, filters and cursors are the ones graphql.ts already has.

import type { Viewer } from "./auth";
import { PostError } from "./posts";
import { callOperation } from "./graphql";

type Obj = Record<string, any>;

// the GraphQL user record, as the REST users of globalObjects look
export function restUser(u: Obj): Obj {
	return {
		id_str: u.rest_id,
		name: u.core?.name,
		screen_name: u.core?.screen_name,
		created_at: u.core?.created_at,
		description: u.profile_bio?.description ?? "",
		entities: u.profile_bio?.entities ?? { description: { urls: [] } },
		location: u.location?.location ?? "",
		url: u.website?.url || null,
		protected: !!u.privacy?.protected,
		verified: false,
		ext_is_blue_verified: !!u.is_blue_verified,
		followers_count: u.relationship_counts?.followers ?? 0,
		friends_count: u.relationship_counts?.following ?? 0,
		statuses_count: u.tweet_counts?.tweets ?? 0,
		media_count: u.tweet_counts?.media_tweets ?? 0,
		favourites_count: u.action_counts?.favorites_count ?? 0,
		profile_image_url_https: u.avatar?.image_url,
		...(u.banner?.image_url ? { profile_banner_url: u.banner.image_url } : {}),
		pinned_tweet_ids_str: u.pinned_items?.tweet_ids_str ?? [],
		default_profile: false,
		default_profile_image: false,
		profile_interstitial_type: "",
		translator_type: u.profile_translation?.translator_type ?? "none",
		following: !!u.relationship_perspectives?.following,
		followed_by: !!u.relationship_perspectives?.followed_by,
		blocking: !!u.relationship_perspectives?.blocking,
		blocked_by: !!u.relationship_perspectives?.blocked_by,
		muting: !!u.relationship_perspectives?.muting,
		follow_request_sent: !!u.follow_request_sent,
		can_dm: false,
	};
}

// A tweet result and the tweets and users it brings with it: its author, the
// post it reposts, the post it quotes.
function collect(result: Obj | undefined, tweets: Obj, users: Obj): string | undefined {
	const tweet = result?.__typename === "TweetWithVisibilityResults" ? result.tweet : result;
	if (!tweet?.legacy || !tweet.rest_id) return undefined;
	const author = tweet.core?.user_results?.result;
	if (author?.rest_id) users[author.rest_id] = restUser(author);
	const legacy: Obj = { ...tweet.legacy, id_str: tweet.rest_id };
	const repost = legacy.retweeted_status_result?.result;
	delete legacy.retweeted_status_result;
	const reposted = collect(repost, tweets, users);
	if (reposted) legacy.retweeted_status_id_str = reposted;
	const quoted = collect(tweet.quoted_status_result?.result, tweets, users);
	if (quoted) legacy.quoted_status_id_str = quoted;
	if (tweet.views?.count) legacy.ext_views = { count: tweet.views.count, state: tweet.views.state };
	tweets[tweet.rest_id] = legacy;
	return tweet.rest_id;
}

// `reindex`: the entries come in display order but their sort indexes are not
// unique (a conversation's threads), so number them again, highest first
export function restTimeline(urt: Obj, id = "home", reindex = false): Obj {
	const tweets: Obj = {};
	const users: Obj = {};
	const found: Obj[] = [];
	const add = (entryId: string, sortIndex: string, c: Obj) => {
		if (c.cursorType)
			found.push({ entryId, sortIndex, content: { operation: { cursor: { value: c.value, cursorType: c.cursorType } } } });
		else if (c.user_results?.result?.rest_id) {
			const uid = c.user_results.result.rest_id;
			users[uid] = restUser(c.user_results.result);
			found.push({ entryId: reindex ? `user-${uid}` : entryId, sortIndex, content: { item: { content: { user: { id: uid } } } } });
		} else {
			const tid = collect(c.tweet_results?.result, tweets, users);
			if (tid) found.push({ entryId: reindex ? `tweet-${tid}` : entryId, sortIndex, content: { item: { content: { tweet: { id: tid, displayType: "Tweet" } } } } });
		}
	};
	for (const instruction of urt.instructions ?? []) {
		for (const e of instruction.entries ?? []) {
			const c = e.content ?? {};
			if (c.items) for (const i of c.items) add(i.entryId ?? e.entryId, e.sortIndex, i.item?.itemContent ?? {});
			else add(e.entryId, e.sortIndex, c.cursorType ? c : (c.itemContent ?? {}));
		}
		for (const i of instruction.moduleItems ?? []) add(i.entryId, "0", i.item?.itemContent ?? {});
	}
	if (reindex) {
		const seen = new Set<string>();
		const base = BigInt(Date.now()) * 1000n;
		const entries = found.filter((e) => !seen.has(e.entryId) && seen.add(e.entryId));
		entries.forEach((e, i) => (e.sortIndex = (base - BigInt(i)).toString()));
		found.splice(0, found.length, ...entries);
	}
	return {
		globalObjects: { tweets, users, moments: {}, cards: {}, places: {}, media: {}, broadcasts: {}, topics: {}, lists: {} },
		timeline: { id, instructions: [{ addEntries: { entries: found } }] },
	};
}

// The Notifications tab: notifications themselves live in globalObjects, each
// naming the accounts and the tweet it is about; mentions and replies are tweets.
export function restNotifications(urt: Obj): Obj {
	const tweets: Obj = {};
	const users: Obj = {};
	const notifications: Obj = {};
	const entries: Obj[] = [];
	const instructions: Obj[] = [];
	const user = (result: Obj | undefined) => {
		if (result?.rest_id) users[result.rest_id] = restUser(result);
		return result?.rest_id as string | undefined;
	};
	for (const instruction of urt.instructions ?? []) {
		if (instruction.type === "TimelineMarkEntriesUnreadGreaterThanSortIndex") instructions.push({ markEntriesUnreadGreaterThanSortIndex: { sortIndex: instruction.sort_index } });
		for (const e of instruction.entries ?? []) {
			const c = e.content ?? {};
			const ic = c.itemContent ?? {};
			if (c.cursorType) entries.push({ entryId: e.entryId, sortIndex: e.sortIndex, content: { operation: { cursor: { value: c.value, cursorType: c.cursorType } } } });
			else if (ic.__typename === "TimelineNotification") {
				const fromUsers = (ic.template?.from_users ?? []).flatMap((u: Obj) => {
					const id = user(u.user_results?.result);
					return id ? [{ user: { id } }] : [];
				});
				const targetObjects = (ic.template?.target_objects ?? []).flatMap((t: Obj) => {
					const id = collect(t.tweet_results?.result, tweets, users);
					return id ? [{ tweet: { id } }] : [];
				});
				const msg = ic.rich_message ?? {};
				notifications[ic.id] = {
					id: ic.id,
					timestampMs: String(ic.timestamp_ms),
					icon: { id: ic.notification_icon },
					message: {
						text: msg.text ?? "",
						entities: (msg.entities ?? []).flatMap((x: Obj) => {
							const id = user(x.ref?.user_results?.result);
							return id ? [{ fromIndex: x.fromIndex, toIndex: x.toIndex, ref: { user: { id } } }] : [];
						}),
						rtl: false,
					},
					template: { aggregateUserActionsV1: { targetObjects, fromUsers } },
				};
				entries.push({ entryId: e.entryId, sortIndex: e.sortIndex, content: { item: { content: { notification: { id: ic.id } }, clientEventInfo: c.clientEventInfo } } });
			} else {
				const id = collect(ic.tweet_results?.result, tweets, users);
				if (id) entries.push({ entryId: e.entryId, sortIndex: e.sortIndex, content: { item: { content: { tweet: { id, displayType: "Tweet" } }, clientEventInfo: c.clientEventInfo } } });
			}
		}
	}
	return {
		globalObjects: { tweets, users, notifications, moments: {}, cards: {}, places: {}, media: {}, broadcasts: {}, topics: {}, lists: {} },
		timeline: { id: "notifications", instructions: [{ addEntries: { entries } }, ...instructions] },
	};
}

// A tweet result as the v1.1 endpoints answer: the tweet with its author, the
// post it reposts and the post it quotes inside it.
export function restStatus(result: Obj | undefined): Obj | undefined {
	const tweets: Obj = {};
	const users: Obj = {};
	const id = collect(result, tweets, users);
	if (!id) return undefined;
	const embed = (tid: string): Obj => {
		const { retweeted_status_id_str, quoted_status_id_str, ...t } = tweets[tid];
		return {
			...t,
			user: users[t.user_id_str],
			...(retweeted_status_id_str && tweets[retweeted_status_id_str] ? { retweeted_status: embed(retweeted_status_id_str) } : {}),
			...(quoted_status_id_str && tweets[quoted_status_id_str] ? { quoted_status_id_str, quoted_status: embed(quoted_status_id_str) } : {}),
		};
	};
	return embed(id);
}

export const gone = (message: string, code: number, status: number) => Response.json({ errors: [{ code, message }] }, { status });
export function failure(e: unknown): Response {
	if (e instanceof PostError) return gone(e.message, e.code, e.code === 144 || e.code === 50 ? 404 : 403);
	throw e;
}

async function params(req: Request): Promise<URLSearchParams> {
	const q = new URLSearchParams(new URL(req.url).search);
	if (req.method === "POST") {
		const f = await req.formData().catch(() => undefined);
		if (f) for (const [k, v] of f) if (typeof v === "string") q.set(k, v);
	}
	return q;
}

export async function status(viewer: Viewer, id: string): Promise<Obj | undefined> {
	const out: Obj = await callOperation("TweetResultByRestId", viewer, { tweetId: id });
	return restStatus(out.data?.tweetResult?.result);
}

const truthy = (v: string | null) => v === "true" || v === "1";

// The timelines the 2018-2022 web client opens: a conversation, a profile's tabs.
// Each runs the GraphQL handler and reshapes its answer like home does.
export async function restTimelineRoute(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	if (method !== "GET") return undefined;
	const m = /^\/2\/timeline\/(conversation|profile|media|favorites)\/(\d{1,19})\.json$/.exec(path);
	if (!m) return undefined;
	const q = new URL(req.url).searchParams;
	const count = Number(q.get("count"));
	const cursor = q.get("cursor") ?? undefined;
	const page = { ...(count > 0 ? { count } : {}), ...(cursor ? { cursor } : {}) };
	try {
		if (m[1] === "conversation") {
			const out: Obj = await callOperation("TweetDetail", viewer, { focalTweetId: m[2], ...(cursor ? { cursor } : {}) });
			return Response.json(restTimeline(out.data.threaded_conversation_with_injections_v2, "conversation", true));
		}
		const op = m[1] === "profile" ? (truthy(q.get("include_tweet_replies")) ? "UserTweetsAndReplies" : "UserTweets") : m[1] === "media" ? "UserMedia" : "Likes";
		const out: Obj = await callOperation(op, viewer, { userId: m[2], ...page });
		return Response.json(restTimeline(out.data.user.result.timeline.timeline, m[1], true));
	} catch (e) {
		return failure(e);
	}
}

// Posting, liking and reposting as the v1.1 endpoints take them; each answers
// with the tweet it concerns.
export async function restStatusRoute(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	const m = /^\/1\.1\/(statuses\/(?:show|lookup|update|destroy|retweet|unretweet)|favorites\/(?:create|destroy))(?:\/(\d{1,19}))?\.json$/.exec(path);
	if (!m) return undefined;
	const op = m[1];
	const read = op === "statuses/show" || op === "statuses/lookup";
	if (method !== (read ? "GET" : "POST")) return undefined;
	const q = await params(req);
	const id = m[2] ?? q.get("id") ?? q.get("tweet_id") ?? "";
	try {
		if (op === "statuses/lookup") {
			const found = await Promise.all(id.split(",").filter((x) => /^\d{1,19}$/.test(x)).slice(0, 100).map((x) => status(viewer, x)));
			return Response.json(found.filter(Boolean));
		}
		if (op === "statuses/update") {
			const media = (q.get("media_ids") ?? "").split(",").filter(Boolean).map((media_id) => ({ media_id, tagged_users: [] }));
			const out: Obj = await callOperation("CreateTweet", viewer, {
				tweet_text: q.get("status") ?? "",
				...(q.get("in_reply_to_status_id") ? { reply: { in_reply_to_tweet_id: q.get("in_reply_to_status_id"), exclude_reply_user_ids: [] } } : {}),
				...(q.get("attachment_url") ? { attachment_url: q.get("attachment_url") } : {}),
				media: { media_entities: media, possibly_sensitive: truthy(q.get("possibly_sensitive")) },
			});
			return Response.json(restStatus(out.data.create_tweet.tweet_results.result));
		}
		if (!/^\d{1,19}$/.test(id)) return gone("No status found with that ID.", 144, 404);
		let shown = id;
		if (op === "statuses/destroy") {
			const before = await status(viewer, id);
			await callOperation("DeleteTweet", viewer, { tweet_id: id });
			return before ? Response.json(before) : gone("No status found with that ID.", 144, 404);
		}
		if (op === "statuses/retweet") {
			const out: Obj = await callOperation("CreateRetweet", viewer, { tweet_id: id });
			shown = out.data.create_retweet.retweet_results.result.rest_id;
		}
		if (op === "statuses/unretweet") await callOperation("DeleteRetweet", viewer, { source_tweet_id: id });
		if (op === "favorites/create") await callOperation("FavoriteTweet", viewer, { tweet_id: id });
		if (op === "favorites/destroy") await callOperation("UnfavoriteTweet", viewer, { tweet_id: id });
		const out = await status(viewer, shown);
		return out ? Response.json(out) : gone("No status found with that ID.", 144, 404);
	} catch (e) {
		return failure(e);
	}
}

// `latest`: the chronological timeline ("Latest Tweets"), else the ranked one
export async function homeTimeline(viewer: Viewer, query: URLSearchParams, latest: boolean): Promise<Response> {
	const count = Number(query.get("count"));
	const cursor = query.get("cursor") ?? undefined;
	try {
		const out = await callOperation(latest ? "HomeLatestTimeline" : "HomeTimeline", viewer, { ...(count > 0 ? { count } : {}), ...(cursor ? { cursor } : {}) });
		return Response.json(restTimeline((out as Obj).data.home.home_timeline_urt));
	} catch (e) {
		if (e instanceof PostError) return Response.json({ errors: [{ code: e.code, message: e.message }] }, { status: 400 });
		throw e;
	}
}

const emptyObjects = () => ({ tweets: {}, users: {}, notifications: {}, moments: {}, cards: {}, places: {}, media: {}, broadcasts: {}, topics: {}, lists: {} });
const emptyTimeline = (id: string) => ({ globalObjects: emptyObjects(), timeline: { id, instructions: [] } });

// What the same clients read when they start, answered as nothing to show: they
// stop on a missing timeline before drawing the home page. Notifications, trends
// and messages go through GraphQL for the later clients; these builds see them empty.
export function bootEndpoint(path: string): Response | undefined {
	if (path === "/2/notifications/all.json" || path === "/2/notifications/mentions.json") return Response.json(emptyTimeline("notifications"));
	if (path === "/2/guide.json" || path === "/2/trends/guide.json") return Response.json(emptyTimeline("guide"));
	if (path === "/2/badge_count/badge_count.json") return Response.json({ ntab_unread_count: 0, dm_unread_count: 0, total_unread_count: 0 });
	if (path === "/1.1/dm/inbox_initial_state.json")
		return Response.json({
			inbox_initial_state: {
				last_seen_event_id: "0",
				trusted_last_seen_event_id: "0",
				untrusted_last_seen_event_id: "0",
				cursor: "0",
				inbox_timelines: { trusted: { status: "AT_END", min_entry_id: "0" }, untrusted: { status: "AT_END", min_entry_id: "0" } },
				entries: [],
				users: {},
				conversations: {},
			},
		});
}
