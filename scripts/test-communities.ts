// End-to-end check of communities against a running server: create, join,
// restricted joining with requests, roles, rules, posting, visibility.
// Removes what it creates.
// usage: bun scripts/test-communities.ts <user A> <user B> <password of both>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password] = process.argv.slice(2);
if (!nameA || !nameB || !password) throw new Error("usage: bun scripts/test-communities.ts <user A> <user B> <password>");

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
	return { gql, get };
}

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const entriesOf = (timeline: any): any[] => (timeline?.instructions ?? []).flatMap((i: any) => i.entries ?? []);
const tweetIds = (entries: any[]) => entries.map((e) => e.content?.itemContent?.tweet_results?.result?.rest_id).filter(Boolean);
const annotation = (id: string) => [{ group_id: "8", domain_id: "31", entity_id: id }];

const a = await session(nameA);
const b = await session(nameB);
const userB = (await a.get("UserByScreenName", { screen_name: nameB })).data.user.result;
const name = `Test ${Date.now() % 100000}`;
const made: string[] = [];

const created = await a.gql("CreateCommunity", { name, description: "for the test", joinPolicy: "Open", invitesPolicy: "MemberInvitesAllowed", question: "" });
const community = created.data?.community_create_v2;
const id = community?.id_str as string;
check("create", community?.__typename === "Community" && community.role === "Admin" && community.member_count === 1, community && { role: community.role });
if (id) made.push(id);

const dup = await a.gql("CreateCommunity", { name: name.toUpperCase(), description: "", joinPolicy: "Open", invitesPolicy: "MemberInvitesAllowed" });
check("a duplicate name is refused", !!dup.errors?.length);

const asB = (await b.get("CommunityByRestId", { communityId: id })).data.communityResults.result;
check("a stranger sees it as NonMember with a join action", asB.role === "NonMember" && asB.actions.join_action_result.__typename === "CommunityJoinAction");
const primary = (await b.get("PrimaryContentQuery", { communityId: id })).data?.community;
check("June 2022 can open the community with a legacy facepile", primary?.id_str === id && !!primary.members_facepile_results?.[0]?.result?.legacy?.screen_name);
check("June 2022 hides join requests from non-members", primary?.join_requests_result?.__typename === "CommunityJoinRequestsUnavailable");

// posting
const stranger = await b.gql("CreateTweet", { tweet_text: "not a member", semantic_annotation_ids: annotation(id) });
check("non-members can't post in it", !!stranger.errors?.length);
const inPost = (await a.gql("CreateTweet", { tweet_text: "inside the club", semantic_annotation_ids: annotation(id) })).data.create_tweet.tweet_results.result;
check("post carries the community", inPost.community_results?.result?.id_str === id);
const timelineA = (await a.get("CommunityTweetsTimeline", { communityId: id, count: 20 })).data.communityResults.result;
check("community timeline has it (both keys)", tweetIds(entriesOf(timelineA.community_timeline.timeline)).includes(inPost.rest_id) && !!timelineA.ranked_community_timeline);

// visibility outside the community
const homeB = tweetIds(entriesOf((await b.get("HomeTimeline", { count: 50 })).data.home.home_timeline_urt));
check("non-members don't get it in their home feed", !homeB.includes(inPost.rest_id));
const homeA = tweetIds(entriesOf((await a.get("HomeTimeline", { count: 50 })).data.home.home_timeline_urt));
check("members do", homeA.includes(inPost.rest_id));
const timelineB = (await b.get("CommunityTweetsTimeline", { communityId: id, count: 20 })).data.communityResults.result;
check("a non-member can read the community page", tweetIds(entriesOf(timelineB.community_timeline.timeline)).includes(inPost.rest_id));

// joining
const joined = await b.gql("JoinCommunity", { communityId: id });
check("join an open community", joined.data?.community_join?.role === "Member" && joined.data.community_join.member_count === 2);
const memberPost = await b.gql("CreateTweet", { tweet_text: "member post", semantic_annotation_ids: annotation(id) });
check("a member can post", !!memberPost.data?.create_tweet);
const memberships = await b.get("CommunitiesMembershipsRecentQuery", {});
check("membership slice lists it", memberships.data.viewer.user_results.result.community_memberships_slice.items_results.some((x: any) => x.result.id_str === id));

