// A community as the client reads it (the fields of CommunitiesFetchOneQuery).
// Kept apart from the handlers because posts.ts attaches it to every post.

import { absolute } from "./media";
import { sql } from "./db";
import { userResult } from "./model";
import { usersByIds } from "./users";

export type Role = "NonMember" | "Member" | "Moderator" | "Admin";

export const JOIN_POLICIES = [
	"Open",
	"RestrictedJoinRequestsRequireModeratorApproval",
	"RestrictedJoinRequestsRequireAdminApproval",
	"RestrictedJoinRequestsDisabled",
] as const;
export const INVITE_POLICIES = ["MemberInvitesAllowed", "ModeratorInvitesAllowed", "AdminInvitesAllowed"] as const;

const globalId = (kind: string, id: string) => Buffer.from(`${kind}:${id}`).toString("base64");

export const communityGlobalId = (id: string) => globalId("Community", id);

const BANNER = {
	media_info: {
		__typename: "ApiImage",
		original_img_url: "/public/list-banner.svg",
		original_img_width: 1500,
		original_img_height: 500,
		color_info: { palette: [{ percentage: 100, rgb: { red: 83, green: 100, blue: 113 } }] },
	},
};

const UNAVAILABLE_USER = { __typename: "UserUnavailable", reason: "Unavailable", unavailable_reason: "Unavailable", message: "This account is unavailable." };

type CommunityRow = {
	id: string;
	creator_id: string;
	name: string;
	description: string;
	question: string;
	join_policy: string;
	invites_policy: string;
	is_nsfw: boolean;
	banner_url: string | null;
	banner_width: number | null;
	banner_height: number | null;
	topic_id: string | null;
	topic_name: string | null;
	created_at: Date;
	member_count: number;
	moderator_count: number;
	pending_join_request_count: number;
	role: Role;
	requested: boolean;
};

export const canModerate = (role: Role) => role === "Moderator" || role === "Admin";

const rolesRank: Record<Role, number> = { NonMember: 0, Member: 1, Moderator: 2, Admin: 3 };
export const atLeast = (role: Role, min: Role) => rolesRank[role] >= rolesRank[min];

export async function communityRows(viewerId: string, ids: string[]): Promise<Map<string, CommunityRow>> {
	if (!ids.length) return new Map();
	const rows = await sql`select c.id::text, c.creator_id::text, c.name, c.description, c.question, c.join_policy, c.invites_policy, c.is_nsfw, c.banner_url, c.banner_width, c.banner_height, c.created_at,
			c.topic_id::text as topic_id, (select t.name from topics t where t.id = c.topic_id) as topic_name,
			(select count(*)::int from community_members m where m.community_id = c.id) as member_count,
			(select count(*)::int from community_members m where m.community_id = c.id and m.role in ('Moderator', 'Admin')) as moderator_count,
			(select count(*)::int from community_join_requests r where r.community_id = c.id) as pending_join_request_count,
			coalesce((select m.role from community_members m where m.community_id = c.id and m.user_id = ${viewerId}::bigint), 'NonMember') as role,
			exists (select 1 from community_join_requests r where r.community_id = c.id and r.user_id = ${viewerId}::bigint) as requested
		from communities c where c.id = any(${sql.array(ids, "INT8")})`;
	return new Map(rows.map((r: any) => [r.id as string, r as CommunityRow]));
}

function actions(row: CommunityRow) {
	const unavailable = (type: string, reason: string, message: string) => ({ __typename: type, reason, message });
	const member = row.role !== "NonMember";
	const join = member
		? unavailable("CommunityJoinActionUnavailable", "ViewerAlreadyMember", "You're already a member.")
		: row.join_policy === "Open"
			? { __typename: "CommunityJoinAction" }
			: unavailable("CommunityJoinActionUnavailable", row.requested ? "ViewerRequestPending" : "ViewerJoinRequestRequired", row.requested ? "Your request is pending." : "Request to join this community.");
	const leave = !member
		? unavailable("CommunityLeaveActionUnavailable", "ViewerNotMember", "You're not a member.")
		: row.role === "Admin"
			? unavailable("CommunityLeaveActionUnavailable", "ViewerIsAdmin", "Admins can't leave their community.")
			: { __typename: "CommunityLeaveAction" };
	const del = row.role === "Admin" ? { __typename: "CommunityDeleteAction" } : unavailable("CommunityDeleteActionUnavailable", "ViewerNotAdmin", "Only the admin can delete this community.");
	return {
		delete_action_result: del,
		join_action_result: join,
		leave_action_result: leave,
		pin_action_result: { __typename: "CommunityTweetPinActionUnavailable", reason: "NotSupported", message: "Pinning isn't available." },
	};
}

