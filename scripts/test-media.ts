// End-to-end check of uploads, photo posts and profile edits against a running
// server, the way the client calls them.
// usage: bun scripts/test-media.ts <user> <password> <image> [banner image]

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [user, password, imagePath, bannerPath] = process.argv.slice(2);
if (!user || !password || !imagePath) throw new Error("usage: bun scripts/test-media.ts <user> <password> <image> [banner image]");

const login = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: user, password }), redirect: "manual" });
const cookies = login.headers.getSetCookie().map((c) => c.split(";")[0]);
const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
if (!csrf) throw new Error(`login failed (${login.status})`);
const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

async function upload(path: string, category: string, chunks = 2): Promise<string> {
	const data = readFileSync(path);
	const type = path.endsWith(".png") ? "image/png" : path.endsWith(".gif") ? "image/gif" : "image/jpeg";
	const init = await fetch(`${origin}/i/media/upload.json?command=INIT&total_bytes=${data.length}&media_type=${type}&media_category=${category}`, {
		method: "POST",
		headers,
	});
	const { media_id_string: id } = await init.json();
	const size = Math.ceil(data.length / chunks);
	for (let i = 0; i < chunks; i++) {
		const form = new FormData();
		form.set("media", new Blob([data.subarray(i * size, (i + 1) * size)]));
		const r = await fetch(`${origin}/i/media/upload.json?command=APPEND&media_id=${id}&segment_index=${i}`, { method: "POST", headers, body: form });
		if (r.status !== 204) throw new Error(`APPEND ${i}: ${r.status} ${await r.text()}`);
	}
	const fin = await (await fetch(`${origin}/i/media/upload.json?command=FINALIZE&media_id=${id}`, { method: "POST", headers })).json();
	check(`upload ${path} (${category})`, fin.media_id_string === id && fin.image?.w > 0, fin.image);
	return id;
}

const gql = async (op: string, variables: object) =>
	(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();

const photo = await upload(imagePath, "tweet_image");
const created = await gql("CreateTweet", { tweet_text: "", media: { media_entities: [{ media_id: photo, tagged_users: [] }], possibly_sensitive: false } });
const post = created.data?.create_tweet?.tweet_results?.result;
const media = post?.legacy?.extended_entities?.media?.[0];
check("photo-only post", media?.id_str === photo, { type: media?.type, size: media?.original_info, url: media?.media_url_https });

const file = await fetch(media.media_url_https, { headers });
check("photo is served to a signed-in user", file.status === 200 && !!file.headers.get("content-type")?.startsWith("image/"), `${file.status} ${file.headers.get("content-type")}`);
check("photo is hidden from visitors", (await fetch(media.media_url_https)).status === 404);
const stolen = await gql("CreateTweet", { tweet_text: "reuse", media: { media_entities: [{ media_id: photo }] } });
check("an upload cannot be attached twice", !stolen.data?.create_tweet?.tweet_results?.result?.legacy?.extended_entities);
for (const id of [post?.rest_id, stolen.data?.create_tweet?.tweet_results?.result?.rest_id]) if (id) await gql("DeleteTweet", { tweet_id: id });

// alt text and the sensitive flag travel with the post
const described = await upload(imagePath, "tweet_image");
await fetch(`${origin}/i/api/1.1/media/metadata/create.json`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ media_id: described, alt_text: { text: "a test pattern" } }) });
const flagged = await gql("CreateTweet", { tweet_text: "", media: { media_entities: [{ media_id: described, tagged_users: [] }], possibly_sensitive: true } });
const flaggedPost = flagged.data?.create_tweet?.tweet_results?.result;
check("alt text comes back on the media", flaggedPost?.legacy?.extended_entities?.media?.[0]?.ext_alt_text === "a test pattern");
check("the sensitive flag is kept", flaggedPost?.legacy?.possibly_sensitive === true);
// a content warning set on the media (the composer's flag tab)
const warned = await upload(imagePath, "tweet_image");
await fetch(`${origin}/i/api/1.1/media/metadata/create.json`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ media_id: warned, sensitive_media_warning: ["adult_content"] }) });
const warnedPost = (await gql("CreateTweet", { tweet_text: "", media: { media_entities: [{ media_id: warned, tagged_users: [] }], possibly_sensitive: false } })).data?.create_tweet?.tweet_results?.result;
check("a content warning makes the post sensitive", warnedPost?.legacy?.possibly_sensitive === true);
check("and is reported on the media", warnedPost?.legacy?.extended_entities?.media?.[0]?.sensitive_media_warning?.adult_content === true);
if (warnedPost?.rest_id) await gql("DeleteTweet", { tweet_id: warnedPost.rest_id });

