// Admin > Feature switches: the client's own switches (shell.ts switchReport),
// overridden for everyone from their next page load. An override applies to
// every build, or to one build of the library (Admin > Client) only.

import { type Action, AdminError, audit } from "./admin";
import { readStoredBuild } from "./client-update";
import { loadBuild } from "./build";
import { setSetting, settings } from "./settings";
import { switchReport } from "./shell";

// the build a request is about: a library name, or none for the serving one
function buildOf(id: unknown) {
	if (id === undefined || id === null || id === "") return loadBuild()?.build;
	const build = typeof id === "string" ? readStoredBuild(id) : undefined;
	if (!build?.sha) throw new AdminError("That build isn't in the library.", 404);
	return build;
}

export const switchActions: Record<string, Action> = {
	// the client's feature switches (shell.ts switchReport) of one build; an
	// override wins over the build and Xitter, from the next page load
	featureSwitches: {
		role: "admin",
		run: async (_a, b) => {
			const build = buildOf(b.build);
			return { sha: build?.sha ?? null, switches: switchReport(build) };
		},
	},
	setFeatureSwitch: {
		role: "admin",
		run: async (a, b) => {
			const name = String(b.name ?? "");
			if (!/^[A-Za-z0-9_.-]{1,120}$/.test(name)) throw new AdminError("That isn't a switch name.");
			// scope: every build (no `build`), or one build's own override
			const scoped = b.build !== undefined && b.build !== null && b.build !== "";
			const sha = scoped ? buildOf(b.build)?.sha : undefined;
			const overrides = scoped ? { ...(settings().build_switch_overrides[sha!] ?? {}) } : { ...settings().switch_overrides };
			if (b.reset) delete overrides[name];
			else {
				const v = b.value;
				const ok = typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) || (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number"));
				if (!ok || JSON.stringify(v).length > 10_000) throw new AdminError("A switch is true/false, a number, text or a list.");
				overrides[name] = v;
			}
			if (scoped) {
				const all = { ...settings().build_switch_overrides };
				if (Object.keys(overrides).length) all[sha!] = overrides;
				else delete all[sha!];
				await setSetting("build_switch_overrides", all);
			} else await setSetting("switch_overrides", overrides);
			await audit(a, "set_feature_switch", null, { name, ...(scoped ? { build: String(b.build) } : {}), ...(b.reset ? { reset: true } : { value: b.value }) });
			return {};
		},
	},
};
