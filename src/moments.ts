// Twitter Moments: curated collections of posts.
// The 2019-2022 web clients fetch user moments from /2/moments/list_user_moments.json,
// open a capsule from /2/moments/capsule/:id.json, and send creation and edits to
// /i/moments/edit/:id. Builds without the Moments viewer chunk open a native capsule
// page at /i/moments/:id.

import { accountPage, esc } from "./account-page";
import { parseCookies, type Viewer } from "./auth";
import { blockedFor, protectedFor, suspendedFor } from "./blocks";
import { loadBuild } from "./build";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { isId, newId } from "./ids";
import { mediaUrl, posterUrl } from "./media";
import { type PostRow, legacyUser, tweetResult } from "./model";
import { forbiddenText } from "./names";
import { PostError, getPost, postsByIds, refuseHate, visiblePostMedia } from "./posts";
import { restStatus, restUser } from "./rest-timeline";
import { hasBlockedPhrase, settings } from "./settings";
import { staffViewer } from "./staff-access";
import { cleanText, oneLine } from "./text-clean";
import { userById, userByName, usersByIds } from "./users";

type Obj = Record<string, any>;
export type MomentVisibility = "private" | "public" | "unlisted";

export type MomentRow = {
	id: string;
	user_id: string;
	title: string;
	description: string;
	category: string;
	visibility: MomentVisibility;
	cover_post_id: string | null;
	cover_media_id: string | null;
	published_at: Date | null;
	created_at: Date;
	updated_at: Date;
	total_likes: number;
	is_liked: boolean;
	is_subscribed: boolean;
};

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 500;
const MAX_CATEGORY = 40;
const MAX_MOMENTS = 200;
const MAX_ITEMS = 100;
const VISIBILITIES = new Set<MomentVisibility>(["private", "public", "unlisted"]);

const NOT_FOUND = () => new PostError("Sorry, that page does not exist.", 34);
const SUSPENDED = sql`(select id from users where status = 'suspended' or instance_blocked)`;
const blockedBy = (viewerId: string) => sql`(select blocker_id from blocks where blocked_id = ${viewerId}::bigint)`;

const emptyObjects = () => ({ tweets: {}, users: {}, notifications: {}, moments: {}, cards: {}, places: {}, media: {}, broadcasts: {}, topics: {}, lists: {} });

const momentSelect = (viewerId: string) => sql`
	select m.id::text, m.user_id::text, m.title, m.description, m.category, m.visibility,
		m.cover_post_id::text, m.cover_media_id::text, m.published_at, m.created_at, m.updated_at,
		(select count(*)::int from moment_likes l where l.moment_id = m.id and l.user_id not in ${SUSPENDED}) as total_likes,
		exists (select 1 from moment_likes l where l.moment_id = m.id and l.user_id = ${viewerId}::bigint) as is_liked,
		exists (select 1 from moment_subscriptions s where s.moment_id = m.id and s.user_id = ${viewerId}::bigint) as is_subscribed
	from moments m`;

// Who may view a moment: the owner (or staff) sees everything; others see
// published moments ("public" in lists and capsules, "unlisted" by direct link)
// unless the author blocked them, is suspended, or is protected and not followed.
const momentAuthorVisible = (viewerId: string) => sql`
	(m.user_id = ${viewerId}::bigint or ${staffViewer(viewerId)} or (
		m.user_id not in ${blockedBy(viewerId)}
		and m.user_id not in ${suspendedFor(viewerId)}
		and m.user_id not in ${protectedFor(viewerId)}
	))`;

