// Turns X's 2013 Android app (Twitter 4.1.9, unpacked with apktool) into a
// client of this instance. Safe to run twice.
// usage: HOST=miikart.co SCHEME=http bun android/patch-legacy.ts <apktool dir>
//
// 4.1.9 speaks v1.1 with xAuth and keeps its API host in res/values/strings.xml.
// It talks over Apache HttpClient with a trust store bundled in the app, so the
// instance's certificate is rejected unless the trust managers are replaced.

import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: HOST=miikart.co SCHEME=http bun android/patch-legacy.ts <apktool dir>");
const host = process.env.HOST ?? "miikart.co";
const scheme = process.env.SCHEME ?? "http";

const done: string[] = [];

async function edit(file: string, why: string, fn: (text: string) => string) {
	const path = join(dir, file);
	const text = await Bun.file(path).text();
	const next = fn(text);
	if (next === text) return;
	await Bun.write(path, next);
	done.push(why);
}

const swap = (text: string, from: string, to: string) => text.split(from).join(to);

await edit("res/values/strings.xml", `API host -> ${scheme}://${host}`, (t) =>
	t
		.replace(/(<string name="base_host">)[^<]*/, `$1${scheme}://${host}`)
		.replace(/(<string name="base_url">)[^<]*/, `$1${scheme}://${host}/1`)
		.replace(/(<string name="base_url_mobile">)[^<]*/, `$1${scheme}://${host}/mobile_client_api`)
		.replace(/(<string name="mobile_config_url">)[^<]*/, `$1${scheme}://${host}/i/config?client=android`),
);

// the OAuth realm and the analytics sink: neither should leave for twitter.com
for (const f of ["library/network/a", "library/scribe/ScribeService", "applib/client/a", "applib/widget/ScribeUrlPreference"]) {
	await edit(`smali/com/twitter/${f}.smali`, `${f}: twitter.com -> ${host}`, (t) => swap(swap(t, "http://api.twitter.com/", `${scheme}://${host}/`), "https://twitter.com/scribe", `${scheme}://${host}/scribe`));
}

// Trust. Both socket factories build their trust managers from the bundled
// keystore (and the pinned one adds X's pins); replace them with one that
// accepts the chain. The strict hostname check in the same class stays.
const trustAll = `.class public Lcom/twitter/library/network/ssl/TrustAll;
.super Ljava/lang/Object;
.implements Ljavax/net/ssl/X509TrustManager;

.method public constructor <init>()V
    .locals 0
    invoke-direct {p0}, Ljava/lang/Object;-><init>()V
    return-void
.end method

.method public checkClientTrusted([Ljava/security/cert/X509Certificate;Ljava/lang/String;)V
    .locals 0
    return-void
.end method

.method public checkServerTrusted([Ljava/security/cert/X509Certificate;Ljava/lang/String;)V
    .locals 0
    return-void
.end method

.method public getAcceptedIssuers()[Ljava/security/cert/X509Certificate;
    .locals 1
    const/4 v0, 0x0
    new-array v0, v0, [Ljava/security/cert/X509Certificate;
    return-object v0
.end method
`;
if (scheme === "https") {
const trustFile = join(dir, "smali/com/twitter/library/network/ssl/TrustAll.smali");
if (!(await Bun.file(trustFile).exists())) {
	await Bun.write(trustFile, trustAll);
	done.push("added TrustAll trust manager");
}

const accept = (m: string) => `.method private ${m}(Lcom/twitter/library/network/ssl/d;)[Ljavax/net/ssl/TrustManager;
    .locals 3
    const/4 v0, 0x1
    new-array v0, v0, [Ljavax/net/ssl/TrustManager;
    const/4 v1, 0x0
    new-instance v2, Lcom/twitter/library/network/ssl/TrustAll;
    invoke-direct {v2}, Lcom/twitter/library/network/ssl/TrustAll;-><init>()V
    aput-object v2, v0, v1
    return-object v0
.end method`;

await edit("smali/com/twitter/library/network/ssl/b.smali", "ssl: trust managers accept the instance's certificate", (t) => {
	let out = t;
	for (const m of ["a", "b"]) {
		const start = out.indexOf(`.method private ${m}(Lcom/twitter/library/network/ssl/d;)[Ljavax/net/ssl/TrustManager;`);
		if (start < 0) throw new Error(`ssl/b: no method ${m}`);
		const end = out.indexOf(".end method", start) + ".end method".length;
		out = out.slice(0, start) + accept(m) + out.slice(end);
	}
	return swap(out, 'const-string v1, "api.twitter.com"', `const-string v1, "${host}"`);
});
}

console.log(done.length ? `patched:\n  ${done.join("\n  ")}` : "already patched");