// roles and moderation
const promoted = await a.gql("communityPeopleActionMenu_roleUpdate_Mutation", { communityId: id, userId: userB.rest_id, role: "Moderator" });
check("promote to moderator", promoted.data?.community_role_put?.moderator_count === 2);
const selfRole = await b.gql("communityPeopleActionMenu_roleUpdate_Mutation", { communityId: id, userId: userB.rest_id, role: "Member" });
check("a moderator can't change roles", !!selfRole.errors?.length);
const people = (await a.get("moderatorsSliceTimeline_Query", { communityId: id })).data.communityResults.result.moderators_slice.items_results;
check("moderators list", people.length === 2);
await a.gql("communityPeopleActionMenu_roleUpdate_Mutation", { communityId: id, userId: userB.rest_id, role: "Member" });

// rules and edits
const rule = await a.gql("CommunityCreateRule", { communityId: id, name: "Be kind", description: "no insults" });
check("create rule", rule.data?.community_rule_create?.rules?.length === 1);
const ruleId = rule.data?.community_rule_create?.rules?.[0]?.rest_id;
const upd = await a.gql("CommunityEditRule", { communityId: id, ruleId, name: "Be very kind", description: "x" });
check("edit rule", upd.data?.community_rule_update?.rules?.[0]?.name === "Be very kind");
const memberRule = await b.gql("CommunityCreateRule", { communityId: id, name: "mine", description: "" });
check("members can't create rules", !!memberRule.errors?.length);
await a.gql("CommunityRemoveRule", { communityId: id, ruleId });
const renamed = await a.gql("CommunityEditName", { communityId: id, name: `${name} 2` });
check("rename", renamed.data?.community_name_put?.name === `${name} 2`);
const purpose = await a.gql("CommunityEditPurpose", { communityId: id, description: "new purpose" });
check("edit purpose", purpose.data?.community_description_put?.description === "new purpose");

// leaving, then a restricted policy with requests
const left = await b.gql("LeaveCommunity", { communityId: id });
check("leave", left.data?.community_leave?.role === "NonMember");
const adminLeave = await a.gql("LeaveCommunity", { communityId: id });
check("the admin can't leave", !!adminLeave.errors?.length);
const policy = await a.gql("edit_membershipSettings_Mutation", { communityId: id, joinPolicy: "RestrictedJoinRequestsRequireAdminApproval", invitesPolicy: "AdminInvitesAllowed" });
check("restrict joining", policy.data?.community_membership_settings_put?.join_policy === "RestrictedJoinRequestsRequireAdminApproval");
const blocked = await b.gql("JoinCommunity", { communityId: id });
check("joining directly is refused", !!blocked.errors?.length);
const asked = await b.gql("RequestToJoinCommunity", { communityId: id, answer: "please" });
check("request to join", asked.data?.community_join_request_create?.__typename === "CommunityJoinRequest");
const pending = (await a.get("MemberRequests_Query", { communityId: id })).data.communityResults.result.join_requests_result;
check("admin sees the request", pending.pending_join_request_count === 1 && pending.pending_join_requests_slice.items[0].answer === "please");
const status = (await b.get("CommunityByRestId", { communityId: id })).data.communityResults.result;
check("requester sees a pending state", status.actions.join_action_result.reason === "ViewerRequestPending");
const approved = await a.gql("actions_approveMemberRequest_Mutation", { communityId: id, userId: userB.rest_id });
check("approve", approved.data?.community_join_request_approve?.state === "Approved");
const afterApprove = (await b.get("CommunityByRestId", { communityId: id })).data.communityResults.result;
check("requester is a member now", afterApprove.role === "Member");

// discovery and deletion
const mine = await a.get("CommunitiesMembershipsTimeline", { userId: (await a.get("UserByScreenName", { screen_name: nameA })).data.user.result.rest_id, count: 20 });
const items = entriesOf(mine.data.user.result.timeline.timeline).map((e) => e.content?.itemContent?.community_results?.result?.id_str);
check("memberships timeline", items.includes(id));
const notAdmin = await b.gql("DeleteCommunityMutation", { id, name: "x" });
check("only the admin deletes", !!notAdmin.errors?.length);
const deleted = await a.gql("DeleteCommunityMutation", { id, name });
check("delete", deleted.data?.community_delete?.__typename === "CommunityDeleteSuccess");
made.pop();
const gone = (await a.get("CommunityByRestId", { communityId: id })).data.communityResults.result;
check("deleted community is unavailable", gone.__typename === "CommunityUnavailable");
check("June 2022 gets a null community after deletion", (await a.get("PrimaryContentQuery", { communityId: id })).data?.community === null);

for (const m of made) await a.gql("DeleteCommunityMutation", { id: m, name: "x" });
for (const p of [inPost.rest_id, memberPost.data?.create_tweet?.tweet_results?.result?.rest_id].filter(Boolean)) {
	await a.gql("DeleteTweet", { tweet_id: p });
	await b.gql("DeleteTweet", { tweet_id: p });
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
