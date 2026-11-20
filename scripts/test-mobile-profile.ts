import assert from "node:assert/strict";
import type { Viewer } from "../src/auth";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { restRoute } from "../src/rest";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const owner = newId(), other = newId(), older = newId(), newer = newId(), reply = newId(), otherPost = newId();
const name = `mobile_${owner.slice(-8)}`;
const profile = "/1.1/timeline/user.json";
const flags = "include_tweet_replies=false&exclude_pinned_tweets=true";
async function get(id: string, query: string, path = profile) {
	const req = new Request(`https://example.com${path}?${query}`, { headers: { "user-agent": "TwitterAndroid/6.17.0" } });
	const res = await restRoute("GET", path, { id } as Viewer, req);
	assert.equal(res?.status, 200);
	return res!.json();
}
const entries = (page: any) => page.response.timeline.map((entry: any) => entry.tweet?.id ?? entry.conversation.context.target_tweet_id);

try {
	await sql`insert into users (id, screen_name, name, password_hash) values
		(${owner}::bigint, ${name}, 'Profile owner', '!'),
		(${other}::bigint, ${`${name}_other`}, 'Other viewer', '!')`;
	await sql`insert into posts (id, user_id, text, conversation_id, reply_to_id) values
		(${older}::bigint, ${owner}::bigint, 'Older post', ${older}::bigint, null),
		(${newer}::bigint, ${owner}::bigint, 'Newer post', ${newer}::bigint, null),
		(${reply}::bigint, ${owner}::bigint, 'Reply', ${older}::bigint, ${older}::bigint),
		(${otherPost}::bigint, ${other}::bigint, 'Other post', ${otherPost}::bigint, null)`;
	await sql`update users set pinned_post_id = ${older}::bigint where id = ${owner}::bigint`;

	const first = await get(owner, `id=${owner}&count=1&${flags}`);
	assert.deepEqual(entries(first), [newer]);
	assert.deepEqual(first.response.cursor, { top: newer, bottom: newer });
	assert.equal(first.twitter_objects.tweets[newer].text, "Newer post");
	assert.equal(first.twitter_objects.users[owner].id_str, owner);
	assert.deepEqual(entries(await get(owner, `id=${owner}&down_cursor=${newer}&${flags}`)), [older]);
	assert.deepEqual(entries(await get(owner, `id=${owner}&up_cursor=${older}&${flags}`)), [newer]);
	assert.deepEqual(entries(await get(owner, `id=${owner}&include_tweet_replies=true&exclude_pinned_tweets=true&include_my_retweet=true&earned=true`)), [reply, newer, older]);
	assert.deepEqual(entries(await get(owner, `user_id=${other}&screen_name=${name}&${flags}`)), [otherPost]);
	assert.deepEqual(entries(await get(other, `screen_name=%40${name}&${flags}`)), [newer, older]);
	assert.deepEqual((await get(owner, `user_id=${owner}&exclude_replies=true`, "/1.1/statuses/user_timeline.json")).map((s: any) => s.id_str), [newer, older]);

	await sql`update users set protected = true where id = ${owner}::bigint`;
	assert.deepEqual(entries(await get(other, `id=${owner}&${flags}`)), []);
	assert.deepEqual(entries(await get(owner, flags)), [newer, older]);
} finally {
	await sql`delete from users where id in (${owner}::bigint, ${other}::bigint)`;
	await sql.close();
}