if (flaggedPost?.rest_id) await gql("DeleteTweet", { tweet_id: flaggedPost.rest_id });
const avatar = await upload(imagePath, "profile_image", 1);
const a = await (await fetch(`${origin}/i/api/1.1/account/update_profile_image.json`, { method: "POST", headers, body: new URLSearchParams({ media_id: avatar, return_user: "true" }) })).json();
check("avatar set", String(a.profile_image_url_https).includes(avatar), a.profile_image_url_https);
// an animated GIF avatar the way the patched client sends one: whole, with
// the crop box after the trailer (patch.ts)
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const ffprobe = process.env.FFPROBE ?? "ffprobe";
const dir = mkdtempSync(join(tmpdir(), "xitter-gif-"));
const wide = join(dir, "wide.jpg");
if (Bun.spawnSync([ffmpeg, "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1800x900", "-frames:v", "1", "-q:v", "2", "-threads", "1", wide]).exitCode === 0) {
	const avatarId = await upload(wide, "profile_image", 1);
	const storedAvatar = await fetch(`${origin}/media/${avatarId}?name=orig`, { headers });
	const storedBytes = Buffer.from(await storedAvatar.arrayBuffer());
	const storedSize = Bun.spawnSync([ffprobe, "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", "pipe:0"], { stdin: storedBytes });
	check("an avatar upload stores a 400x400 image", storedAvatar.ok && storedSize.stdout.toString().trim() === "400x400", storedSize.stdout.toString().trim());
	const id = await upload(wide, "tweet_image", 1);
	const apply = (kind: string) => fetch(`${origin}/i/api/1.1/account/update_profile_${kind}.json`, {
		method: "POST", headers, body: new URLSearchParams({ media_id: id }),
	});
	const a = await (await apply("image")).json();
	const b = await (await apply("banner")).json();
	const avatarUrl = String(a.profile_image_url_https);
	check("profile reports the normal avatar path", new URL(avatarUrl).pathname === `/profile_images/${id}/avatar_normal.jpg`, avatarUrl);
	const source = await fetch(`${origin}/media/${id}?name=orig`, { headers });
	const original = await source.arrayBuffer();
	const variants = [["mini", 24], ["normal", 48], ["bigger", 73], ["reasonably_small", 128], ["200x200", 200], ["400x400", 400]] as const;
	for (const [url, expected] of [
		...variants.map(([name, side]) => [avatarUrl.replace("_normal", `_${name}`), `${side}x${side}`]),
		[b.profile_banner_url, "1500x500"], [`${b.profile_banner_url}/300x100`, "300x100"],
	]) {
		const res = await fetch(url, { headers });
		const bytes = Buffer.from(await res.arrayBuffer());
		const probe = Bun.spawnSync([ffprobe, "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", "pipe:0"], { stdin: bytes });
		check(`profile image serves ${expected}`, res.ok && probe.stdout.toString().trim() === expected, probe.stdout.toString().trim());
		check(`profile image ${expected} is smaller than the original`, bytes.length < original.byteLength);
		const etag = res.headers.get("etag");
		const cached = etag && await fetch(url, { headers: { ...headers, "if-none-match": etag } });
		check(`profile image ${expected} revalidates`, !!cached && cached.status === 304);
	}
}
const gifPath = join(dir, "anim.gif");
if (Bun.spawnSync([ffmpeg, "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=60x40:rate=5", "-t", "1", gifPath]).exitCode !== 0) {
	console.log("skip animated GIF avatar checks: no ffmpeg");
} else {
	const frames = (file: string) =>
		Number(Bun.spawnSync([ffprobe, "-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file]).stdout.toString().trim());
	const gif = readFileSync(gifPath);
	writeFileSync(join(dir, "crop.gif"), Buffer.concat([gif, Buffer.from("xitter-crop:10,5,30,30")]));
	writeFileSync(join(dir, "full.gif"), Buffer.concat([gif, Buffer.from("xitter-crop:0,0,60,40")]));
	const cropped = await upload(join(dir, "crop.gif"), "avatar_image", 2);
	const g = await (await fetch(`${origin}/i/api/1.1/account/update_profile_image.json`, { method: "POST", headers, body: new URLSearchParams({ media_id: cropped }) })).json();
	const served = await fetch(String(g.profile_image_url_https), { headers });
	const body = Buffer.from(await served.arrayBuffer());
	writeFileSync(join(dir, "served.gif"), body);
	check("GIF avatar is served as a GIF", served.headers.get("content-type") === "image/gif", served.headers.get("content-type"));
	check("GIF avatar is cropped to the box", body.readUInt16LE(6) === 30 && body.readUInt16LE(8) === 30, [body.readUInt16LE(6), body.readUInt16LE(8)]);
	check("GIF avatar keeps its frames", frames(join(dir, "served.gif")) === frames(gifPath), [frames(join(dir, "served.gif")), frames(gifPath)]);
	const full = await upload(join(dir, "full.gif"), "avatar_image", 1);
	const kept = Buffer.from(await (await fetch(`${origin}/media/${full}`, { headers })).arrayBuffer());
	check("an uncropped GIF is stored as it was sent, minus the crop box", kept.equals(gif), [kept.length, gif.length]);
}
rmSync(dir, { recursive: true, force: true });
if (bannerPath) {
	const banner = await upload(bannerPath, "banner_image", 3);
	const b = await (await fetch(`${origin}/i/api/1.1/account/update_profile_banner.json`, { method: "POST", headers, body: new URLSearchParams({ media_id: banner }) })).json();
	check("banner set", String(b.profile_banner_url).includes(banner), b.profile_banner_url);
	check("banner answers with a size suffix", (await fetch(`${b.profile_banner_url}/1500x500`, { headers })).status === 200);
}
const p = await (await fetch(`${origin}/i/api/1.1/account/update_profile.json`, {
	method: "POST",
	headers,
	body: new URLSearchParams({ description: "testing xitter", location: "Kyiv", url: "https://example.org" }),
})).json();
check("profile text updated", p.description === "testing xitter" && p.location === "Kyiv" && p.url === "https://example.org", { description: p.description, location: p.location, url: p.url });
const tooLong = await fetch(`${origin}/i/api/1.1/account/update_profile.json`, { method: "POST", headers, body: new URLSearchParams({ description: "x".repeat(161) }) });
check("161-character bio is refused", tooLong.status === 403);
const notImage = await fetch(`${origin}/i/media/upload.json?command=INIT&total_bytes=10&media_type=application/pdf&media_category=tweet_image`, { method: "POST", headers });
check("other file types are refused", notImage.status === 400);

console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
