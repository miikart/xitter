import { expect, test } from "bun:test";
import type { Viewer } from "../src/auth";
import { PUBLIC_ORIGIN } from "../src/config";
import { migrate, sql } from "../src/db";
import { newId } from "../src/ids";
import {
	addMomentPost,
	createMoment,
	deleteMoment,
	extractPostId,
	getMoment,
	momentCapsuleTimeline,
	momentEditRoute,
	momentLikersTimeline,
	momentViewRoute,
	moveMomentPost,
	removeMomentPost,
	setMomentLike,
	setMomentSubscription,
	updateMoment,
	userMomentsTimeline,
} from "../src/moments";
import { patchText } from "../src/patch";
import { restLegacyRoute } from "../src/rest-legacy";
import { restTimelineRoute } from "../src/rest-timeline";

test("patchText rewrites hardcoded twitter.com Moments edit and capsule URLs to PUBLIC_ORIGIN", () => {
	const userMomentsSnippet = '_handleCreateMoment=()=>{this.props.createMoment().then(({payload:{result:e}})=>{k.b.navigateTo("https://twitter.com/i/moments/edit/"+e.id)})}';
	const patchedEdit = patchText(userMomentsSnippet);
	expect(patchedEdit).toContain(`"${PUBLIC_ORIGIN}/i/moments/edit/"+e.id`);
	expect(patchedEdit).not.toContain("https://twitter.com/i/moments/edit/");

	const capsuleSnippet = '_handleEdit=()=>{let{momentId:e}=this.props;A.b.navigateTo("https://twitter.com/i/moments/edit/"+e)};const url="https://twitter.com/i/moments/"+e;';
	const patchedCapsule = patchText(capsuleSnippet);
	expect(patchedCapsule).toContain(`"${PUBLIC_ORIGIN}/i/moments/edit/"+e`);
	expect(patchedCapsule).toContain(`"${PUBLIC_ORIGIN}/i/moments/"+e`);
});

test("extractPostId parses raw snowflake IDs and status URLs", () => {
	expect(extractPostId("1848000000000000123")).toBe("1848000000000000123");
	expect(extractPostId("https://twitter.com/Mii/status/1848000000000000123?s=20")).toBe("1848000000000000123");
	expect(extractPostId("https://x.com/i/web/status/1848000000000000456")).toBe("1848000000000000456");
	expect(extractPostId("not-an-id")).toBeUndefined();
});

async function canConnectDb(): Promise<boolean> {
	try {
		await sql`select 1`;
		return true;
	} catch {
		return false;
	}
}

