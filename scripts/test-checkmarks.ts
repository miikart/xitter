// Who wears a checkmark (model.ts isVerified): an account with a badge of its
// own, and an organisation's affiliate while affiliate_checkmarks is on.
import { afterEach, expect, test } from "bun:test";
import type { User } from "../src/auth";
import { isVerified, userResult, verifiedSince } from "../src/model";
import { settings } from "../src/settings";
import { initialUserClaims, premiumHub, userClaims } from "../src/user-claims";

const org = { screen_name: "acme", name: "Acme", avatar_url: null, since: "2026-01-02T00:00:00Z" };
const person = (extra: Partial<User> = {}) => ({ id: "1", screen_name: "jo", name: "Jo", verified_type: null, created_at: new Date("2024-01-01T00:00:00Z"), ...extra }) as User;

afterEach(() => {
	settings().features.affiliate_checkmarks = true;
});

test("affiliates get a checkmark by default", () => {
	const u = person({ org } as Partial<User>);
	expect(isVerified(u)).toBe(true);
	expect(verifiedSince(u)?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
});

test("with affiliate checkmarks off, an affiliate has none", () => {
	settings().features.affiliate_checkmarks = false;
	const u = person({ org } as Partial<User>);
	expect(isVerified(u)).toBe(false);
	expect(verifiedSince(u)).toBe(null);
	expect(userResult(u).is_blue_verified).toBe(false);
});

test("with affiliate checkmarks off, an affiliate's own badge still shows", () => {
	settings().features.affiliate_checkmarks = false;
	const u = person({ org, verified_type: "blue", verified_at: "2025-05-05T00:00:00Z" } as Partial<User>);
	expect(isVerified(u)).toBe(true);
	expect(verifiedSince(u)?.toISOString()).toBe("2025-05-05T00:00:00.000Z");
	expect(JSON.stringify(userResult(u).verification_info)).not.toContain("affiliate of");
});

test("a blue badge grants standard Premium at boot and on claim refresh", () => {
	const blue = person({ verified_type: "blue" });
	expect(initialUserClaims(blue).config.subscriptions).toEqual({ premium_standard: { value: "true" } });
	expect(initialUserClaims(blue).commerceSubscriptions).toEqual(["premium_standard"]);
	expect(userClaims(blue)[0]).toMatchObject({ rest_id: "rogue-one-prod-2", origin: "Commerce" });
	for (const other of [person(), person({ org }), person({ verified_type: "business" }), person({ verified_type: "government" }), null]) {
		expect(initialUserClaims(other).commerceSubscriptions).toEqual([]);
		expect(userClaims(other)[0].rest_id).toBe("xitter:features");
	}
});

test("the Premium hub links to local tools for an account with a blue badge", () => {
	const hub = premiumHub(person({ verified_type: "blue" })).data.premium_hub_config;
	expect(hub?.content.primary[0].blocks.map((block) => block.url)).toEqual(["/i/account_analytics", "/i/articles", "/jo/highlights"]);
	expect(premiumHub(person()).data.premium_hub_config).toBeNull();
});
