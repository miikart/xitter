import { expect, test } from "bun:test";
import { patchFile } from "../src/patch";

const defaultAvatar = "/abs/sticky/default_profile_images/default_profile_normal.png";
const uploadedAvatar = "/profile_images/123/avatar_normal.jpg";
const defaultHeader = "https://abs.twimg.com/sticky/default_profile_images/default_profile_200x200.png";
const patch = (dir: string, bundle: string, source: string) =>
	patchFile(`/responsive-web/${dir}/${bundle}.avatar-fixture.js`, Buffer.from(source), true).toString();

test("the legacy profile header opts in to the exact 200px variant", () => {
	const result = patch("client-web-legacy", "bundle.UserProfile",
		'({size:"custom",uri:u,screenName:s.screen_name})');
	const profile = new Function("s", "u", `return ${result}`).bind(null, { screen_name: "profile" });
	expect(profile(uploadedAvatar)).toMatchObject({ uri: uploadedAvatar, xitterProfileAvatar: true });
});

test("the adaptive avatar renderer receives one 200px variant for the profile header", () => {
	const result = patch("client-web-legacy", "main",
		"function render(e,n){return {aspectMode:a.exact(e.aspectRatio),backgroundColor:e.backgroundColor||theme.colors.gray300,image:n,layoutCache:null}} const getAvatarStyles=null;");
	const render = new Function("a", "theme", `${result};return render;`)({ exact: () => 1 }, { colors: {} });
	for (const [uri, expected] of [[defaultAvatar, defaultHeader], ["https://miikart.co" + defaultAvatar, defaultHeader], [uploadedAvatar, uploadedAvatar.replace("_normal", "_200x200")]]) {
		expect(render({ xitterProfileAvatar: true }, uri)).toMatchObject({ image: uri, customVariants: [{ uri: expected, width: 200, height: 200 }] });
		expect(render({}, uri).customVariants).toBeUndefined();
	}
	expect(render({ xitterProfileAvatar: true }, undefined).customVariants).toBeUndefined();
});

test("the photo viewer uses the 400px source for the displayed and linked image", () => {
	const result = patch("client-web-legacy", "bundle.UserAvatar",
		"({mediaUrl:u&&u.profile_image_url_https,expanded_url:u.profile_image_url_https,media_url_https:u.profile_image_url_https})");
	const viewer = new Function("u", `return ${result}`);
	for (const uri of [defaultAvatar, uploadedAvatar]) {
		const url = uri.replace("_normal", "_400x400");
		expect(viewer({ profile_image_url_https: uri })).toEqual({ mediaUrl: url, expanded_url: url, media_url_https: url });
	}
});
