import assert from "node:assert/strict";
import { adminApi } from "../src/admin";
import type { Viewer } from "../src/auth";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { oauth1Route } from "../src/oauth1";
import { loadSettings } from "../src/settings";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const id = newId();
const viewer = { id, role: "admin", csrf: "experiment-fixture" } as Viewer;
const selfRetweet = "android_self_qt_rt_4499";
const url = new URL("https://example.com/1.1/help/settings.json");
const android = "TwitterAndroid/6.17.0 (24)";
const config = async (agent: string) => {
	const response = await oauth1Route(new Request(url, { headers: { "user-agent": agent } }), url);
	assert.equal(response?.headers.get("cache-control"), "no-store");
	return response!.json();
};

function admin(action: string, body: unknown, actor = viewer) {
	const req = new Request(`https://example.com/admin/api/${action}`, {
		method: "POST",
		headers: { "x-csrf-token": viewer.csrf, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return adminApi(req, action, actor);
}

const [previous] = await sql`select value from settings where key = 'android_experiments'`;
try {
	await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${`andro_${id.slice(-8)}`}, 'Android config admin fixture', '!')`;
	const experiments = { [selfRetweet]: "self_qt_rt", another_experiment: "treatment" };

	assert.deepEqual((await config(android)).config, {});
	assert.equal((await admin("saveAndroidExperiments", { experiments }, { ...viewer, role: "moderator" })).status, 403);
	assert.equal((await admin("saveAndroidExperiments", { experiments: { [selfRetweet]: true } })).status, 400);
	assert.equal((await admin("saveAndroidExperiments", { experiments })).status, 200);
	assert.deepEqual((await config(android)).config, { [selfRetweet]: { value: "self_qt_rt" }, another_experiment: { value: "treatment" } });
	assert.deepEqual(await config("TwitterAndroid/4.1.9"), {});

	await loadSettings();
	const view = await admin("featureSwitches", {});
	assert.equal(view.status, 200);
	assert.deepEqual((await view.json()).androidExperiments, experiments);
	assert.equal((await admin("saveAndroidExperiments", { experiments: { [selfRetweet]: "control" } })).status, 200);
	assert.deepEqual((await config(android)).config, { [selfRetweet]: { value: "control" } });
} finally {
	if (previous) await sql`update settings set value = ${JSON.stringify(previous.value)}::text::jsonb where key = 'android_experiments'`;
	else await sql`delete from settings where key = 'android_experiments'`;
	await sql`delete from audit_log where actor_id = ${id}::bigint`;
	await sql`delete from users where id = ${id}::bigint`;
	await sql.close();
}