const momentReadable = (viewerId: string, inList = false) => sql`
	${momentAuthorVisible(viewerId)}
	and (m.user_id = ${viewerId}::bigint or ${staffViewer(viewerId)} or ${inList ? sql`m.visibility = 'public'` : sql`m.visibility in ('public', 'unlisted')`})`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function momentTimeString(d: Date): string {
	return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// Collects a PostRow into URT globalObjects.tweets and globalObjects.users, as rest-timeline.ts does.
function collectPost(post: PostRow, tweets: Obj, users: Obj): string | undefined {
	const result = tweetResult(post, true) as Obj;
	const collect = (r: Obj | undefined): string | undefined => {
		const tweet = r?.__typename === "TweetWithVisibilityResults" ? r.tweet : r;
		if (!tweet?.legacy || !tweet.rest_id) return undefined;
		const author = tweet.core?.user_results?.result;
		if (author?.rest_id) users[author.rest_id] = restUser(author);
		const legacy: Obj = { ...tweet.legacy, id_str: tweet.rest_id };
		const repost = legacy.retweeted_status_result?.result;
		delete legacy.retweeted_status_result;
		const reposted = collect(repost);
		if (reposted) legacy.retweeted_status_id_str = reposted;
		const quoted = collect(tweet.quoted_status_result?.result);
		if (quoted) legacy.quoted_status_id_str = quoted;
		if (tweet.views?.count) legacy.ext_views = { count: tweet.views.count, state: tweet.views.state };
		tweets[tweet.rest_id] = legacy;
		return tweet.rest_id;
	};
	return collect(result);
}

// Builds the moment entity expected by normalizr (`hlO3` in 2019, `36364` in 2022) and the Moments Redux store.
function momentObject(row: MomentRow, author: Obj | undefined, coverPost: PostRow | undefined, opts?: { keepEmptyTitle?: boolean }): Obj {
	const title = opts?.keepEmptyTitle ? row.title.trim() : row.title.trim() || "Untitled";
	const description = row.description || "";
	const publishDate = row.published_at ?? row.updated_at ?? row.created_at;
	const mediaList = coverPost?.media ?? [];
	const chosenMedia = (row.cover_media_id ? mediaList.find((m) => m.id === row.cover_media_id) : undefined) ?? mediaList[0];
	const coverMedia =
		coverPost && chosenMedia
			? {
					tweet_id: coverPost.id,
					type: chosenMedia.kind === "gif" ? "animated_gif" : chosenMedia.kind,
					media: {
						media_id: chosenMedia.id,
						url: chosenMedia.kind === "video" ? posterUrl(chosenMedia.id) : mediaUrl(chosenMedia.id, chosenMedia.mime),
						size: { w: chosenMedia.width || 1200, h: chosenMedia.height || 675 },
					},
					render: {
						crops: {
							square: { x: 0, y: 0, w: chosenMedia.width || 1200, h: chosenMedia.height || 675 },
							portrait_9_16: { x: 0, y: 0, w: chosenMedia.width || 1200, h: chosenMedia.height || 675 },
							portrait_3_4: { x: 0, y: 0, w: chosenMedia.width || 1200, h: chosenMedia.height || 675 },
							landscape_16_9: { x: 0, y: 0, w: chosenMedia.width || 1200, h: chosenMedia.height || 675 },
						},
					},
				}
			: undefined;
	return {
		id: row.id,
		id_str: row.id,
		title,
		description,
		is_live: false,
		sensitive: Boolean(coverPost?.sensitive),
		subcategory_string: row.category || (row.visibility === "private" ? "Draft" : "Moment"),
		time_string: momentTimeString(new Date(publishDate)),
		...(row.published_at ? { last_publish_time: new Date(row.published_at).toISOString() } : {}),
		duration_string: "",
		can_subscribe: true,
		is_subscribed: Boolean(row.is_subscribed),
		is_liked: Boolean(row.is_liked),
		total_likes: Number(row.total_likes) || 0,
		visibility_mode: row.visibility,
		has_unpublished_changes: row.visibility === "private",
		curation_metadata: {
			visibility_mode: row.visibility,
			is_production_only: false,
			nsfw: false,
		},
		url: `${PUBLIC_ORIGIN}/i/moments/${row.id}`,
		...(author ? { author: { id: row.user_id, id_str: row.user_id }, users: { [row.user_id]: author } } : {}),
		...(coverMedia ? { cover_media: coverMedia } : {}),
	};
}

export async function getMoment(viewerId: string, id: string, inList = false): Promise<MomentRow | undefined> {
	if (!isId(id)) return undefined;
	const [row] = await sql`${momentSelect(viewerId)} where m.id = ${id}::bigint and ${momentReadable(viewerId, inList)}`;
	return row as MomentRow | undefined;
}

export const MOMENT_CARD_NAME = "3260518932:moment";

export function momentLinkId(url: string): string | undefined {
	const link = new URL(url);
	if (link.origin !== PUBLIC_ORIGIN || link.username || link.password) return;
	const id = /^\/i\/(?:moments|events)\/(\d{1,19})\/?$/.exec(link.pathname)?.[1];
	if (isId(id)) return id;
}

export async function momentCardsFor(viewerId: string, ids: string[]) {
	if (!ids.length) return new Map<string, Obj>();
	const rows = await sql`select m.id::text, m.user_id::text, m.title, m.category, m.cover_post_id::text, m.cover_media_id::text
		from moments m where m.id = any(${sql.array(ids, "INT8")}) and m.visibility in ('public', 'unlisted') and ${momentReadable(viewerId)}` as
		Pick<MomentRow, "id" | "user_id" | "title" | "category" | "cover_post_id" | "cover_media_id">[];
	if (!rows.length) return new Map<string, Obj>();
	const [authors, media] = await Promise.all([
		usersByIds(viewerId, [...new Set(rows.map((row) => row.user_id))]),
		visiblePostMedia(viewerId, [...new Set(rows.flatMap((row) => row.cover_post_id ? [row.cover_post_id] : []))]),
	]);
	const str = (string_value: string) => ({ type: "STRING", string_value });
	return new Map<string, Obj>(rows.map((row) => {
		const url = `${PUBLIC_ORIGIN}/i/moments/${row.id}`;
		const cover = media.get(row.cover_post_id ?? "") ?? [];
		const image = cover.find((m) => m.id === row.cover_media_id) ?? cover[0];
		const author = authors.get(row.user_id);
		const values = {
			id: str(row.id),
			title: str(row.title.trim() || "Untitled"),
			url: str(url),
			card_url: str(url),
			subcategory_string: str(row.category || "Moment"),
			...(author ? { author: { type: "USER", user_value: { id_str: row.user_id } } } : {}),
			...(image ? { photo_image: { type: "IMAGE", image_value: {
				url: image.kind === "video" ? posterUrl(image.id) : mediaUrl(image.id, image.mime),
				width: image.width || 1200,
				height: image.height || 675,
			} } } : {}),
		};
		return [row.id, { rest_id: url, legacy: {
			name: MOMENT_CARD_NAME,
			url,
			binding_values: Object.entries(values).map(([key, value]) => ({ key, value })),
			...(author ? { users: { [row.user_id]: legacyUser(author) } } : {}),
			user_refs_results: [],
		} }];
	}));
}

async function requireOwnMoment(viewerId: string, id: string): Promise<MomentRow> {
	if (!isId(id)) throw NOT_FOUND();
	const [row] = await sql`${momentSelect(viewerId)} where m.id = ${id}::bigint`;
	if (!row) throw NOT_FOUND();
	if (row.user_id !== viewerId) throw new PostError("You can only edit your own Moments.", 403);
	return row as MomentRow;
}

async function checkMomentText(userId: string, title: string, description: string, category: string) {
	if ([...title].length > MAX_TITLE) throw new PostError(`Title is limited to ${MAX_TITLE} characters.`, 186);
	if ([...description].length > MAX_DESCRIPTION) throw new PostError(`Description is limited to ${MAX_DESCRIPTION} characters.`, 186);
	if ([...category].length > MAX_CATEGORY) throw new PostError(`Category is limited to ${MAX_CATEGORY} characters.`, 186);
	for (const text of [title, description, category]) {
		if (!text) continue;
		await refuseHate(userId, text, "post");
		if (forbiddenText(text) || hasBlockedPhrase(text)) throw new PostError("Your Moment contains a word or phrase this instance doesn't allow.", 186);
	}
}

async function resolveCover(viewerId: string, row: MomentRow, itemPosts?: PostRow[]): Promise<PostRow | undefined> {
	if (row.cover_post_id) {
		const found = itemPosts?.find((p) => p.id === row.cover_post_id) ?? (await getPost(viewerId, row.cover_post_id));
		if (found?.media?.length) return found;
	}
	if (itemPosts) return itemPosts.find((p) => p.media?.length);
	const items = await sql`select post_id::text from moment_items where moment_id = ${row.id}::bigint order by position asc, added_at asc limit 20`;
	if (!items.length) return undefined;
	const posts = await postsByIds(viewerId, items.map((r: any) => r.post_id), false, { views: false });
	for (const r of items) {
		const p = posts.get(r.post_id);
		if (p?.media?.length) return p;
	}
	return undefined;
}

async function hydrateMomentEntity(viewerId: string, row: MomentRow, tweets: Obj, users: Obj, itemPosts?: PostRow[], opts?: { keepEmptyTitle?: boolean }): Promise<Obj> {
	const authorUser = await userById(viewerId, row.user_id);
	const author = authorUser ? { id: authorUser.id, ...legacyUser(authorUser) } : undefined;
	if (author) users[row.user_id] = author;
	const coverPost = await resolveCover(viewerId, row, itemPosts);
	if (coverPost) collectPost(coverPost, tweets, users);
	return momentObject(row, author, coverPost, opts);
}

// POST /1.1/moments/create.json
export async function createMoment(viewer: Viewer, input: { title?: string; description?: string; category?: string; visibility?: string; tweet_ids?: string[] } = {}): Promise<Obj> {
	const [count] = await sql`select count(*)::int as n from moments where user_id = ${viewer.id}::bigint`;
	if ((count?.n ?? 0) >= MAX_MOMENTS) throw new PostError(`You can create up to ${MAX_MOMENTS} Moments.`, 214);
	const title = oneLine(input.title ?? "").trim();
	const description = cleanText(input.description ?? "", { lines: 8 }).trim();
	const category = oneLine(input.category ?? "").trim();
	const visibility: MomentVisibility = VISIBILITIES.has(input.visibility as MomentVisibility) ? (input.visibility as MomentVisibility) : "private";
	await checkMomentText(viewer.id, title, description, category);
	const id = newId();
	const publishedAt = visibility !== "private" ? new Date() : null;
	await sql`insert into moments (id, user_id, title, description, category, visibility, published_at)
		values (${id}::bigint, ${viewer.id}::bigint, ${title}, ${description}, ${category}, ${visibility}, ${publishedAt})`;
	if (Array.isArray(input.tweet_ids)) {
		for (const tid of input.tweet_ids.filter(isId).slice(0, MAX_ITEMS)) await addMomentPost(viewer, id, tid).catch(() => {});
	}
	const row = (await getMoment(viewer.id, id))!;
	const tweets: Obj = {};
	const users: Obj = {};
	const moment = await hydrateMomentEntity(viewer.id, row, tweets, users);
	return { created_moment: { moment } };
}

// POST /1.1/moments/delete/:id.json
export async function deleteMoment(viewer: Viewer, id: string): Promise<Obj> {
	const row = await requireOwnMoment(viewer.id, id);
	await sql`delete from moments where id = ${row.id}::bigint and user_id = ${viewer.id}::bigint`;
	return { id: row.id, deleted: true };
}

// POST /1.1/moments/update.json
export async function updateMoment(
	viewer: Viewer,
	id: string,
	changes: { title?: string; description?: string; category?: string; visibility?: string; cover_post_id?: string | null; cover_media_id?: string | null },
): Promise<MomentRow> {
	const row = await requireOwnMoment(viewer.id, id);
	const title = changes.title !== undefined ? oneLine(changes.title).trim() : row.title;
	const description = changes.description !== undefined ? cleanText(changes.description, { lines: 8 }).trim() : row.description;
	const category = changes.category !== undefined ? oneLine(changes.category).trim() : row.category;
	const visibility: MomentVisibility = changes.visibility && VISIBILITIES.has(changes.visibility as MomentVisibility) ? (changes.visibility as MomentVisibility) : row.visibility;
	await checkMomentText(viewer.id, title, description, category);

	let coverPostId = changes.cover_post_id === undefined ? row.cover_post_id : changes.cover_post_id;
	let coverMediaId = changes.cover_media_id === undefined ? row.cover_media_id : changes.cover_media_id;
	if (coverPostId) {
		if (!isId(coverPostId)) coverPostId = null;
		else {
			const post = await getPost(viewer.id, coverPostId);
			if (!post?.media?.length) {
				coverPostId = null;
				coverMediaId = null;
			} else if (!coverMediaId || !post.media.some((m) => m.id === coverMediaId)) {
				coverMediaId = post.media[0]!.id;
			}
		}
	} else {
		coverMediaId = null;
	}

	const publishedAt = visibility !== "private" ? (row.published_at ?? new Date()) : row.published_at;
	await sql`update moments set
		title = ${title},
		description = ${description},
		category = ${category},
		visibility = ${visibility},
		cover_post_id = ${coverPostId}::bigint,
		cover_media_id = ${coverMediaId}::bigint,
		published_at = ${publishedAt},
		updated_at = now()
		where id = ${row.id}::bigint and user_id = ${viewer.id}::bigint`;
	return (await getMoment(viewer.id, row.id))!;
}

// Extracts a post snowflake ID from a raw ID or a status URL (/name/status/12345).
export function extractPostId(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (isId(trimmed)) return trimmed;
	const match = /\/status(?:es)?\/(\d{1,19})\b/.exec(trimmed) ?? /\b(\d{10,19})\b/.exec(trimmed);
	return match?.[1] && isId(match[1]) ? match[1] : undefined;
}

export async function addMomentPost(viewer: Viewer, momentId: string, postRef: string): Promise<PostRow> {
	const row = await requireOwnMoment(viewer.id, momentId);
	const postId = extractPostId(postRef);
	if (!postId) throw new PostError("Enter a valid post ID or post link.", 144);
	const post = await getPost(viewer.id, postId);
	if (!post) throw new PostError("No post found with that ID or you don't have access to it.", 144);
	const [count] = await sql`select count(*)::int as n, coalesce(max(position), -1)::int as max_pos from moment_items where moment_id = ${row.id}::bigint`;
	if ((count?.n ?? 0) >= MAX_ITEMS) throw new PostError(`A Moment can hold up to ${MAX_ITEMS} posts.`, 214);
	const nextPos = (count?.max_pos ?? -1) + 1;
	await sql`insert into moment_items (moment_id, post_id, position)
		values (${row.id}::bigint, ${post.id}::bigint, ${nextPos})
		on conflict (moment_id, post_id) do nothing`;
	// Auto-select the first media post as cover if the moment doesn't have one yet
	if (!row.cover_post_id && post.media?.length) {
		await sql`update moments set cover_post_id = ${post.id}::bigint, cover_media_id = ${post.media[0]!.id}::bigint, updated_at = now()
			where id = ${row.id}::bigint and cover_post_id is null`;
	} else {
		await sql`update moments set updated_at = now() where id = ${row.id}::bigint`;
	}
	return post;
}

export async function removeMomentPost(viewer: Viewer, momentId: string, postId: string): Promise<void> {
	const row = await requireOwnMoment(viewer.id, momentId);
	if (!isId(postId)) return;
	await sql`delete from moment_items where moment_id = ${row.id}::bigint and post_id = ${postId}::bigint`;
	if (row.cover_post_id === postId) {
		await sql`update moments set cover_post_id = null, cover_media_id = null, updated_at = now() where id = ${row.id}::bigint`;
	} else {
		await sql`update moments set updated_at = now() where id = ${row.id}::bigint`;
	}
}

export async function moveMomentPost(viewer: Viewer, momentId: string, postId: string, direction: "up" | "down"): Promise<void> {
	const row = await requireOwnMoment(viewer.id, momentId);
	if (!isId(postId)) return;
	const items = (await sql`select post_id::text from moment_items where moment_id = ${row.id}::bigint order by position asc, added_at asc`) as { post_id: string }[];
	const idx = items.findIndex((i) => i.post_id === postId);
	if (idx < 0) return;
	const swapIdx = direction === "up" ? idx - 1 : idx + 1;
	if (swapIdx < 0 || swapIdx >= items.length) return;
	[items[idx], items[swapIdx]] = [items[swapIdx]!, items[idx]!];
	await sql.begin(async (tx) => {
		for (let i = 0; i < items.length; i++) {
			await tx`update moment_items set position = ${i} where moment_id = ${row.id}::bigint and post_id = ${items[i]!.post_id}::bigint`;
		}
		await tx`update moments set updated_at = now() where id = ${row.id}::bigint`;
	});
}

export async function reorderMomentPosts(viewer: Viewer, momentId: string, postIds: string[]): Promise<void> {
	const row = await requireOwnMoment(viewer.id, momentId);
	const current = (await sql`select post_id::text from moment_items where moment_id = ${row.id}::bigint order by position asc, added_at asc`).map((r: any) => r.post_id as string);
	const valid = postIds.filter((id) => current.includes(id));
	const rest = current.filter((id) => !valid.includes(id));
	const ordered = [...valid, ...rest];
	await sql.begin(async (tx) => {
		for (let i = 0; i < ordered.length; i++) {
			await tx`update moment_items set position = ${i} where moment_id = ${row.id}::bigint and post_id = ${ordered[i]!}::bigint`;
		}
		await tx`update moments set updated_at = now() where id = ${row.id}::bigint`;
	});
}

// POST /1.1/moments/like.json & /1.1/moments/unlike.json
export async function setMomentLike(viewer: Viewer, momentId: string, liked: boolean): Promise<Obj> {
	const row = await getMoment(viewer.id, momentId, false);
	if (!row) throw NOT_FOUND();
	if (liked) await sql`insert into moment_likes (moment_id, user_id) values (${row.id}::bigint, ${viewer.id}::bigint) on conflict do nothing`;
	else await sql`delete from moment_likes where moment_id = ${row.id}::bigint and user_id = ${viewer.id}::bigint`;
	const updated = (await getMoment(viewer.id, row.id, false))!;
	const tweets: Obj = {};
	const users: Obj = {};
	const moment = await hydrateMomentEntity(viewer.id, updated, tweets, users);
	return { moment };
}

// POST /1.1/moments/subscribe.json & /1.1/moments/unsubscribe.json
export async function setMomentSubscription(viewer: Viewer, momentIdsRaw: string, subscribed: boolean): Promise<Obj> {
	const ids = momentIdsRaw.split(",").map((s) => s.trim()).filter(isId).slice(0, 50);
	if (!ids.length) throw NOT_FOUND();
	const out: Obj[] = [];
	for (const id of ids) {
		const row = await getMoment(viewer.id, id, false);
		if (!row) continue;
		if (subscribed) await sql`insert into moment_subscriptions (moment_id, user_id) values (${row.id}::bigint, ${viewer.id}::bigint) on conflict do nothing`;
		else await sql`delete from moment_subscriptions where moment_id = ${row.id}::bigint and user_id = ${viewer.id}::bigint`;
		const updated = (await getMoment(viewer.id, row.id, false))!;
		const tweets: Obj = {};
		const users: Obj = {};
		out.push(await hydrateMomentEntity(viewer.id, updated, tweets, users));
	}
	if (!out.length) throw NOT_FOUND();
	return { moments: out, moment: out[0] };
}

// GET /2/moments/list_user_moments.json
export async function userMomentsTimeline(viewer: Viewer, q: URLSearchParams): Promise<Obj> {
	const targetId = q.get("userId") ?? q.get("user_id") ?? viewer.id;
	if (!isId(targetId)) return { globalObjects: emptyObjects(), timeline: { id: `user-moments-${targetId}`, instructions: [{ addEntries: { entries: [] } }] } };
	const targetUser = await userById(viewer.id, targetId);
	if (!targetUser) return { globalObjects: emptyObjects(), timeline: { id: `user-moments-${targetId}`, instructions: [{ addEntries: { entries: [] } }] } };

	const rows = (await sql`${momentSelect(viewer.id)}
		where m.user_id = ${targetId}::bigint and ${momentReadable(viewer.id, true)}
		order by m.id desc limit 100`) as MomentRow[];

	const tweets: Obj = {};
	const users: Obj = {};
	const moments: Obj = {};
	users[targetUser.id] = { id: targetUser.id, ...legacyUser(targetUser) };

	const entries: Obj[] = [];
	const base = BigInt(Date.now()) * 1000n;
	for (const [i, row] of rows.entries()) {
		moments[row.id] = await hydrateMomentEntity(viewer.id, row, tweets, users);
		entries.push({
			entryId: `moment-${row.id}`,
			sortIndex: (base - BigInt(i)).toString(),
			content: {
				item: {
					content: {
						moment: {
							momentId: row.id,
							displayType: "Default",
						},
					},
				},
			},
		});
	}

	return {
		globalObjects: { ...emptyObjects(), tweets, users, moments },
		timeline: {
			id: `user-moments-${targetId}`,
			instructions: [{ addEntries: { entries } }],
		},
	};
}

export async function momentPosts(viewerId: string, momentId: string): Promise<PostRow[]> {
	const items = (await sql`select post_id::text from moment_items where moment_id = ${momentId}::bigint order by position asc, added_at asc`) as { post_id: string }[];
	if (!items.length) return [];
	const byId = await postsByIds(viewerId, items.map((r) => r.post_id));
	return items.flatMap((r) => (byId.has(r.post_id) ? [byId.get(r.post_id)!] : []));
}

// GET /2/moments/capsule/:id.json
export async function momentCapsuleTimeline(viewer: Viewer, momentId: string): Promise<Obj> {
	const row = await getMoment(viewer.id, momentId, false);
	if (!row) return { globalObjects: emptyObjects(), timeline: { id: `moment-${momentId}`, instructions: [{ addEntries: { entries: [] } }] } };

	const posts = await momentPosts(viewer.id, row.id);
	const tweets: Obj = {};
	const users: Obj = {};
	const moments: Obj = {};

	moments[row.id] = await hydrateMomentEntity(viewer.id, row, tweets, users, posts);

	const entries: Obj[] = [];
	const base = BigInt(Date.now()) * 1000n;
	let idx = 0n;

	entries.push({
		entryId: `moment-capsule-header-${row.id}`,
		sortIndex: (base - idx++).toString(),
		content: {
			item: {
				content: {
					momentCapsuleHeader: {
						momentId: row.id,
					},
				},
			},
		},
	});

	for (const post of posts) {
		const tid = collectPost(post, tweets, users);
		if (!tid) continue;
		entries.push({
			entryId: `tweet-${tid}`,
			sortIndex: (base - idx++).toString(),
			content: {
				item: {
					content: {
						tweet: {
							id: tid,
							displayType: "Tweet",
						},
					},
				},
			},
		});
	}

	entries.push({
		entryId: `moment-capsule-footer-${row.id}`,
		sortIndex: (base - idx++).toString(),
		content: {
			item: {
				content: {
					momentCapsuleFooter: {
						momentId: row.id,
					},
				},
			},
		},
	});

	return {
		globalObjects: { ...emptyObjects(), tweets, users, moments },
		timeline: {
			id: `moment-${row.id}`,
			instructions: [{ addEntries: { entries } }],
		},
	};
}

// GET /2/moments/userlikes.json?moment_id=:id
export async function momentLikersTimeline(viewer: Viewer, q: URLSearchParams): Promise<Obj> {
	const momentId = q.get("moment_id") ?? q.get("id") ?? "";
	const row = await getMoment(viewer.id, momentId, false);
	if (!row) return { globalObjects: emptyObjects(), timeline: { id: `moment-likes-${momentId}`, instructions: [{ addEntries: { entries: [] } }] } };

	const likerRows = (await sql`select l.user_id::text as id from moment_likes l
		where l.moment_id = ${row.id}::bigint
			and l.user_id not in ${blockedFor(viewer.id)}
			and l.user_id not in ${suspendedFor(viewer.id)}
		order by l.created_at desc limit 100`) as { id: string }[];
	const userMap = await usersByIds(viewer.id, likerRows.map((r) => r.id));
	const users: Obj = {};
	const entries: Obj[] = [];
	const base = BigInt(Date.now()) * 1000n;
	for (const [i, r] of likerRows.entries()) {
		const u = userMap.get(r.id);
		if (!u) continue;
		users[u.id] = { id: u.id, ...legacyUser(u) };
		entries.push({
			entryId: `user-${u.id}`,
			sortIndex: (base - BigInt(i)).toString(),
			content: {
				item: {
					content: {
						user: {
							id: u.id,
							displayType: "User",
						},
					},
				},
			},
		});
	}
	return {
		globalObjects: { ...emptyObjects(), users },
		timeline: {
			id: `moment-likes-${row.id}`,
			instructions: [{ addEntries: { entries } }],
		},
	};
}

// GET /1.1/moments/capsule/:id.json (2022-11 Moment Maker `fetchMoment`)
export async function momentCapsuleV1(viewer: Viewer, momentId: string): Promise<Obj> {
	const row = await getMoment(viewer.id, momentId, false);
	if (!row) throw NOT_FOUND();
	const posts = await momentPosts(viewer.id, row.id);
	const authorUser = await userById(viewer.id, row.user_id);
	const author = authorUser ? { id: authorUser.id, ...legacyUser(authorUser) } : undefined;
	const coverPost = await resolveCover(viewer.id, row, posts);

	const tweets: Obj = {};
	for (const post of posts) {
		const s = restStatus(tweetResult(post, true) as Obj);
		if (s) tweets[post.id] = s;
	}
	if (coverPost && !tweets[coverPost.id]) {
		const s = restStatus(tweetResult(coverPost, true) as Obj);
		if (s) tweets[coverPost.id] = s;
	}

	const pages = posts.map((post) => ({
		page_id: `tweet-${post.id}`,
		tweet_id: post.id,
		type: "tweet",
		render: { theme: { bg_color: "FFFFFF", fg_color: "000000" } },
	}));

	const moment = momentObject(row, author, coverPost, { keepEmptyTitle: true });
	return { moment, pages, tweets };
}

// POST /1.1/moments/update/:id.json (2022-11 Moment Maker `updateMetadata`, raw JSON body)
export async function updateMomentV1(viewer: Viewer, id: string, body: Obj): Promise<Obj> {
	const changes: Parameters<typeof updateMoment>[2] = {};
	if (typeof body.title === "string") changes.title = body.title;
	if (typeof body.description === "string") changes.description = body.description;
	if (typeof body.category === "string") changes.category = body.category;
	const vis = body.visibility_mode ?? body.visibility;
	if (typeof vis === "string") changes.visibility = vis;
	if (body.cover === null) {
		changes.cover_post_id = null;
		changes.cover_media_id = null;
	} else if (body.cover && typeof body.cover === "object") {
		if (typeof body.cover.tweet_id === "string" || typeof body.cover.tweet_id === "number") {
			changes.cover_post_id = String(body.cover.tweet_id);
		}
		const mid = body.cover.media_data?.media_id ?? body.cover.media_id;
		if (typeof mid === "string" || typeof mid === "number") {
			changes.cover_media_id = String(mid);
		}
	}
	const updated = await updateMoment(viewer, id, changes);
	const tweets: Obj = {};
	const users: Obj = {};
	const moment = await hydrateMomentEntity(viewer.id, updated, tweets, users, undefined, { keepEmptyTitle: true });
	return { updated_moment: { moment } };
}

// POST /1.1/moments/curate/:id.json (2022-11 Moment Maker `curateTimeline`, raw JSON body)
export async function curateMomentTimeline(viewer: Viewer, id: string, body: Obj): Promise<Obj> {
	const row = await requireOwnMoment(viewer.id, id);
	const actions = Array.isArray(body.actions) ? body.actions : [];
	let ordered = (await sql`select post_id::text from moment_items where moment_id = ${row.id}::bigint order by position asc, added_at asc`).map((r: any) => r.post_id as string);
	const deletedIds = new Set<string>();
	let firstAddedMediaPost: PostRow | undefined;

	for (const a of actions) {
		if (!a || typeof a !== "object") continue;
		const action = String(a.action ?? "").toUpperCase();
		const rawTweetId = typeof a.tweet_id === "string" || typeof a.tweet_id === "number" ? String(a.tweet_id) : "";
		const relTo = typeof a.relative_to === "string" || typeof a.relative_to === "number" ? String(a.relative_to) : undefined;
		const above = Boolean(a.above);

		if (action === "ADD") {
			const tid = extractPostId(rawTweetId);
			if (!tid) throw new PostError("Enter a valid post ID or post link.", 144);
			const post = await getPost(viewer.id, tid);
			if (!post) throw new PostError("No post found with that ID or you don't have access to it.", 144);
			ordered = ordered.filter((x) => x !== post.id);
			if (ordered.length >= MAX_ITEMS) throw new PostError(`A Moment can hold up to ${MAX_ITEMS} posts.`, 214);
			if (relTo && ordered.includes(relTo)) {
				const idx = ordered.indexOf(relTo);
				ordered.splice(above ? idx : idx + 1, 0, post.id);
			} else if (above) {
				ordered.unshift(post.id);
			} else {
				ordered.push(post.id);
			}
			deletedIds.delete(post.id);
			if (!firstAddedMediaPost && post.media?.length) firstAddedMediaPost = post;
		} else if (action === "DELETE") {
			if (isId(rawTweetId)) {
				ordered = ordered.filter((x) => x !== rawTweetId);
				deletedIds.add(rawTweetId);
			}
		} else if (action === "MOVE") {
			if (isId(rawTweetId) && ordered.includes(rawTweetId)) {
				ordered = ordered.filter((x) => x !== rawTweetId);
				if (relTo && ordered.includes(relTo)) {
					const idx = ordered.indexOf(relTo);
					ordered.splice(above ? idx : idx + 1, 0, rawTweetId);
				} else if (above) {
					ordered.unshift(rawTweetId);
				} else {
					ordered.push(rawTweetId);
				}
			}
		}
	}

	await sql.begin(async (tx) => {
		if (ordered.length) {
			await tx`delete from moment_items where moment_id = ${row.id}::bigint and not (post_id = any(${sql.array(ordered, "INT8")}))`;
			for (let i = 0; i < ordered.length; i++) {
				await tx`insert into moment_items (moment_id, post_id, position)
					values (${row.id}::bigint, ${ordered[i]!}::bigint, ${i})
					on conflict (moment_id, post_id) do update set position = excluded.position`;
			}
		} else {
			await tx`delete from moment_items where moment_id = ${row.id}::bigint`;
		}
		if (row.cover_post_id && deletedIds.has(row.cover_post_id)) {
			await tx`update moments set cover_post_id = null, cover_media_id = null, updated_at = now() where id = ${row.id}::bigint`;
		} else if (!row.cover_post_id && firstAddedMediaPost?.media?.length) {
			await tx`update moments set cover_post_id = ${firstAddedMediaPost.id}::bigint, cover_media_id = ${firstAddedMediaPost.media[0]!.id}::bigint, updated_at = now()
				where id = ${row.id}::bigint and cover_post_id is null`;
		} else {
			await tx`update moments set updated_at = now() where id = ${row.id}::bigint`;
		}
	});

	const updated = (await getMoment(viewer.id, row.id))!;
	const tweets: Obj = {};
	const users: Obj = {};
	const moment = await hydrateMomentEntity(viewer.id, updated, tweets, users, undefined, { keepEmptyTitle: true });
	return { updated_moment: { moment } };
}

// POST /1.1/moments/publish/:id.json (2022-11 Moment Maker `publish`)
export async function publishMomentV1(viewer: Viewer, id: string): Promise<Obj> {
	const row = await requireOwnMoment(viewer.id, id);
	const nextVis: MomentVisibility = row.visibility === "private" ? "public" : row.visibility;
	await sql`update moments set visibility = ${nextVis}, published_at = now(), updated_at = now()
		where id = ${row.id}::bigint and user_id = ${viewer.id}::bigint`;
	const updated = (await getMoment(viewer.id, row.id))!;
	const tweets: Obj = {};
	const users: Obj = {};
	const moment = await hydrateMomentEntity(viewer.id, updated, tweets, users, undefined, { keepEmptyTitle: true });
	return { updated_moment: { moment } };
}

// POST /1.1/moments/curate_metadata/:id.json (2022-11 Moment Maker `curateTweetMetadata`)
export async function curateMetadataV1(viewer: Viewer, id: string): Promise<Obj> {
	const row = await requireOwnMoment(viewer.id, id);
	const tweets: Obj = {};
	const users: Obj = {};
	const moment = await hydrateMomentEntity(viewer.id, row, tweets, users, undefined, { keepEmptyTitle: true });
	return { updated_moment: { moment } };
}

// GET /1.1/live_event/1/:id/timeline.json (2022-11 Moment Preview `fetchLiveEventMetadata`)
export async function momentLiveEventMetadata(viewer: Viewer, momentId: string): Promise<Obj> {
	const row = await getMoment(viewer.id, momentId, false);
	if (!row) throw NOT_FOUND();
	const posts = await momentPosts(viewer.id, row.id);
	const authorUser = await userById(viewer.id, row.user_id);
	const coverPost = await resolveCover(viewer.id, row, posts);
	const tweets: Obj = {};
	const users: Obj = {};
	if (authorUser) users[authorUser.id] = { id: authorUser.id, ...legacyUser(authorUser) };
	if (coverPost) {
		const s = restStatus(tweetResult(coverPost, true) as Obj);
		if (s) tweets[coverPost.id] = s;
	}
	const mediaList = coverPost?.media ?? [];
	const chosen = (row.cover_media_id ? mediaList.find((m) => m.id === row.cover_media_id) : undefined) ?? mediaList[0];
	const publishDate = row.published_at ?? row.updated_at ?? row.created_at;
	const liveEvent: Obj = {
		id: row.id,
		id_str: row.id,
		title: row.title.trim() || "Untitled",
		description: row.description || "",
		category: row.category || "Moment",
		attribution_user_id: row.user_id,
		time_string: momentTimeString(new Date(publishDate)),
		sensitive: Boolean(coverPost?.sensitive),
		timelines: [{ timeline_id: "recap", title: "Recap" }],
		...(coverPost && chosen
			? {
					square_media_info: {
						url: chosen.kind === "video" ? posterUrl(chosen.id) : mediaUrl(chosen.id, chosen.mime),
						width: chosen.width || 1200,
						height: chosen.height || 675,
					},
				}
			: {}),
	};
	return {
		response: { live_event: { id: row.id }, timelines: { recap: { timeline_id: "recap" } } },
		twitter_objects: {
			audiospaces: {},
			broadcasts: {},
			live_events: { [row.id]: liveEvent },
			slates: {},
			tweets,
			users,
		},
	};
}

// GET /2/live_event/timeline/:id.json (2022-11 Moment Preview timeline)
export async function momentLiveEventTimeline(viewer: Viewer, momentId: string): Promise<Obj | undefined> {
	const row = await getMoment(viewer.id, momentId, false);
	if (!row) return undefined;
	const posts = await momentPosts(viewer.id, row.id);
	const tweets: Obj = {};
	const users: Obj = {};
	const entries: Obj[] = [];
	const base = BigInt(Date.now()) * 1000n;
	let idx = 0n;
	for (const post of posts) {
		const tid = collectPost(post, tweets, users);
		if (!tid) continue;
		entries.push({
			entryId: `tweet-${tid}`,
			sortIndex: (base - idx++).toString(),
			content: {
				item: {
					content: {
						tweet: {
							id: tid,
							displayType: "Tweet",
						},
					},
				},
			},
		});
	}
	return {
		globalObjects: { ...emptyObjects(), tweets, users },
		timeline: {
			id: `live-event-${row.id}`,
			instructions: [{ addEntries: { entries } }],
		},
	};
}

// Whether the currently active client build includes the native 2019-2022 `bundle.Moment` chunk.
export function clientHandlesMomentViewer(loaded = loadBuild()): boolean {
	return Boolean(loaded?.runtime.includes('"bundle.Moment"'));
}

// Candidate posts for the Moments Maker's 4-tab Tweet picker:
// likes, tweets by account (@handle), tweet search, or direct tweet link/ID.
async function candidatePosts(viewer: Viewer, tab: string, search: string, handle: string): Promise<PostRow[]> {
	let rows: { id: string }[] = [];
	if (tab === "link") {
		const extracted = extractPostId(search);
		if (!extracted) return [];
		const one = await getPost(viewer.id, extracted);
		return one ? [one] : [];
	}
	if (tab === "search") {
		if (search) {
			const extracted = extractPostId(search);
			if (extracted) {
				const one = await getPost(viewer.id, extracted);
				return one ? [one] : [];
			}
			const pattern = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
			rows = (await sql`select p.id::text from posts p
				where not p.hidden and p.text ilike ${pattern}
				order by p.id desc limit 30`) as { id: string }[];
		} else {
			rows = (await sql`select p.id::text from posts p
				where not p.hidden
				order by p.id desc limit 25`) as { id: string }[];
		}
	} else if (tab === "likes") {
		rows = (await sql`select l.post_id::text as id from likes l
			where l.user_id = ${viewer.id}::bigint
			order by l.created_at desc limit 30`) as { id: string }[];
	} else {
		const cleanHandle = handle.replace(/^@/, "").trim();
		const targetUser = cleanHandle && cleanHandle.toLowerCase() !== viewer.screen_name.toLowerCase() ? await userByName(viewer.id, cleanHandle) : undefined;
		if (cleanHandle && cleanHandle.toLowerCase() !== viewer.screen_name.toLowerCase() && !targetUser) return [];
		const targetId = targetUser?.id ?? viewer.id;
		rows = (await sql`select p.id::text from posts p
			where p.user_id = ${targetId}::bigint and not p.hidden
			order by p.id desc limit 30`) as { id: string }[];
	}
	const ids = rows.map((r) => r.id);
	const byId = await postsByIds(viewer.id, ids, false, { views: false });
	return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

const MOMENT_CSS = `
.moment-badge{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;background:var(--surface);color:var(--muted);border:1px solid var(--border)}
.moment-badge.live{background:rgb(0 186 124 / .12);color:var(--success);border-color:rgb(0 186 124 / .35)}
.moment-badge.draft{background:rgb(255 212 0 / .14);color:var(--text);border-color:rgb(255 212 0 / .4)}
.moment-cover{position:relative;border-radius:16px;overflow:hidden;background:var(--surface);border:1px solid var(--border)}
.moment-cover img,.moment-cover video{display:block;width:100%;max-height:320px;object-fit:cover}
.moment-post{border:1px solid var(--border);border-radius:16px;padding:12px 16px;display:grid;gap:8px;background:var(--bg)}
.moment-post-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.moment-author{display:flex;align-items:center;gap:8px;min-width:0;color:var(--text);font-weight:700}
.moment-author img{width:32px;height:32px;border-radius:50%;object-fit:cover;flex:none}
.moment-author span{color:var(--muted);font-weight:400;font-size:13px}
.moment-text{white-space:pre-wrap;font-size:15px;line-height:20px}
.moment-media{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-top:4px}
.moment-media img{width:100%;max-height:200px;object-fit:cover;border-radius:12px;border:1px solid var(--border)}
`;

function renderPostCard(p: PostRow, controls = ""): string {
	const avatar = p.author.avatar_url || "/abs/sticky/default_profile_images/default_profile_normal.png";
	const mediaHtml = p.media?.length
		? `<div class="moment-media">${p.media
				.map((m) => `<img src="${esc(m.kind === "photo" || m.kind === "gif" ? `/media/${m.id}` : `/media/poster/${m.id}.jpg`)}" alt="${esc(m.alt_text || "")}" loading="lazy">`)
				.join("")}</div>`
		: "";
	const date = new Date(p.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
	return `<article class="moment-post" data-post-id="${esc(p.id)}">
		<div class="moment-post-head">
			<a class="moment-author" href="/${esc(p.author.screen_name)}">
				<img src="${esc(avatar)}" alt="">
				<div>${esc(p.author.name || p.author.screen_name)} <span>@${esc(p.author.screen_name)} · ${esc(date)}</span></div>
			</a>
			${controls}
		</div>
		<div class="moment-text">${esc(p.text)}</div>
		${mediaHtml}
	</article>`;
}

const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

function serializeMakerPost(p: PostRow) {
	return {
		id: p.id,
		text: p.text,
		date: new Date(p.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
		author: {
			name: p.author.name || p.author.screen_name,
			screen_name: p.author.screen_name,
			avatar: p.author.avatar_url || "/abs/sticky/default_profile_images/default_profile_normal.png",
			verified: Boolean(p.author.verified_type),
		},
		media: (p.media ?? []).map((m) => ({
			id: m.id,
			kind: m.kind,
			thumb: m.kind === "video" ? `/media/poster/${m.id}.jpg` : `/media/${m.id}`,
			alt: m.alt_text || "",
		})),
	};
}

const MAKER_THEMES = {
	light: {
		page: "#e6ecf0",
		bg: "#ffffff",
		bar: "rgb(255 255 255 / .96)",
		surface: "#f5f8fa",
		text: "#14171a",
		muted: "#657786",
		border: "#e6ecf0",
		hover: "#f5f8fa",
		input: "#e6ecf0",
		scrim: "rgb(0 0 0 / .62)",
		shadow: "0 2px 12px rgb(0 0 0 / .12)",
		scheme: "light",
	},
	dim: {
		page: "#10171e",
		bg: "#15202b",
		bar: "rgb(21 32 43 / .96)",
		surface: "#192734",
		text: "#ffffff",
		muted: "#8899a6",
		border: "#38444d",
		hover: "#1c2c3c",
		input: "#253341",
		scrim: "rgb(0 0 0 / .72)",
		shadow: "0 4px 18px rgb(0 0 0 / .45)",
		scheme: "dark",
	},
	dark: {
		page: "#000000",
		bg: "#000000",
		bar: "rgb(0 0 0 / .92)",
		surface: "#15181c",
		text: "#d9d9d9",
		muted: "#6e767d",
		border: "#2f3336",
		hover: "#16181c",
		input: "#202327",
		scrim: "rgb(0 0 0 / .78)",
		shadow: "0 4px 18px rgb(255 255 255 / .12)",
		scheme: "dark",
	},
} as const;

const makerVars = (t: keyof typeof MAKER_THEMES) =>
	Object.entries(MAKER_THEMES[t])
		.map(([k, v]) => (k === "scheme" ? `color-scheme:${v}` : `--${k}:${v}`))
		.join(";");

const MAKER_CSS = `
:root{${makerVars("light")};--accent:#1da1f2;--accent-fill:var(--accent);--accent-hover:#1a91da;--accent-soft:rgb(29 161 242 / .12);--danger:#e0245e;--success:#17bf63}
@media (prefers-color-scheme:dark){:root:not([data-theme]){${makerVars("dark")}}}
:root[data-theme="dim"]{${makerVars("dim")}}
:root[data-theme="dark"]{${makerVars("dark")}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{margin:0;background:var(--page);color:var(--text);font:15px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-wrap:break-word}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
button,input,textarea{font:inherit;color:inherit}
button{cursor:pointer}
[hidden]{display:none!important}

/* Sticky 2019 Twitter Moments Maker top bar */
.mk-nav{position:sticky;top:0;z-index:30;background:var(--bar);border-bottom:1px solid var(--border);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.mk-nav-inner{max-width:1040px;margin:0 auto;height:56px;padding:0 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.mk-nav-left{display:flex;align-items:center;gap:10px;min-width:0}
.mk-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9999px;border:0;background:transparent;color:var(--muted);transition:background 140ms,color 140ms}
.mk-icon-btn:hover{background:var(--accent-soft);color:var(--accent);text-decoration:none}
.mk-icon-btn svg{width:20px;height:20px;fill:currentColor}
.mk-brand{display:flex;align-items:center;gap:7px;font-weight:800;font-size:18px;letter-spacing:-0.01em;color:var(--text)}
.mk-brand svg{width:22px;height:22px;fill:var(--accent);flex:none}
.mk-save-state{font-size:13px;color:var(--muted);padding-left:8px;border-left:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mk-save-state.saving{color:var(--accent)}
.mk-save-state.error{color:var(--danger);font-weight:600}
.mk-nav-right{display:flex;align-items:center;gap:8px;flex:none}
.mk-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 16px;border-radius:9999px;font-size:14px;font-weight:700;border:1px solid transparent;white-space:nowrap;transition:background 140ms,border-color 140ms,opacity 140ms;text-decoration:none}
.mk-btn:hover{text-decoration:none}
.mk-btn.primary{background:var(--accent-fill,var(--accent));color:var(--accent-text,#fff)}
.mk-btn.primary:hover{background:var(--accent-hover)}
.mk-btn.outline{background:transparent;border-color:var(--accent);color:var(--accent)}
.mk-btn.outline:hover{background:var(--accent-soft)}
.mk-btn.subtle{background:transparent;border-color:var(--border);color:var(--text)}
.mk-btn.subtle:hover{background:var(--hover)}
.mk-btn.dark-pill{background:rgb(15 20 25 / .75);color:#fff;border-color:rgb(255 255 255 / .24);backdrop-filter:blur(6px)}
.mk-btn.dark-pill:hover{background:rgb(15 20 25 / .9)}
.mk-btn:disabled{opacity:.5;cursor:default}

/* More menu popover */
.mk-menu-wrap{position:relative}
.mk-popover{position:absolute;right:0;top:calc(100% + 6px);width:270px;background:var(--bg);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);padding:6px 0;z-index:40}
.mk-pop-section{padding:8px 14px;border-bottom:1px solid var(--border)}
.mk-pop-section:last-child{border-bottom:0;padding-bottom:4px}
.mk-pop-label{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px}
.mk-pop-item{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 14px;border:0;background:transparent;color:var(--text);text-align:left;font-size:14px}
.mk-pop-item:hover{background:var(--hover);text-decoration:none}
.mk-pop-item.danger{color:var(--danger);font-weight:600}
.mk-pop-item .check{color:var(--accent);font-weight:800;font-size:15px}
.mk-pop-sub{display:block;font-size:12px;color:var(--muted)}
.mk-pop-input{width:100%;height:34px;padding:0 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);font-size:14px}
.mk-pop-input:focus{outline:none;border-color:var(--accent);background:var(--bg)}

/* Main centered 600px Twitter Maker stream */
.mk-main{max-width:620px;margin:16px auto 56px;padding:0 10px;display:flex;flex-direction:column;gap:14px}
.mk-banner{padding:10px 14px;border-radius:10px;font-size:14px;font-weight:600;border:1px solid var(--border);background:var(--bg)}
.mk-banner.notice{border-color:rgb(23 191 99 / .45);background:rgb(23 191 99 / .12);color:var(--text)}
.mk-banner.error{border-color:rgb(224 36 94 / .5);background:rgb(224 36 94 / .12);color:var(--danger)}
.mk-card{background:var(--bg);border:1px solid var(--border);border-radius:12px;overflow:hidden}

/* Hero Cover & Inline Title/Description */
.mk-cover{position:relative;width:100%;aspect-ratio:16/9;max-height:310px;background:var(--surface);overflow:hidden;display:flex;align-items:center;justify-content:center}
.mk-cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.mk-cover-scrim{position:absolute;inset:0;background:linear-gradient(to top,rgb(0 0 0 / .45),transparent 45%);pointer-events:none}
.mk-cover-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px;text-align:center;color:var(--muted)}
.mk-cover-empty svg{width:34px;height:34px;fill:var(--muted);opacity:.75}
.mk-cover-empty p{margin:0;font-size:13px;max-width:280px}
.mk-cover-btn{position:relative;z-index:2}
.mk-cover.has-img .mk-cover-btn{position:absolute;right:14px;bottom:14px}
.mk-cover-credit{position:absolute;left:14px;bottom:16px;z-index:2;color:#fff;font-size:12px;font-weight:600;text-shadow:0 1px 3px rgb(0 0 0 / .6)}

.mk-header-edit{padding:18px 20px 16px;display:flex;flex-direction:column;gap:8px}
.mk-title-input{width:100%;border:0;background:transparent;padding:0;font-size:26px;line-height:32px;font-weight:800;letter-spacing:-0.015em;color:var(--text);outline:none}
.mk-title-input::placeholder{color:var(--muted);opacity:.72}
.mk-desc-input{width:100%;border:0;background:transparent;padding:0;font-size:15px;line-height:22px;color:var(--text);resize:none;outline:none;min-height:44px;overflow:hidden}
.mk-desc-input::placeholder{color:var(--muted);opacity:.78}
.mk-byline{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding-top:10px;margin-top:4px;border-top:1px solid var(--border);font-size:13px;color:var(--muted)}
.mk-byline-author{display:flex;align-items:center;gap:8px;min-width:0}
.mk-byline-author img{width:22px;height:22px;border-radius:50%;object-fit:cover;flex:none}
.mk-byline-name{color:var(--text);font-weight:700}
.mk-pills{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.mk-pill{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:9999px;font-size:12px;font-weight:700;background:var(--surface);color:var(--muted);border:1px solid var(--border)}
.mk-pill.public{background:rgb(23 191 99 / .14);color:var(--success);border-color:rgb(23 191 99 / .35)}
.mk-pill.unlisted{background:var(--accent-soft);color:var(--accent);border-color:rgb(29 161 242 / .35)}
.mk-pill.private{background:var(--surface);color:var(--muted)}

/* Section headers */
.mk-sec-head{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px}
.mk-sec-head h2{margin:0;font-size:17px;line-height:22px;font-weight:800}
.mk-count{font-size:13px;font-weight:700;color:var(--muted)}

/* Authentic 2019 Twitter Tweet rows */
.mk-stream{display:flex;flex-direction:column}
.mk-tweet{display:flex;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border);transition:background 120ms}
.mk-tweet:last-child{border-bottom:0}
.mk-tweet:hover{background:var(--hover)}
.mk-avatar{width:48px;height:48px;border-radius:50%;object-fit:cover;flex:none;background:var(--surface)}
.mk-tweet-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.mk-tweet-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.mk-tweet-who{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0;font-size:14px;line-height:19px}
.mk-tweet-name{font-weight:700;color:var(--text)}
.mk-verified{width:15px;height:15px;fill:var(--accent);flex:none}
.mk-tweet-handle{color:var(--muted)}
.mk-tweet-text{font-size:15px;line-height:20px;white-space:pre-wrap;color:var(--text)}
.mk-tweet-media{display:grid;gap:4px;margin-top:6px;border-radius:12px;overflow:hidden;border:1px solid var(--border)}
.mk-tweet-media.n1{grid-template-columns:1fr}
.mk-tweet-media.n2,.mk-tweet-media.n3,.mk-tweet-media.n4{grid-template-columns:1fr 1fr}
.mk-tweet-media img{width:100%;height:190px;object-fit:cover;display:block;background:var(--surface)}
.mk-tweet-media.n1 img{height:auto;max-height:290px}

/* Tweet controls inside Moment */
.mk-tweet-ctrls{display:flex;align-items:center;gap:2px;flex:none}
.mk-ctrl{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9999px;border:0;background:transparent;color:var(--muted);transition:background 120ms,color 120ms}
.mk-ctrl:hover:not(:disabled){background:var(--accent-soft);color:var(--accent)}
.mk-ctrl.active{background:var(--accent-soft);color:var(--accent)}
.mk-ctrl.remove:hover:not(:disabled){background:rgb(224 36 94 / .12);color:var(--danger)}
.mk-ctrl:disabled{opacity:.3;cursor:default}
.mk-ctrl svg{width:16px;height:16px;fill:currentColor}

/* Iconic circular checkmark toggle on picker candidates */
.mk-pick-col{display:flex;align-items:flex-start;padding-top:4px;flex:none}
.mk-pick-btn{width:34px;height:34px;border-radius:9999px;border:1.5px solid var(--border);background:var(--bg);color:var(--muted);display:inline-flex;align-items:center;justify-content:center;transition:all 140ms}
.mk-pick-btn:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.mk-pick-btn.added{background:var(--accent);border-color:var(--accent);color:#fff}
.mk-pick-btn.added:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.mk-pick-btn svg{width:18px;height:18px;fill:currentColor}

/* 4-Tab Twitter Moments Maker Picker */
.mk-tabs{display:flex;border-bottom:1px solid var(--border);overflow-x:auto}
.mk-tab{flex:1 1 auto;position:relative;display:flex;align-items:center;justify-content:center;padding:14px 10px;border:0;background:transparent;color:var(--muted);font-size:14px;font-weight:700;white-space:nowrap;text-decoration:none;transition:background 140ms,color 140ms}
.mk-tab:hover{background:var(--accent-soft);color:var(--accent);text-decoration:none}
.mk-tab.active{color:var(--accent)}
.mk-tab.active::after{content:"";position:absolute;left:12px;right:12px;bottom:0;height:3px;border-radius:3px 3px 0 0;background:var(--accent)}

.mk-subbar{padding:12px 16px;border-bottom:1px solid var(--border);background:var(--surface);display:flex;align-items:center;gap:8px}
.mk-pill-input{flex:1;min-width:0;display:flex;align-items:center;gap:8px;height:38px;padding:0 14px;border-radius:9999px;background:var(--input);border:1px solid transparent;transition:border-color 140ms,background 140ms}
.mk-pill-input:focus-within{border-color:var(--accent);background:var(--bg)}
.mk-pill-input svg{width:16px;height:16px;fill:var(--muted);flex:none}
.mk-pill-input input{flex:1;min-width:0;border:0;background:transparent;outline:none;font-size:14px}
.mk-pill-input span{color:var(--muted);font-weight:700}

.mk-empty{padding:36px 20px;text-align:center;color:var(--muted)}
.mk-empty strong{display:block;color:var(--text);font-size:16px;margin-bottom:4px}
.mk-empty p{margin:0;font-size:14px}

/* Set Cover Modal */
.mk-modal-bg{position:fixed;inset:0;z-index:50;background:var(--scrim);display:flex;align-items:center;justify-content:center;padding:16px}
.mk-modal{width:min(540px,100%);max-height:82vh;background:var(--bg);border:1px solid var(--border);border-radius:16px;overflow:hidden;display:flex;flex-direction:column;box-shadow:var(--shadow)}
.mk-modal-head{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px}
.mk-modal-head h3{margin:0;font-size:17px;font-weight:800}
.mk-modal-body{padding:16px;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:10px}
.mk-cover-opt{position:relative;aspect-ratio:16/10;border-radius:10px;overflow:hidden;border:2px solid transparent;padding:0;background:var(--surface)}
.mk-cover-opt img{width:100%;height:100%;object-fit:cover;display:block}
.mk-cover-opt:hover{border-color:var(--accent)}
.mk-cover-opt.selected{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.mk-cover-opt .mk-opt-check{position:absolute;top:6px;right:6px;width:24px;height:24px;border-radius:9999px;background:var(--accent);color:#fff;display:grid;place-items:center;font-size:13px;font-weight:800}

@media (max-width:600px){
	.mk-main{margin:0;padding:0;gap:10px}
	.mk-card{border-radius:0;border-inline:0}
	.mk-save-state{display:none}
	.mk-btn{padding:0 12px;font-size:13px}
}
`;

// /i/moments/edit/:id: Owner-only Twitter Moments Maker page.
export async function momentEditRoute(req: Request, url: URL, viewer: Viewer, momentId: string): Promise<Response> {
	if (!isId(momentId)) {
		return accountPage({ req, viewer, title: "Moment not found", status: 404, back: { href: `/${viewer.screen_name}/moments`, label: "Back to Moments" }, body: `<p class="dim">This Moment doesn't exist.</p>` });
	}
	const [raw] = await sql`${momentSelect(viewer.id)} where m.id = ${momentId}::bigint`;
	if (!raw) {
		return accountPage({ req, viewer, title: "Moment not found", status: 404, back: { href: `/${viewer.screen_name}/moments`, label: "Back to Moments" }, body: `<p class="dim">This Moment doesn't exist or was deleted.</p>` });
	}
	if (String(raw.user_id) !== viewer.id) {
		return accountPage({
			req,
			viewer,
			title: "Access denied",
			status: 403,
			back: { href: `/i/moments/${momentId}`, label: "View Moment" },
			body: `<h1>You can't edit this Moment</h1><p class="dim">Only the author of a Moment can edit or delete it.</p><p><a href="/i/moments/${esc(momentId)}">View Moment</a></p>`,
		});
	}

	let notice = "";
	let error = "";

	if (req.method === "POST") {
		const f = await req.formData().catch(() => undefined);
		if (String(f?.get("csrf") ?? "") !== viewer.csrf) {
			error = "That form is out of date. Try again.";
		} else {
			const action = String(f?.get("action") ?? "save");
			try {
				if (action === "delete") {
					await deleteMoment(viewer, momentId);
					return new Response(null, { status: 303, headers: { location: `/${viewer.screen_name}/moments` } });
				}
				if (action === "save") {
					await updateMoment(viewer, momentId, {
						title: String(f?.get("title") ?? ""),
						description: String(f?.get("description") ?? ""),
						category: String(f?.get("category") ?? ""),
						visibility: String(f?.get("visibility") ?? raw.visibility),
					});
					notice = "Moment details saved.";
				} else if (action === "toggle_publish") {
					const nextVis: MomentVisibility = raw.visibility === "public" ? "private" : "public";
					await updateMoment(viewer, momentId, { visibility: nextVis });
					notice = nextVis === "public" ? "Moment published." : "Moment moved back to drafts.";
				} else if (action === "add_post") {
					const ref = String(f?.get("post_ref") ?? "").trim();
					await addMomentPost(viewer, momentId, ref);
					notice = "Post added to Moment.";
				} else if (action === "remove_post") {
					await removeMomentPost(viewer, momentId, String(f?.get("post_id") ?? ""));
					notice = "Post removed from Moment.";
				} else if (action === "move_up" || action === "move_down") {
					await moveMomentPost(viewer, momentId, String(f?.get("post_id") ?? ""), action === "move_up" ? "up" : "down");
				} else if (action === "set_cover") {
					const pid = String(f?.get("post_id") ?? "");
					const mid = String(f?.get("media_id") ?? "");
					await updateMoment(viewer, momentId, { cover_post_id: pid || null, cover_media_id: mid || null });
					notice = pid ? "Cover image updated." : "Cover image cleared.";
				}
			} catch (e) {
				error = e instanceof Error ? e.message : "Could not update Moment.";
			}
		}
	}

	const row = (await getMoment(viewer.id, momentId))!;
	const author = await userById(viewer.id, viewer.id);
	const items = await momentPosts(viewer.id, row.id);
	const coverPost = await resolveCover(viewer.id, row, items);
	const coverMedia = (row.cover_media_id ? coverPost?.media?.find((m) => m.id === row.cover_media_id) : undefined) ?? coverPost?.media?.[0];

	const rawTab = url.searchParams.get("tab") ?? "account";
	const tab = rawTab === "likes" || rawTab === "search" || rawTab === "link" || rawTab === "account" ? rawTab : rawTab === "posts" ? "account" : "account";
	const q = (url.searchParams.get("q") ?? "").trim();
	const handle = (url.searchParams.get("handle") ?? viewer.screen_name).replace(/^@/, "").trim() || viewer.screen_name;
	const candidates = await candidatePosts(viewer, tab, q, handle);

	const makerState = {
		csrf: viewer.csrf,
		viewer: {
			screen_name: viewer.screen_name,
			name: author?.name || viewer.name || viewer.screen_name,
			avatar: author?.avatar_url || "/abs/sticky/default_profile_images/default_profile_normal.png",
			verified: Boolean(author?.verified_type),
		},
		moment: {
			id: row.id,
			title: row.title,
			description: row.description,
			category: row.category,
			visibility: row.visibility,
			cover_post_id: row.cover_post_id,
			cover_media_id: row.cover_media_id,
			effective_cover_post_id: coverPost?.id ?? null,
			effective_cover_media_id: coverMedia?.id ?? null,
			cover_url: coverMedia ? (coverMedia.kind === "video" ? `/media/poster/${coverMedia.id}.jpg` : `/media/${coverMedia.id}`) : null,
			cover_author: coverPost?.author.screen_name ?? null,
			date_label: momentTimeString(new Date(row.published_at ?? row.created_at)),
		},
		items: items.map(serializeMakerPost),
		candidates: candidates.map(serializeMakerPost),
		tab,
		q,
		handle,
	};

	if (req.method === "GET" && url.searchParams.get("state") === "1") {
		return Response.json(makerState, { headers: { "cache-control": "no-store" } });
	}

	const { accountVars, accentVars } = await import("./themes/css");
	const { nightModeCookies } = await import("./themes/api");
	const { paletteOf, readPrefs } = await import("./themes/validate");
	const name = settings().instance_name;
	const night = parseCookies(req).night_mode;
	const [prefRow] = await sql`select preferences from users where id = ${viewer.id}::bigint`;
	const prefs = readPrefs(prefRow?.preferences);
	const look = prefs.look;
	const theme = paletteOf(look, night) ?? "light";
	const themeExtra = look?.kind === "painted" ? `:root[data-theme]{${accountVars(look.theme)}}` : `:root{${accentVars(prefs.accent)}}`;

	const visLabel = row.visibility === "public" ? "Published" : row.visibility === "unlisted" ? "Unlisted" : "Draft";
	const makerScript = `(function(){
	var S=JSON.parse(document.getElementById("mk-state").textContent);
	var $=function(id){return document.getElementById(id)};
	var saveTimer=null,lastSaved={title:S.moment.title,description:S.moment.description,category:S.moment.category};
	var ICONS={
		up:'<svg viewBox="0 0 24 24"><path d="M12 4.59l7.7 7.7-1.41 1.42L13 8.41V20h-2V8.41l-5.29 5.3-1.42-1.42z"/></svg>',
		down:'<svg viewBox="0 0 24 24"><path d="M12 19.41l-7.7-7.7 1.41-1.42L11 15.59V4h2v11.59l5.29-5.3 1.42 1.42z"/></svg>',
		cam:'<svg viewBox="0 0 24 24"><path d="M9.697 3H14.3l1.39 2.25H19c1.66 0 3 1.34 3 3v9.5c0 1.66-1.34 3-3 3H5c-1.66 0-3-1.34-3-3v-9.5c0-1.66 1.34-3 3-3h3.31L9.697 3zM12 8.75a4.5 4.5 0 100 9 4.5 4.5 0 000-9zm0 2a2.5 2.5 0 110 5 2.5 2.5 0 010-5z"/></svg>',
		x:'<svg viewBox="0 0 24 24"><path d="M13.41 12l5.79-5.79-1.41-1.41L12 10.59 6.21 4.79 4.79 6.21 10.59 12l-5.8 5.79 1.42 1.42L12 13.41l5.79 5.8 1.41-1.42z"/></svg>',
		check:'<svg viewBox="0 0 24 24"><path d="M9.64 18.952l-5.55-4.861 1.317-1.504 3.951 3.459 8.459-10.948L19.4 6.32 9.64 18.952z"/></svg>',
		verified:'<svg class="mk-verified" viewBox="0 0 24 24"><path d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .494.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.17-.032.34-.032.514 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.174-.012-.344-.033-.513 1.158-.687 1.943-1.99 1.943-3.484zm-6.616-3.334l-4.334 6.5a.749.749 0 01-1.041.208l-.115-.094-2.415-2.415a.749.749 0 111.06-1.06l1.77 1.767 3.825-5.74a.75.75 0 011.248.834z"/></svg>'
	};

	function setSaveState(text,cls){
		var el=$("mk-save-state");
		el.textContent=text;
		el.className="mk-save-state"+(cls?" "+cls:"");
	}

	function showError(msg){
		var b=$("mk-live-error");
		if(!msg){b.hidden=true;b.textContent="";return}
		b.textContent=msg;b.hidden=false;
		setSaveState("Error saving","error");
	}

	async function api(path,body){
		var res=await fetch(path,{
			method:"POST",
			headers:{"content-type":"application/json","x-csrf-token":S.csrf},
			body:JSON.stringify(body||{})
		});
		var data=await res.json().catch(function(){return{}});
		if(!res.ok){
			var msg=(data&&data.errors&&data.errors[0]&&data.errors[0].message)||"Request failed.";
			throw new Error(msg);
		}
		return data;
	}

	async function refreshState(opts){
		opts=opts||{};
		var tab=opts.tab!==undefined?opts.tab:S.tab;
		var q=opts.q!==undefined?opts.q:S.q;
		var handle=opts.handle!==undefined?opts.handle:S.handle;
		var qs=new URLSearchParams({state:"1",tab:tab});
		if(q)qs.set("q",q);
		if(handle)qs.set("handle",handle);
		var res=await fetch("/i/moments/edit/"+encodeURIComponent(S.moment.id)+"?"+qs.toString(),{headers:{accept:"application/json"}});
		if(!res.ok)throw new Error("Could not refresh Moment.");
		var next=await res.json();
		S.moment=next.moment;S.items=next.items;S.candidates=next.candidates;S.tab=next.tab;S.q=next.q;S.handle=next.handle;
		renderAll();
	}

	function autoGrow(el){
		el.style.height="auto";
		el.style.height=Math.max(44,el.scrollHeight)+"px";
	}

	function el(tag,cls,text){
		var n=document.createElement(tag);
		if(cls)n.className=cls;
		if(text!==undefined)n.textContent=text;
		return n;
	}

	function renderCover(){
		var box=$("mk-cover");
		box.innerHTML="";
		if(S.moment.cover_url){
			box.classList.add("has-img");
			var img=document.createElement("img");
			img.src=S.moment.cover_url;img.alt="Moment cover";
			box.appendChild(img);
			box.appendChild(el("div","mk-cover-scrim"));
			if(S.moment.cover_author){
				box.appendChild(el("div","mk-cover-credit","Cover photo by @"+S.moment.cover_author));
			}
			var btn=el("button","mk-btn dark-pill mk-cover-btn");
			btn.type="button";btn.innerHTML=ICONS.cam+'<span>Set cover</span>';
			btn.onclick=openCoverModal;
			box.appendChild(btn);
		}else{
			box.classList.remove("has-img");
			var empty=el("div","mk-cover-empty");
			empty.innerHTML=ICONS.cam;
			var btn2=el("button","mk-btn outline mk-cover-btn","Set cover");
			btn2.type="button";btn2.onclick=openCoverModal;
			empty.appendChild(btn2);
			empty.appendChild(el("p","","Choose a photo or video from a Tweet in your Moment."));
			box.appendChild(empty);
		}
	}

	function renderHeaderChrome(){
		var vis=S.moment.visibility;
		var pill=$("mk-vis-pill");
		pill.textContent=vis==="public"?"Published":vis==="unlisted"?"Unlisted":"Draft";
		pill.className="mk-pill "+vis;
		var cat=$("mk-cat-pill");
		if(S.moment.category){cat.textContent=S.moment.category;cat.hidden=false}
		else cat.hidden=true;
		var pubBtn=$("mk-publish-btn");
		if(vis==="public"){
			pubBtn.textContent="Unpublish";
			pubBtn.className="mk-btn outline";
		}else{
			pubBtn.textContent="Publish";
			pubBtn.className="mk-btn primary";
		}
		document.querySelectorAll("[data-vis]").forEach(function(b){
			var ck=b.querySelector(".check");
			if(ck)ck.textContent=b.getAttribute("data-vis")===vis?"✓":"";
		});
		$("mk-cat-input").value=S.moment.category||"";
		$("mk-items-count").textContent=S.items.length+(S.items.length===1?" Tweet":" Tweets");
		document.title=(S.moment.title||"Untitled Moment")+" · Moments";
	}

	function buildTweetNode(p,mode,idx,total){
		var row=el("article","mk-tweet");
		var av=document.createElement("img");
		av.className="mk-avatar";av.src=p.author.avatar;av.alt="";
		row.appendChild(av);

		var body=el("div","mk-tweet-body");
		var top=el("div","mk-tweet-top");
		var who=el("div","mk-tweet-who");
		var nameLink=el("a","mk-tweet-name",p.author.name);
		nameLink.href="/"+encodeURIComponent(p.author.screen_name);
		who.appendChild(nameLink);
		if(p.author.verified){
			var v=document.createElement("span");v.innerHTML=ICONS.verified;who.appendChild(v.firstChild);
		}
		who.appendChild(el("span","mk-tweet-handle","@"+p.author.screen_name+" · "+p.date));
		top.appendChild(who);

		if(mode==="item"){
			var ctrls=el("div","mk-tweet-ctrls");
			var up=el("button","mk-ctrl");up.type="button";up.title="Move up";up.innerHTML=ICONS.up;up.disabled=idx===0;
			up.onclick=function(){reorderItem(idx,idx-1)};
			var dn=el("button","mk-ctrl");dn.type="button";dn.title="Move down";dn.innerHTML=ICONS.down;dn.disabled=idx===total-1;
			dn.onclick=function(){reorderItem(idx,idx+1)};
			ctrls.appendChild(up);ctrls.appendChild(dn);
			if(p.media&&p.media.length){
				var isCov=S.moment.effective_cover_post_id===p.id;
				var cov=el("button","mk-ctrl"+(isCov?" active":""));cov.type="button";
				cov.title=isCov?"Current cover image":"Use as cover image";
				cov.innerHTML=ICONS.cam;
				cov.onclick=function(){setCover(p.id,p.media[0].id)};
				ctrls.appendChild(cov);
			}
			var rm=el("button","mk-ctrl remove");rm.type="button";rm.title="Remove from Moment";rm.innerHTML=ICONS.x;
			rm.onclick=function(){removeTweet(p.id)};
			ctrls.appendChild(rm);
			top.appendChild(ctrls);
		}
		body.appendChild(top);

		if(p.text)body.appendChild(el("div","mk-tweet-text",p.text));
		if(p.media&&p.media.length){
			var mg=el("div","mk-tweet-media n"+Math.min(4,p.media.length));
			p.media.slice(0,4).forEach(function(m){
				var im=document.createElement("img");im.src=m.thumb;im.alt=m.alt||"";im.loading="lazy";
				mg.appendChild(im);
			});
			body.appendChild(mg);
		}
		row.appendChild(body);

		if(mode==="candidate"){
			var inMoment=S.items.some(function(x){return x.id===p.id});
			var col=el("div","mk-pick-col");
			var btn=el("button","mk-pick-btn"+(inMoment?" added":""));
			btn.type="button";
			btn.title=inMoment?"Remove from Moment":"Add to Moment";
			btn.setAttribute("aria-pressed",inMoment?"true":"false");
			btn.innerHTML=ICONS.check;
			btn.onclick=function(){inMoment?removeTweet(p.id):addTweet(p.id)};
			col.appendChild(btn);
			row.appendChild(col);
		}
		return row;
	}

	function renderItems(){
		var list=$("mk-items-list");
		list.innerHTML="";
		if(!S.items.length){
			var emp=el("div","mk-empty");
			emp.appendChild(el("strong","","No Tweets in this Moment yet"));
			emp.appendChild(el("p","","Pick Tweets from below or paste a Tweet link to build your story."));
			list.appendChild(emp);
			return;
		}
		S.items.forEach(function(p,i){list.appendChild(buildTweetNode(p,"item",i,S.items.length))});
	}

	function renderPicker(){
		document.querySelectorAll(".mk-tab").forEach(function(t){
			t.classList.toggle("active",t.getAttribute("data-tab")===S.tab);
		});
		$("mk-bar-account").hidden=S.tab!=="account";
		$("mk-bar-search").hidden=S.tab!=="search";
		$("mk-bar-link").hidden=S.tab!=="link";
		$("mk-handle-input").value=S.handle||"";
		$("mk-search-input").value=S.q||"";

		var list=$("mk-candidates-list");
		list.innerHTML="";
		if(S.tab==="link"&&!S.candidates.length){
			var empL=el("div","mk-empty");
			empL.appendChild(el("strong","","Add a Tweet by link"));
			empL.appendChild(el("p","","Paste a Tweet URL or numeric ID above and click Add."));
			list.appendChild(empL);
			return;
		}
		if(!S.candidates.length){
			var emp=el("div","mk-empty");
			emp.appendChild(el("strong","","No Tweets found"));
			emp.appendChild(el("p","",S.tab==="likes"?"Like some Tweets first, or switch to another tab.":S.tab==="account"?"Try another @username to browse their Tweets.":"Try a different search term."));
			list.appendChild(emp);
			return;
		}
		S.candidates.forEach(function(p,i){list.appendChild(buildTweetNode(p,"candidate",i,S.candidates.length))});
	}

	function renderAll(){
		renderCover();
		renderHeaderChrome();
		renderItems();
		renderPicker();
	}

	async function saveMeta(extra){
		showError("");
		setSaveState("Saving...","saving");
		var payload=Object.assign({
			moment_id:S.moment.id,
			title:$("mk-title").value,
			description:$("mk-desc").value,
			category:$("mk-cat-input").value
		},extra||{});
		try{
			await api("/i/api/1.1/moments/update.json",payload);
			S.moment.title=payload.title;
			S.moment.description=payload.description;
			S.moment.category=payload.category;
			if(payload.visibility)S.moment.visibility=payload.visibility;
			lastSaved={title:payload.title,description:payload.description,category:payload.category};
			renderHeaderChrome();
			setSaveState("Saved","");
		}catch(e){showError(e.message)}
	}

	function scheduleSave(){
		clearTimeout(saveTimer);
		setSaveState("Unsaved changes","");
		saveTimer=setTimeout(function(){
			if($("mk-title").value!==lastSaved.title||$("mk-desc").value!==lastSaved.description||$("mk-cat-input").value!==lastSaved.category){
				saveMeta();
			}
		},500);
	}

	async function addTweet(ref){
		showError("");setSaveState("Saving...","saving");
		try{
			await api("/i/api/1.1/moments/add_tweet.json",{moment_id:S.moment.id,tweet_id:ref});
			await refreshState();
			setSaveState("Saved","");
		}catch(e){showError(e.message)}
	}

	async function removeTweet(id){
		showError("");setSaveState("Saving...","saving");
		try{
			await api("/i/api/1.1/moments/remove_tweet.json",{moment_id:S.moment.id,tweet_id:id});
			await refreshState();
			setSaveState("Saved","");
		}catch(e){showError(e.message)}
	}

	async function reorderItem(from,to){
		if(to<0||to>=S.items.length)return;
		var ids=S.items.map(function(x){return x.id});
		var tmp=ids[from];ids[from]=ids[to];ids[to]=tmp;
		showError("");setSaveState("Saving...","saving");
		try{
			await api("/i/api/1.1/moments/reorder.json",{moment_id:S.moment.id,tweet_ids:ids.join(",")});
			await refreshState();
			setSaveState("Saved","");
		}catch(e){showError(e.message)}
	}

	async function setCover(postId,mediaId){
		showError("");setSaveState("Saving...","saving");
		try{
			await api("/i/api/1.1/moments/update.json",{moment_id:S.moment.id,cover_post_id:postId||"",cover_media_id:mediaId||""});
			await refreshState();
			closeCoverModal();
			setSaveState("Saved","");
		}catch(e){showError(e.message)}
	}

	function openCoverModal(){
		var body=$("mk-modal-body");
		body.innerHTML="";
		var choices=[];
		S.items.forEach(function(p){(p.media||[]).forEach(function(m){choices.push({post:p,media:m})})});
		if(!choices.length){
			var emp=el("div","mk-empty");emp.style.gridColumn="1 / -1";
			emp.appendChild(el("strong","","No images available yet"));
			emp.appendChild(el("p","","Add a Tweet with a photo, GIF, or video to pick it as your Moment's cover."));
			body.appendChild(emp);
		}else{
			choices.forEach(function(c){
				var sel=S.moment.effective_cover_post_id===c.post.id&&S.moment.effective_cover_media_id===c.media.id;
				var btn=el("button","mk-cover-opt"+(sel?" selected":""));btn.type="button";
				var im=document.createElement("img");im.src=c.media.thumb;im.alt=c.media.alt||"";
				btn.appendChild(im);
				if(sel)btn.appendChild(el("span","mk-opt-check","✓"));
				btn.onclick=function(){setCover(c.post.id,c.media.id)};
				body.appendChild(btn);
			});
		}
		$("mk-cover-auto").hidden=!S.moment.cover_post_id;
		$("mk-cover-modal").hidden=false;
	}

	function closeCoverModal(){$("mk-cover-modal").hidden=true}

	/* Event wiring */
	var titleEl=$("mk-title"),descEl=$("mk-desc");
	autoGrow(descEl);
	titleEl.addEventListener("input",scheduleSave);
	descEl.addEventListener("input",function(){autoGrow(descEl);scheduleSave()});
	titleEl.addEventListener("blur",function(){if(titleEl.value!==lastSaved.title)saveMeta()});
	descEl.addEventListener("blur",function(){if(descEl.value!==lastSaved.description)saveMeta()});
	$("mk-cat-input").addEventListener("change",function(){saveMeta()});

	$("mk-publish-btn").addEventListener("click",function(){
		var next=S.moment.visibility==="public"?"private":"public";
		saveMeta({visibility:next});
	});

	$("mk-finish-btn").addEventListener("click",async function(e){
		e.preventDefault();
		clearTimeout(saveTimer);
		if(titleEl.value!==lastSaved.title||descEl.value!==lastSaved.description||$("mk-cat-input").value!==lastSaved.category){
			await saveMeta();
		}
		location.assign("/"+encodeURIComponent(S.viewer.screen_name)+"/moments");
	});

	var moreBtn=$("mk-more-btn"),moreMenu=$("mk-more-menu");
	moreBtn.addEventListener("click",function(e){
		e.stopPropagation();
		moreMenu.hidden=!moreMenu.hidden;
		moreBtn.setAttribute("aria-expanded",String(!moreMenu.hidden));
	});
	document.addEventListener("click",function(e){
		if(!moreMenu.hidden&&!moreMenu.contains(e.target)&&e.target!==moreBtn){
			moreMenu.hidden=true;moreBtn.setAttribute("aria-expanded","false");
		}
	});
	document.querySelectorAll("[data-vis]").forEach(function(b){
		b.addEventListener("click",function(){
			moreMenu.hidden=true;
			saveMeta({visibility:b.getAttribute("data-vis")});
		});
	});
	$("mk-delete-btn").addEventListener("click",async function(){
		if(!confirm("Delete this Moment? This can't be undone."))return;
		try{
			await api("/i/api/1.1/moments/delete/"+encodeURIComponent(S.moment.id)+".json",{});
			location.assign("/"+encodeURIComponent(S.viewer.screen_name)+"/moments");
		}catch(e){showError(e.message)}
	});

	$("mk-modal-close").addEventListener("click",closeCoverModal);
	$("mk-cover-auto").addEventListener("click",function(){setCover("","")});
	$("mk-cover-modal").addEventListener("click",function(e){if(e.target===this)closeCoverModal()});
	document.addEventListener("keydown",function(e){if(e.key==="Escape"){closeCoverModal();moreMenu.hidden=true}});

	document.querySelectorAll(".mk-tab").forEach(function(t){
		t.addEventListener("click",function(e){
			e.preventDefault();
			var nextTab=t.getAttribute("data-tab");
			refreshState({tab:nextTab}).catch(function(err){showError(err.message)});
		});
	});
	$("mk-bar-account").addEventListener("submit",function(e){
		e.preventDefault();
		var h=$("mk-handle-input").value.replace(/^@/,"").trim()||S.viewer.screen_name;
		refreshState({tab:"account",handle:h}).catch(function(err){showError(err.message)});
	});
	$("mk-bar-search").addEventListener("submit",function(e){
		e.preventDefault();
		refreshState({tab:"search",q:$("mk-search-input").value.trim()}).catch(function(err){showError(err.message)});
	});
	$("mk-bar-link").addEventListener("submit",async function(e){
		e.preventDefault();
		var inp=$("mk-link-input");
		var val=inp.value.trim();
		if(!val)return;
		await addTweet(val);
		inp.value="";
	});

	renderAll();
})();`;

	const html = `<!doctype html>
<html lang="en"${theme ? ` data-theme="${theme}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="${theme ? MAKER_THEMES[theme].scheme : "light dark"}">
<title>${esc(row.title || "Untitled Moment")} · Moments · ${esc(name)}</title>
<link rel="icon" type="image/png" href="/public/favicon.png">
<style>${MAKER_CSS}${themeExtra}</style>
</head>
<body>
<header class="mk-nav">
	<div class="mk-nav-inner">
		<div class="mk-nav-left">
			<a class="mk-icon-btn" href="/${esc(viewer.screen_name)}/moments" aria-label="Back to Moments" title="Back to Moments">
				<svg viewBox="0 0 24 24"><path d="M7.414 13l5.043 5.04-1.414 1.42L3.586 12l7.457-7.46 1.414 1.42L7.414 11H21v2H7.414z"/></svg>
			</a>
			<div class="mk-brand">
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.59 2.34L5.22 13.06c-.39.5-.03 1.24.6 1.24h4.76l-1.31 7.12c-.12.68.73 1.09 1.18.56l8.33-10.72c.39-.5.03-1.24-.6-1.24h-4.76l1.31-7.12c.12-.68-.73-1.09-1.14-.56z"/></svg>
				<span>Moments</span>
			</div>
			<span id="mk-save-state" class="mk-save-state">Saved</span>
		</div>
		<div class="mk-nav-right">
			<div class="mk-menu-wrap">
				<button id="mk-more-btn" type="button" class="mk-icon-btn" aria-label="More options" aria-haspopup="true" aria-expanded="false" title="More options">
					<svg viewBox="0 0 24 24"><path d="M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>
				</button>
				<div id="mk-more-menu" class="mk-popover" hidden>
					<div class="mk-pop-section">
						<div class="mk-pop-label">Visibility</div>
						<button type="button" class="mk-pop-item" data-vis="public"><span>Public<span class="mk-pop-sub">Visible on your profile</span></span><span class="check">${row.visibility === "public" ? "✓" : ""}</span></button>
						<button type="button" class="mk-pop-item" data-vis="unlisted"><span>Unlisted<span class="mk-pop-sub">Only people with the link</span></span><span class="check">${row.visibility === "unlisted" ? "✓" : ""}</span></button>
						<button type="button" class="mk-pop-item" data-vis="private"><span>Draft<span class="mk-pop-sub">Only visible to you</span></span><span class="check">${row.visibility === "private" ? "✓" : ""}</span></button>
					</div>
					<div class="mk-pop-section">
						<div class="mk-pop-label">Category label</div>
						<input id="mk-cat-input" class="mk-pop-input" maxlength="${MAX_CATEGORY}" value="${esc(row.category)}" placeholder="e.g. News, Art, Thread">
					</div>
					<div class="mk-pop-section">
						<a class="mk-pop-item" href="/i/moments/${esc(row.id)}"><span>View Moment</span></a>
						<button id="mk-delete-btn" type="button" class="mk-pop-item danger"><span>Delete Moment</span></button>
					</div>
				</div>
			</div>
			<a id="mk-finish-btn" class="mk-btn subtle" href="/${esc(viewer.screen_name)}/moments">Finish later</a>
			<button id="mk-publish-btn" type="button" class="mk-btn ${row.visibility === "public" ? "outline" : "primary"}">${row.visibility === "public" ? "Unpublish" : "Publish"}</button>
		</div>
	</div>
</header>

<main class="mk-main">
	${notice ? `<div class="mk-banner notice" role="status">${esc(notice)}</div>` : ""}
	${error ? `<div class="mk-banner error" role="alert">${esc(error)}</div>` : ""}
	<div id="mk-live-error" class="mk-banner error" role="alert" hidden></div>

	<section class="mk-card">
		<div id="mk-cover" class="mk-cover${coverMedia ? " has-img" : ""}"></div>
		<form method="post" action="/i/moments/edit/${esc(row.id)}${esc(url.search)}" class="mk-header-edit">
			<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
			<input type="hidden" name="action" value="save">
			<input type="hidden" name="visibility" value="${esc(row.visibility)}">
			<input type="hidden" name="category" value="${esc(row.category)}">
			<input id="mk-title" name="title" class="mk-title-input" maxlength="${MAX_TITLE}" value="${esc(row.title)}" placeholder="Title your Moment" autocomplete="off">
			<textarea id="mk-desc" name="description" class="mk-desc-input" maxlength="${MAX_DESCRIPTION}" placeholder="Add a description">${esc(row.description)}</textarea>
			<noscript><button type="submit" class="mk-btn primary" style="align-self:flex-start;margin-top:6px">Save details</button></noscript>
			<div class="mk-byline">
				<div class="mk-byline-author">
					<img src="${esc(makerState.viewer.avatar)}" alt="">
					<span class="mk-byline-name">${esc(makerState.viewer.name)}</span>
					<span>@${esc(viewer.screen_name)} · ${esc(makerState.moment.date_label)}</span>
				</div>
				<div class="mk-pills">
					<span id="mk-cat-pill" class="mk-pill"${row.category ? "" : " hidden"}>${esc(row.category)}</span>
					<span id="mk-vis-pill" class="mk-pill ${esc(row.visibility)}">${esc(visLabel)}</span>
				</div>
			</div>
		</form>
	</section>

	<section class="mk-card">
		<div class="mk-sec-head">
			<h2>Tweets in your Moment</h2>
			<span id="mk-items-count" class="mk-count">${items.length} ${items.length === 1 ? "Tweet" : "Tweets"}</span>
		</div>
		<div id="mk-items-list" class="mk-stream"></div>
	</section>

	<section class="mk-card">
		<div class="mk-sec-head">
			<h2>Add Tweets to your Moment</h2>
		</div>
		<nav class="mk-tabs" aria-label="Tweet sources">
			<a href="/i/moments/edit/${esc(row.id)}?tab=likes" class="mk-tab${tab === "likes" ? " active" : ""}" data-tab="likes">Tweets I've liked</a>
			<a href="/i/moments/edit/${esc(row.id)}?tab=account" class="mk-tab${tab === "account" ? " active" : ""}" data-tab="account">Tweets by account</a>
			<a href="/i/moments/edit/${esc(row.id)}?tab=search" class="mk-tab${tab === "search" ? " active" : ""}" data-tab="search">Tweet search</a>
			<a href="/i/moments/edit/${esc(row.id)}?tab=link" class="mk-tab${tab === "link" ? " active" : ""}" data-tab="link">Tweet link</a>
		</nav>
		<form id="mk-bar-account" class="mk-subbar" method="get" action="/i/moments/edit/${esc(row.id)}"${tab === "account" ? "" : " hidden"}>
			<input type="hidden" name="tab" value="account">
			<div class="mk-pill-input">
				<span>@</span>
				<input id="mk-handle-input" name="handle" value="${esc(handle)}" placeholder="username" autocomplete="off">
			</div>
			<button type="submit" class="mk-btn outline">Load</button>
		</form>
		<form id="mk-bar-search" class="mk-subbar" method="get" action="/i/moments/edit/${esc(row.id)}"${tab === "search" ? "" : " hidden"}>
			<input type="hidden" name="tab" value="search">
			<div class="mk-pill-input">
				<svg viewBox="0 0 24 24"><path d="M21.53 20.47l-3.66-3.66C19.195 15.24 20 13.214 20 11c0-4.97-4.03-9-9-9s-9 4.03-9 9 4.03 9 9 9c2.215 0 4.24-.804 5.808-2.13l3.66 3.66c.147.146.34.22.53.22s.385-.073.53-.22c.295-.293.295-.767.002-1.06zM3.5 11c0-4.135 3.365-7.5 7.5-7.5s7.5 3.365 7.5 7.5-3.365 7.5-7.5 7.5-7.5-3.365-7.5-7.5z"/></svg>
				<input id="mk-search-input" name="q" value="${esc(q)}" placeholder="Search Tweets" autocomplete="off">
			</div>
			<button type="submit" class="mk-btn outline">Search</button>
		</form>
		<form id="mk-bar-link" class="mk-subbar" method="post" action="/i/moments/edit/${esc(row.id)}?tab=link"${tab === "link" ? "" : " hidden"}>
			<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
			<input type="hidden" name="action" value="add_post">
			<div class="mk-pill-input">
				<svg viewBox="0 0 24 24"><path d="M11.96 14.945c-.067 0-.136-.01-.203-.027-1.13-.318-2.097-.986-2.795-1.932-.622-.845-1.01-1.84-1.01-2.905 0-1.36.53-2.638 1.49-3.6l3.4-3.4c1.985-1.986 5.214-1.986 7.2 0 1.985 1.985 1.985 5.214 0 7.2l-1.95 1.95c-.293.293-.768.293-1.06 0s-.294-.768 0-1.06l1.95-1.95c1.4-1.4 1.4-3.678 0-5.078-1.4-1.4-3.678-1.4-5.078 0l-3.4 3.4c-.678.678-1.052 1.58-1.052 2.54 0 .746.272 1.442.71 2.036.494.67 1.18 1.142 1.98 1.368.4.112.632.526.52.925-.093.332-.394.55-.722.55zm-5.12 6.555c-1.303 0-2.607-.496-3.6-1.49-1.985-1.985-1.985-5.214 0-7.2l1.95-1.95c.293-.293.768-.293 1.06 0s.294.768 0 1.06l-1.95 1.95c-1.4 1.4-1.4 3.678 0 5.078 1.4 1.4 3.678 1.4 5.078 0l3.4-3.4c.678-.678 1.052-1.58 1.052-2.54 0-.746-.272-1.442-.71-2.036-.494-.67-1.18-1.142-1.98-1.368-.4-.112-.632-.526-.52-.925.112-.4.526-.632.925-.52 1.13.318 2.097.986 2.795 1.932.622.845 1.01 1.84 1.01 2.905 0 1.36-.53 2.638-1.49 3.6l-3.4 3.4c-.993.994-2.297 1.49-3.6 1.49z"/></svg>
				<input id="mk-link-input" name="post_ref" placeholder="Paste a Tweet link or ID" autocomplete="off">
			</div>
			<button type="submit" class="mk-btn primary">Add</button>
		</form>
		<div id="mk-candidates-list" class="mk-stream"></div>
	</section>
</main>

<div id="mk-cover-modal" class="mk-modal-bg" hidden>
	<div class="mk-modal" role="dialog" aria-modal="true" aria-labelledby="mk-modal-title">
		<div class="mk-modal-head">
			<div style="display:flex;align-items:center;gap:8px">
				<button id="mk-modal-close" type="button" class="mk-icon-btn" aria-label="Close">
					<svg viewBox="0 0 24 24"><path d="M13.41 12l5.79-5.79-1.41-1.41L12 10.59 6.21 4.79 4.79 6.21 10.59 12l-5.8 5.79 1.42 1.42L12 13.41l5.79 5.8 1.41-1.42z"/></svg>
				</button>
				<h3 id="mk-modal-title">Choose a cover image</h3>
			</div>
			<button id="mk-cover-auto" type="button" class="mk-btn subtle"${row.cover_post_id ? "" : " hidden"}>Use automatic</button>
		</div>
		<div id="mk-modal-body" class="mk-modal-body"></div>
	</div>
</div>

<script id="mk-state" type="application/json">${safeJson(makerState)}</script>
<script>${makerScript}</script>
</body>
</html>`;

	const headers = new Headers({
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"x-frame-options": "SAMEORIGIN",
		"content-security-policy": "frame-ancestors 'self'",
		"referrer-policy": "no-referrer",
	});
	for (const c of nightModeCookies(look)) headers.append("set-cookie", c);
	return new Response(html, { status: error ? 400 : 200, headers });
}

// /i/moments/:id fallback capsule viewer for client builds without `bundle.Moment` (e.g. 2026-current).
export async function momentViewRoute(req: Request, viewer: Viewer, momentId: string): Promise<Response> {
	const row = await getMoment(viewer.id, momentId, false);
	if (!row) {
		return accountPage({
			req,
			viewer,
			title: "Moment not found",
			status: 404,
			back: { href: "/home", label: "Back to home" },
			body: `<h1>Moment not found</h1><p class="dim">This Moment doesn't exist or isn't available to you.</p>`,
		});
	}
	const author = await userById(viewer.id, row.user_id);
	const items = await momentPosts(viewer.id, row.id);
	const coverPost = await resolveCover(viewer.id, row, items);
	const coverMedia = (row.cover_media_id ? coverPost?.media?.find((m) => m.id === row.cover_media_id) : undefined) ?? coverPost?.media?.[0];
	const isOwner = row.user_id === viewer.id;

	const coverHtml = coverMedia
		? `<div class="moment-cover"><img src="${esc(coverMedia.kind === "photo" || coverMedia.kind === "gif" ? `/media/${coverMedia.id}` : `/media/poster/${coverMedia.id}.jpg`)}" alt=""></div>`
		: "";

	const postsHtml = items.length ? items.map((p) => renderPostCard(p)).join("") : `<p class="dim">This Moment has no posts yet.</p>`;

	return accountPage({
		req,
		viewer,
		title: row.title || "Untitled Moment",
		back: { href: author ? `/${author.screen_name}` : "/home", label: "Back" },
		css: MOMENT_CSS,
		body: `${coverHtml}
		<div class="split">
			<div>
				${author ? `<a class="moment-author" href="/${esc(author.screen_name)}">${esc(author.name || author.screen_name)} <span>@${esc(author.screen_name)}</span></a>` : ""}
				<h1 style="margin-top:6px">${esc(row.title || "Untitled")}</h1>
			</div>
			${isOwner ? `<a href="/i/moments/edit/${esc(row.id)}"><button type="button" class="secondary small">Edit Moment</button></a>` : ""}
		</div>
		${row.description ? `<p>${esc(row.description)}</p>` : ""}
		<div class="meta">${esc(momentTimeString(new Date(row.published_at ?? row.created_at)))}${row.total_likes ? ` · ${row.total_likes} ${row.total_likes === 1 ? "Like" : "Likes"}` : ""}</div>
		<hr style="border:0;border-top:1px solid var(--border);width:100%">
		${postsHtml}`,
	});
}
