// End-to-end check of account analytics against a running server. Uses two
// existing accounts and removes what it creates.
// usage: bun scripts/test-analytics.ts <user A> <user B> <password of both>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password] = process.argv.slice(2);
if (!nameA || !nameB || !password) throw new Error("usage: bun scripts/test-analytics.ts <user A> <user B> <password>");

let failed = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
	if (!ok) failed++;
};

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${username} failed`);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();
	return { gql, get, headers };
}

const a = await session(nameA);
const b = await session(nameB);
const studio = await fetch(`${origin}/i/jf/creators/studio`, { headers: a.headers, redirect: "manual" });
check(studio.status === 302 && studio.headers.get("location") === "/i/account_analytics", "Creator Studio opens account analytics");
const now = Date.now();
const range = { from_time: new Date(now - 3_600_000).toISOString(), to_time: new Date(now + 3_600_000).toISOString(), requested_metrics: ["Impressions", "Likes", "Replies", "Retweets", "Bookmark", "Engagements"] };

const post = (await a.gql("CreateTweet", { tweet_text: `analytics test ${now}` }))?.data?.create_tweet?.tweet_results?.result?.rest_id;
check(!!post, "A posts");
// A's own like doesn't count; B's actions do
await a.gql("FavoriteTweet", { tweet_id: post });
await b.gql("FavoriteTweet", { tweet_id: post });
await b.gql("CreateBookmark", { tweet_id: post });
await b.gql("CreateRetweet", { tweet_id: post });
const reply = (await b.gql("CreateTweet", { tweet_text: "a reply for analytics", reply: { in_reply_to_tweet_id: post } }))?.data?.create_tweet?.tweet_results?.result?.rest_id;
await b.get("TweetDetail", { focalTweetId: post });
await b.get("UserByScreenName", { screen_name: nameA });

const content = await a.get("contentPageQuery", range);
const row = content?.data?.viewer_v2?.user_results?.result?.tweets_results?.find((t: any) => t.rest_id === post);
const m = Object.fromEntries((row?.result?.organic_metrics_total ?? []).map((x: any) => [x.metric_type, x.metric_value]));
check(!!row, "the post is in Content");
check(m.Likes === 1 && m.Replies === 1 && m.Retweets === 1 && m.Bookmark === 1, "its counts leave out A's own like", m);
check(m.Engagements === 4, "engagements add up", m.Engagements);
check(typeof row?.result?.details?.created_at_ms === "number", "created_at_ms is a number (the client crashes on a string)");

const overview = await a.get("accountOverviewDailyQuery", { current_from: now - 86_400_000, current_to: now + 86_400_000, prev_from: now - 3 * 86_400_000, prev_to: now - 86_400_000 });
const user = overview?.data?.viewer_v2?.user_results?.result;
const types = new Set((user?.current_time_series ?? []).map((r: any) => r.engagement_type));
check(["Fav", "Reply", "Retweet", "Bookmark", "TweetCreate", "ProfilePic"].every((t) => types.has(t)), "the overview series has each kind", [...types]);
check(typeof user?.relationship_counts?.followers === "number", "and the follower counts");

const detail = await a.get("postDetailsProviderQuery", { rest_id: post });
check(detail?.data?.tweet_result_by_rest_id?.result?.counts?.favorite_count === 2, "the post page shows the post's own counts", detail?.data?.tweet_result_by_rest_id?.result?.counts);
const other = await b.get("postDetailsProviderQuery", { rest_id: post });
check(!other?.data?.tweet_result_by_rest_id?.result, "nobody else gets a post's analytics");

if (reply) await b.gql("DeleteTweet", { tweet_id: reply });
await a.gql("DeleteTweet", { tweet_id: post });

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