test("Moments end-to-end persistence, URT contract, editor UI, and visibility rules", async () => {
	if (!(await canConnectDb())) {
		console.log("Skipping DB-backed Moments test (no direct local Postgres socket; run inside container)");
		return;
	}
	await migrate();

	const stamp = Date.now() % 1e8;
	const [ownerId, readerId, blockedId, protectedId] = [newId(), newId(), newId(), newId()];
	const allUsers = [ownerId, readerId, blockedId, protectedId];

	const viewerOf = (id: string, name: string): Viewer => ({
		id,
		screen_name: name,
		name,
		role: null,
		csrf: `csrf_${id}`,
		token: `tok_${id}`,
		restricted: false,
	});

	const owner = viewerOf(ownerId, `m_owner_${stamp}`);
	const reader = viewerOf(readerId, `m_reader_${stamp}`);
	const blocked = viewerOf(blockedId, `m_blocked_${stamp}`);
	const locked = viewerOf(protectedId, `m_locked_${stamp}`);

	const post1 = newId();
	const post2 = newId();
	const postCircle = newId();
	const postProtected = newId();
	const media1 = newId();
	const media2 = newId();

	try {
		for (const u of [owner, reader, blocked, locked]) {
			await sql`insert into users (id, screen_name, name, password_hash, protected)
				values (${u.id}::bigint, ${u.screen_name}, ${u.name}, '!', ${u.id === protectedId})`;
		}
		// owner blocks `blocked`
		await sql`insert into blocks (blocker_id, blocked_id) values (${ownerId}::bigint, ${blockedId}::bigint)`;
		// owner follows `locked`, but `reader` does NOT follow `locked`
		await sql`insert into follows (follower_id, followee_id) values (${ownerId}::bigint, ${protectedId}::bigint)`;

		// Create posts: post1 (with photo), post2 (with photo), postCircle (owner's circle post), postProtected (locked's post)
		await sql`insert into posts (id, user_id, text, conversation_id) values
			(${post1}::bigint, ${ownerId}::bigint, 'First post in moment', ${post1}::bigint),
			(${post2}::bigint, ${ownerId}::bigint, 'Second post in moment', ${post2}::bigint),
			(${postCircle}::bigint, ${ownerId}::bigint, 'Secret circle post', ${postCircle}::bigint),
			(${postProtected}::bigint, ${protectedId}::bigint, 'Protected author post', ${postProtected}::bigint)`;
		await sql`update posts set circle_owner_id = ${ownerId}::bigint where id = ${postCircle}::bigint`;

		await sql`insert into media (id, post_id, user_id, kind, mime, size, width, height, position) values
			(${media1}::bigint, ${post1}::bigint, ${ownerId}::bigint, 'photo', 'image/jpeg', 1024, 1200, 675, 0),
			(${media2}::bigint, ${post2}::bigint, ${ownerId}::bigint, 'photo', 'image/jpeg', 1024, 800, 800, 0)`;

		// 1. Create a Moment via POST /1.1/moments/create.json with JSON body (exact 2019 client payload)
		const createReq = new Request("http://localhost/i/api/1.1/moments/create.json", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "", description: "", is_production_only: true, has_owner_granted_location_permission: true }),
		});
		const createRes = await restLegacyRoute("POST", "/1.1/moments/create.json", owner, createReq);
		expect(createRes?.status).toBe(200);
		const createdBody = (await createRes!.json()) as any;
		const momentId = createdBody?.created_moment?.moment?.id;
		expect(typeof momentId).toBe("string");
		expect(createdBody.created_moment.moment.title).toBe("Untitled");
		expect(createdBody.created_moment.moment.visibility_mode).toBe("private");
		expect(createdBody.created_moment.moment.author.id).toBe(ownerId);

		// 2. Draft moment is visible to owner in list_user_moments, but hidden from reader
		const ownerListDraft = await userMomentsTimeline(owner, new URLSearchParams({ userId: ownerId }));
		expect(ownerListDraft.globalObjects.moments[momentId]).toBeDefined();
		expect(ownerListDraft.timeline.instructions[0].addEntries.entries.some((e: any) => e.entryId === `moment-${momentId}`)).toBe(true);

		const readerListDraft = await userMomentsTimeline(reader, new URLSearchParams({ userId: ownerId }));
		expect(readerListDraft.globalObjects.moments[momentId]).toBeUndefined();

		// 3. Add posts to the Moment (including by status URL), auto-selecting first media post as cover
		await addMomentPost(owner, momentId, `https://twitter.com/${owner.screen_name}/status/${post1}`);
		await addMomentPost(owner, momentId, post2);
		await addMomentPost(owner, momentId, postCircle);
		await addMomentPost(owner, momentId, postProtected);

		const afterAdd = await getMoment(ownerId, momentId);
		expect(afterAdd?.cover_post_id).toBe(post1);
		expect(afterAdd?.cover_media_id).toBe(media1);

		// 4. Reorder posts (move post2 up before post1)
		await moveMomentPost(owner, momentId, post2, "up");
		const ownerCapsule = await momentCapsuleTimeline(owner, momentId);
		const ownerEntries = ownerCapsule.timeline.instructions[0].addEntries.entries;
		expect(ownerEntries[0].content.item.content.momentCapsuleHeader.momentId).toBe(momentId);
		expect(ownerEntries[1].content.item.content.tweet.id).toBe(post2);
		expect(ownerEntries[2].content.item.content.tweet.id).toBe(post1);
		expect(ownerEntries[3].content.item.content.tweet.id).toBe(postCircle);
		expect(ownerEntries[4].content.item.content.tweet.id).toBe(postProtected);
		expect(ownerEntries[5].content.item.content.momentCapsuleFooter.momentId).toBe(momentId);

		// Cover media is hydrated in globalObjects.moments and globalObjects.tweets
		const hydratedMoment = ownerCapsule.globalObjects.moments[momentId];
		expect(hydratedMoment.cover_media.tweet_id).toBe(post1);
		expect(hydratedMoment.cover_media.media.media_id).toBe(media1);
		expect(ownerCapsule.globalObjects.tweets[post1]).toBeDefined();
		expect(ownerCapsule.globalObjects.users[ownerId]).toBeDefined();

		// 5. Update Moment via /i/moments/edit/:id form POST & verify non-owner gets 403
		const editGetForbidden = await momentEditRoute(new Request(`http://localhost/i/moments/edit/${momentId}`), new URL(`http://localhost/i/moments/edit/${momentId}`), reader, momentId);
		expect(editGetForbidden.status).toBe(403);

		const saveForm = new URLSearchParams({
			csrf: owner.csrf,
			action: "save",
			title: "Arch Linux Highlights",
			description: "Curated posts from the instance",
			category: "Tech",
			visibility: "public",
		});
		const editPostRes = await momentEditRoute(
			new Request(`http://localhost/i/moments/edit/${momentId}`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: saveForm,
			}),
			new URL(`http://localhost/i/moments/edit/${momentId}`),
			owner,
			momentId,
		);
		expect(editPostRes.status).toBe(200);
		const editHtml = await editPostRes.text();
		expect(editHtml).toContain("Moment details saved.");
		expect(editHtml).toContain("Arch Linux Highlights");
		expect(editHtml).toContain("Published");

		// 6. Published Moment is now visible to `reader`, but Circle post and Protected post inside it are filtered out!
		const readerListPub = await userMomentsTimeline(reader, new URLSearchParams({ userId: ownerId }));
		expect(readerListPub.globalObjects.moments[momentId]?.title).toBe("Arch Linux Highlights");

		const readerCapsule = await momentCapsuleTimeline(reader, momentId);
		const readerTweetIds = readerCapsule.timeline.instructions[0].addEntries.entries
			.map((e: any) => e.content?.item?.content?.tweet?.id)
			.filter(Boolean);
		expect(readerTweetIds).toEqual([post2, post1]);
		expect(readerTweetIds).not.toContain(postCircle);
		expect(readerTweetIds).not.toContain(postProtected);

		// 7. Blocked user cannot see owner's Moment in list or capsule
		const blockedList = await userMomentsTimeline(blocked, new URLSearchParams({ userId: ownerId }));
		expect(blockedList.globalObjects.moments[momentId]).toBeUndefined();
		const blockedCapsule = await momentCapsuleTimeline(blocked, momentId);
		expect(blockedCapsule.globalObjects.moments[momentId]).toBeUndefined();

		const share = newId();
		const momentUrl = `${PUBLIC_ORIGIN}/i/moments/${momentId}`;
		await sql`insert into posts (id, user_id, text, conversation_id)
			values (${share}::bigint, ${readerId}::bigint, ${momentUrl}, ${share}::bigint)`;
		const sharePath = `/2/timeline/conversation/${share}.json`;
		const shareCard = async (viewer: Viewer) => {
			const response = await restTimelineRoute("GET", sharePath, viewer, new Request(`${PUBLIC_ORIGIN}${sharePath}`));
			return (await response!.json()).globalObjects.tweets[share].card;
		};
		const card = await shareCard(reader);
		expect(card.name).toBe("3260518932:moment");
		expect(card.binding_values.title.string_value).toBe("Arch Linux Highlights");
		expect(card.binding_values.url.string_value).toBe(momentUrl);
		expect(card.binding_values.photo_image.image_value.url).toContain(media1);
		expect(await shareCard(blocked)).toBeUndefined();

		// 8. Protected account's published Moment is visible to follower (`owner`) but hidden from non-follower (`reader`)
		const lockedMomentRes = await createMoment(locked, { title: "Protected Moment", visibility: "public" });
		const lockedMomentId = lockedMomentRes.created_moment.moment.id;
		const ownerSeesLocked = await userMomentsTimeline(owner, new URLSearchParams({ userId: protectedId }));
		expect(ownerSeesLocked.globalObjects.moments[lockedMomentId]).toBeDefined();
		const readerSeesLocked = await userMomentsTimeline(reader, new URLSearchParams({ userId: protectedId }));
		expect(readerSeesLocked.globalObjects.moments[lockedMomentId]).toBeUndefined();

		// 9. Liking, unliking, subscribing, unsubscribing, and /2/moments/userlikes.json
		const likeState = await setMomentLike(reader, momentId, true);
		expect(likeState.moment.is_liked).toBe(true);
		expect(likeState.moment.total_likes).toBe(1);

		const likersUrt = await momentLikersTimeline(owner, new URLSearchParams({ moment_id: momentId }));
		expect(likersUrt.globalObjects.users[readerId]).toBeDefined();

		const unlikeState = await setMomentLike(reader, momentId, false);
		expect(unlikeState.moment.is_liked).toBe(false);
		expect(unlikeState.moment.total_likes).toBe(0);

		const subState = await setMomentSubscription(reader, momentId, true);
		expect(subState.moment.is_subscribed).toBe(true);
		const unsubState = await setMomentSubscription(reader, momentId, false);
		expect(unsubState.moment.is_subscribed).toBe(false);

		// 10. Fallback capsule viewer (/i/moments/:id?view=native) renders HTML capsule
		const viewRes = await momentViewRoute(new Request(`http://localhost/i/moments/${momentId}?view=native`), reader, momentId);
		expect(viewRes.status).toBe(200);
		const viewHtml = await viewRes.text();
		expect(viewHtml).toContain("Arch Linux Highlights");
		expect(viewHtml).toContain("First post in moment");
		expect(viewHtml).not.toContain("Secret circle post");

		// 10b. 2022-11 Moment Maker v1.1 endpoints: capsule, update (with nested cover), curate (ADD/MOVE/DELETE), publish, and live_event preview
		const mmCreateRes = await restLegacyRoute(
			"POST",
			"/1.1/moments/create.json",
			owner,
			new Request("http://localhost/i/api/1.1/moments/create.json", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: "", description: "", is_production_only: false, has_owner_granted_location_permission: true }),
			}),
		);
		expect(mmCreateRes?.status).toBe(200);
		const mmId = ((await mmCreateRes!.json()) as any).created_moment.moment.id as string;

		// Curate ADD two tweets, then MOVE second above first
		const curateAddRes = await restLegacyRoute(
			"POST",
			`/1.1/moments/curate/${mmId}.json`,
			owner,
			new Request(`http://localhost/i/api/1.1/moments/curate/${mmId}.json`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: mmId,
					use_staging_timeline: true,
					actions: [
						{ action: "ADD", tweet_id: post1 },
						{ action: "ADD", tweet_id: post2 },
					],
				}),
			}),
		);
		expect(curateAddRes?.status).toBe(200);

		const curateMoveRes = await restLegacyRoute(
			"POST",
			`/1.1/moments/curate/${mmId}.json`,
			owner,
			new Request(`http://localhost/i/api/1.1/moments/curate/${mmId}.json`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: mmId,
					use_staging_timeline: true,
					actions: [{ action: "MOVE", tweet_id: post2, above: true, relative_to: post1, relative_to_entry_ref: "RELATIVE_TO_TWEET_REF" }],
				}),
			}),
		);
		expect(curateMoveRes?.status).toBe(200);

		// Update metadata + nested cover object
		const updV1Res = await restLegacyRoute(
			"POST",
			`/1.1/moments/update/${mmId}.json`,
			owner,
			new Request(`http://localhost/i/api/1.1/moments/update/${mmId}.json`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: mmId,
					title: "2022 Maker Moment",
					description: "Built via 2022-11 bundle.MomentMaker",
					cover: { tweet_id: post2, media_data: { media_id: media2, crops: [], no_crop: true, size: { width: 800, height: 800 } } },
				}),
			}),
		);
		expect(updV1Res?.status).toBe(200);

		// Fetch v1.1 capsule and verify pages order, tweets map, and cover_media
		const capV1Res = await restLegacyRoute("GET", `/1.1/moments/capsule/${mmId}.json`, owner, new Request(`http://localhost/i/api/1.1/moments/capsule/${mmId}.json`));
		expect(capV1Res?.status).toBe(200);
		const capV1 = (await capV1Res!.json()) as any;
		expect(capV1.moment.title).toBe("2022 Maker Moment");
		expect(capV1.moment.has_unpublished_changes).toBe(true);
		expect(capV1.moment.cover_media.tweet_id).toBe(post2);
		expect(capV1.moment.cover_media.media.media_id).toBe(media2);
		expect(capV1.pages.map((p: any) => p.tweet_id)).toEqual([post2, post1]);
		expect(capV1.tweets[post2]?.extended_entities?.media?.[0]?.id_str).toBe(media2);

		// Publish via v1.1 publish endpoint
		const pubV1Res = await restLegacyRoute("POST", `/1.1/moments/publish/${mmId}.json`, owner, new Request(`http://localhost/i/api/1.1/moments/publish/${mmId}.json`, { method: "POST" }));
		expect(pubV1Res?.status).toBe(200);
		const pubBody = (await pubV1Res!.json()) as any;
		expect(pubBody.updated_moment.moment.visibility_mode).toBe("public");
		expect(pubBody.updated_moment.moment.has_unpublished_changes).toBe(false);

		// Preview endpoints (/1.1/live_event/1/:id/timeline.json and /2/live_event/timeline/:id.json)
		const leMetaRes = await restLegacyRoute("GET", `/1.1/live_event/1/${mmId}/timeline.json`, reader, new Request(`http://localhost/i/api/1.1/live_event/1/${mmId}/timeline.json`));
		expect(leMetaRes?.status).toBe(200);
		const leMeta = (await leMetaRes!.json()) as any;
		expect(leMeta.twitter_objects.live_events[mmId]?.title).toBe("2022 Maker Moment");

		const leTlRes = await restLegacyRoute("GET", `/2/live_event/timeline/${mmId}.json`, reader, new Request(`http://localhost/i/api/2/live_event/timeline/${mmId}.json`));
		expect(leTlRes?.status).toBe(200);
		const leTl = (await leTlRes!.json()) as any;
		expect(leTl.timeline.instructions[0].addEntries.entries.map((e: any) => e.content.item.content.tweet.id)).toEqual([post2, post1]);

		// Curate DELETE one tweet, then delete Moment
		const curateDelRes = await restLegacyRoute(
			"POST",
			`/1.1/moments/curate/${mmId}.json`,
			owner,
			new Request(`http://localhost/i/api/1.1/moments/curate/${mmId}.json`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: mmId, use_staging_timeline: true, actions: [{ action: "DELETE", tweet_id: post1 }] }),
			}),
		);
		expect(curateDelRes?.status).toBe(200);
		const capAfterDel = (await (await restLegacyRoute("GET", `/1.1/moments/capsule/${mmId}.json`, owner, new Request(`http://localhost/i/api/1.1/moments/capsule/${mmId}.json`)))!.json()) as any;
		expect(capAfterDel.pages.map((p: any) => p.tweet_id)).toEqual([post2]);
		await deleteMoment(owner, mmId);

		// 11. Remove post and delete Moment via POST /1.1/moments/delete/:id.json
		await removeMomentPost(owner, momentId, post1);
		const delRes = await restLegacyRoute("POST", `/1.1/moments/delete/${momentId}.json`, owner, new Request(`http://localhost/i/api/1.1/moments/delete/${momentId}.json`, { method: "POST" }));
		expect(delRes?.status).toBe(200);
		expect(await getMoment(ownerId, momentId)).toBeUndefined();
		await deleteMoment(locked, lockedMomentId);
	} finally {
		await sql`delete from users where id = any(${sql.array(allUsers, "INT8")})`;
	}
});
