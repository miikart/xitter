import { join } from "node:path";

const [dir] = process.argv.slice(2);
if (!dir) throw new Error("usage: bun android/patch-6.17-push.ts <smali directory>");

const path = join(dir, "co/miikart/push/PushService.smali");
let service = await Bun.file(path).text();

function editMethod(name: string, change: (method: string) => string) {
	const pattern = new RegExp(`^\\.method [^\\r\\n]* ${name}\\([\\s\\S]*?^\\.end method`, "m");
	const before = service.match(pattern)?.[0];
	if (!before) throw new Error(`PushService: missing ${name}`);
	const after = change(before);
	if (after === before) throw new Error(`PushService: unexpected ${name}`);
	service = service.replace(pattern, () => after);
}

if (service.includes("->startForeground(ILandroid/app/Notification;)V")) {
	editMethod("channels", (method) => method.replace(/\n    \.line 29\b[\s\S]*?(?=\n    :cond_\w+)/, "\n"));
	editMethod("ensure", (method) => method.replace(
		/(    :try_start_\w+\n)[\s\S]*?(?=    invoke-virtual \{p0, v0\}, Landroid\/content\/Context;->startService)/,
		"$1",
	));
	editMethod("onCreate", (method) => method.replace(/\n    \.line 113\b[\s\S]*?(?=\n    return-void)/, "\n"));
	editMethod("onDestroy", (method) => method.replace(/    const\/4 v0, 0x1\n\n    invoke-virtual \{p0, v0\}, [^\n]+->stopForeground\(Z\)V\n\n/, ""));
	editMethod("onStartCommand", (method) => method.replace(/\n    \.line 123\b[\s\S]*?(?=\n    iget-object p1)/, "\n"));
	service = service.replace(/^\.field private static final (?:CONNECTION|SERVICE_ID):[^\n]+\n\n/gm, "");
	if (/->(?:startForegroundService|startForeground|stopForeground)\(|"Connected to your server"/.test(service)) {
		throw new Error("PushService: foreground connection notification still present");
	}
	await Bun.write(path, service);
}
