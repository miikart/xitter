import type { User } from "./auth";

const FEATURE_NAMES = [
	"subscriptions_feature_article_composer",
	"subscriptions_feature_highlights",
	"subscriptions_feature_1002",
	"subscriptions_feature_account_analytics",
];
const features = Object.fromEntries(FEATURE_NAMES.map((name) => [name, { value: "true" }]));
const resources = FEATURE_NAMES.map((name) => ({ rest_id: `client_feature_switch/${name}/true` }));
const PREMIUM = "premium_standard";
const PREMIUM_CLAIM = "rogue-one-prod-2";

type ClaimUser = Pick<User, "verified_type"> | null;

export function initialUserClaims(user: ClaimUser) {
	const premium = user?.verified_type === "blue";
	return {
		config: { subscriptions: premium ? { [PREMIUM]: { value: "true" } } : {}, features },
		commerceSubscriptions: premium ? [PREMIUM] : [],
		debug: {},
		fetchStatus: "loaded",
	};
}

export function userClaims(user: ClaimUser) {
	return user?.verified_type === "blue"
		? [{ rest_id: PREMIUM_CLAIM, origin: "Commerce", resources }]
		: [{ rest_id: "xitter:features", resources }];
}

function premiumLink(key: string, heading: string, url: string, icon: string) {
	return {
		__typename: "PremiumHubConfigLinkBlock",
		__isPremiumHubConfigBlock: "PremiumHubConfigLinkBlock",
		key,
		heading,
		url,
		icon,
		color: null,
		link_block_type: null,
		pill: null,
		subtext: null,
	};
}

export function premiumHub(viewer: Pick<User, "verified_type" | "screen_name">) {
	const content = {
		page_title: "Premium",
		primary: [{
			key: "premium_tools",
			heading: { title: "Premium is active", button: null },
			blocks: [
				premiumLink("analytics", "Analytics", "/i/account_analytics", "BarChart"),
				premiumLink("articles", "Articles", "/i/articles", "WriteStroke"),
				premiumLink("highlights", "Highlights", `/${encodeURIComponent(viewer.screen_name)}/highlights`, "BookStrokeOn"),
			],
		}],
		secondary: [],
	};
	return { data: { premium_hub_config: viewer.verified_type === "blue" ? { content } : null } };
}
