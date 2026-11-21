// Push encryption against RFC 8291's worked example (Appendix A).
// usage: bun test ./scripts/test-push-crypto.ts

import { expect, test } from "bun:test";
import { encryptPayload, pushAppearance } from "../src/push";
import { settings } from "../src/settings";

const b = (s: string) => Buffer.from(s, "base64url");

test("RFC 8291 Appendix A", () => {
	const out = encryptPayload(Buffer.from("When I grow up, I want to be a watermelon"), b("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"), b("BTBZMqHH6r4Tts7J_aSIgg"), {
		privateKey: b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
		salt: b("DGv6ra1nlYgDCS1FRnbzlw"),
	});
	expect(out.toString("base64url")).toBe(
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
	);
});

test("push uses the signed-in app's name and icon", () => {
	const x = pushAppearance("x");
	expect(x.title).toBe("X");
	expect(new URL(x.icon).pathname).toBe("/public/original-x-app-icon.png");
	expect(x.badge).toBeUndefined();
	const twitter = pushAppearance("twitter");
	expect(twitter.title).toBe("Twitter");
	expect(new URL(twitter.icon).pathname).toBe("/public/original-twitter-app-icon.png");
	expect(twitter.badge).toBeUndefined();
	const instance = pushAppearance(null);
	expect(instance.title).toBe(settings().instance_name);
	expect(new URL(instance.icon).pathname).toBe("/public/app-icon.png");
	expect(new URL(instance.badge!).pathname).toBe("/public/notification-badge.png");
});