// full objects for the given ids, in the same viewer's terms
export async function communityObjects(viewerId: string, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
	const rows = await communityRows(viewerId, ids);
	if (!rows.size) return new Map();
	const list = [...rows.keys()];
	const ruleRows = await sql`select id::text, community_id::text, name, description from community_rules
		where community_id = any(${sql.array(list, "INT8")}) order by position, id`;
	const faceRows = await sql`select community_id::text, user_id::text from (
			select m.community_id, m.user_id, row_number() over (partition by m.community_id order by m.created_at) as n
			from community_members m where m.community_id = any(${sql.array(list, "INT8")})) x where n <= 3`;
	const userIds = new Set<string>();
	for (const r of rows.values()) userIds.add(r.creator_id);
	for (const f of faceRows) userIds.add(f.user_id);
	const users = await usersByIds(viewerId, [...userIds]);
	const out = new Map<string, Record<string, unknown>>();
	for (const [id, r] of rows) {
		const creator = users.get(r.creator_id);
		const creatorResults = { result: creator ? userResult(creator) : UNAVAILABLE_USER };
		const faces = faceRows.filter((f: any) => f.community_id === id).flatMap((f: any) => (users.has(f.user_id) ? [{ result: userResult(users.get(f.user_id)!) }] : []));
		const banner = r.banner_url
			? {
					media_info: {
						__typename: "ApiImage",
						original_img_url: absolute(r.banner_url),
						original_img_width: r.banner_width ?? 1500,
						original_img_height: r.banner_height ?? 500,
						// the header ignores a custom banner without a palette (it tints the page with it)
						color_info: { palette: [{ percentage: 100, rgb: { red: 83, green: 100, blue: 113 } }] },
					},
				}
			: null;
		out.set(id, {
			__typename: "Community",
			id: communityGlobalId(id),
			id_str: id,
			rest_id: id,
			// Relay reads a response by the query's aliases; the tools screen asks
			// for rest_id as communityId, and without it every tools link says null
			communityId: id,
			name: r.name,
			description: r.description,
			created_at: new Date(r.created_at).getTime(),
			question: r.question || null,
			search_tags: [],
			is_nsfw: r.is_nsfw,
			default_theme: "Default",
			custom_theme: null,
			primary_community_topic: r.topic_id && r.topic_name ? { __typename: "CommunityTopicPair", topic_id: r.topic_id, topic_name: r.topic_name } : null,
			actions: actions(r),
			admin_results: creatorResults,
			creator_results: creatorResults,
			invites_result: { __typename: "CommunityInvitesUnavailable", reason: "ViewerNotAllowed", message: "Invites aren't available here." },
			join_policy: r.join_policy,
			invites_policy: r.invites_policy,
			is_pinned: false,
			moderation: { __typename: "CommunityModeration", id: globalId("CommunityModeration", id), tweet_case_count: 0, count: 0 },
			trending_hashtags_slice: { __typename: "CommunityHashtagSlice", items: [] },
			members_facepile_results: faces,
			moderator_count: r.moderator_count,
			member_count: r.member_count,
			role: r.role,
			rules: ruleRows.filter((x: any) => x.community_id === id).map((x: any) => ({ __typename: "CommunityRule", id: globalId("CommunityRule", x.id), rest_id: x.id, name: x.name, description: x.description })),
			custom_banner_media: banner,
			default_banner_media: BANNER,
			viewer_relationship: { __typename: "UserCommunityRelationship", moderation_state: { __typename: "CommunityUserNotRemovedModerationState" } },
			join_requests_result: canModerate(r.role)
				? { __typename: "CommunityJoinRequests", id: globalId("CommunityJoinRequests", id), pending_join_request_count: r.pending_join_request_count }
				: { __typename: "CommunityJoinRequestsUnavailable" },
		});
	}
	return out;
}
