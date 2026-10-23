import { expect, test } from "bun:test";
import { headerParams, oauth1Token } from "../src/oauth1-header";

const req = (authorization?: string) => new Request("http://x/", authorization ? { headers: { authorization } } : {});

test("reads the fields of an OAuth header", () => {
	const r = req('OAuth oauth_consumer_key="ck", oauth_token="abc%2Fdef", oauth_signature="a%2Bb%3D", oauth_nonce="n"');
	expect(headerParams(r)).toEqual({ oauth_consumer_key: "ck", oauth_token: "abc/def", oauth_signature: "a+b=", oauth_nonce: "n" });
	expect(oauth1Token(r)).toBe("abc/def");
});

test("other schemes and missing headers name no token", () => {
	expect(oauth1Token(req())).toBeUndefined();
	expect(oauth1Token(req("Bearer xitter_abc"))).toBeUndefined();
	expect(oauth1Token(req('OAuth oauth_consumer_key="ck"'))).toBeUndefined();
});

test("a malformed header does not throw", () => {
	expect(() => oauth1Token(req('OAuth oauth_token="%E0%A4%A"'))).not.toThrow();
	expect(() => headerParams(req("OAuth ,,,==,"))).not.toThrow();
});
