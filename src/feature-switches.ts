// Admin > Feature switches: the client's own switches (shell.ts switchReport),
// overridden for everyone from their next page load. An override applies to
// every build, or to one build of the library (Admin > Client) only.

import { type Action, AdminError, audit } from "./admin";
import { readStoredBuild } from "./client-update";
import { loadBuild } from "./build";
import { resetSwitchOverrides, setSetting, settings } from "./settings";
import { switchReport } from "./shell";

// the build a request is about: a library name, or none for the serving one
function buildOf(id: unknown) {
	if (id === undefined || id === null || id === "") return loadBuild()?.build;
	const build = typeof id === "string" ? readStoredBuild(id) : undefined;
	if (!build?.sha) throw new AdminError("That build isn't in the library.", 404);
	return build;
}

let pending: Promise<unknown> = Promise.resolve();
function updateSwitches<T>(write: () => Promise<T>) {
	const next = pending.then(write);
	pending = next.catch(() => {});
	return next;
}

export const switchActions: Record<string, Action> = {
	// the client's feature switches (shell.ts switchReport) of one build; an
	// override wins over the build and Xitter, from the next page load
	featureSwitches: {
		role: "admin",
		run: async (_a, b) => {
			const build = buildOf(b.build);
			const { switch_overrides, build_switch_overrides } = settings();
			return {
				sha: build?.sha ?? null,
				switches: switchReport(build),
				androidExperiments: settings().android_experiments,
				hasBuildOverrides: !!build && Object.keys(build_switch_overrides[build.sha] ?? {}).length > 0,
				hasOverrides: Object.keys(switch_overrides).length > 0 || Object.keys(build_switch_overrides).length > 0,
			};
		},
	},
	saveAndroidExperiments: {
		role: "admin",
		run: (a, b) => updateSwitches(async () => {
			const values = b.experiments;
			if (!values || typeof values !== "object" || Array.isArray(values)) throw new AdminError("Provide experiment names and their buckets.");
			const entries = Object.entries(values);
			const valid = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
			if (entries.length > 100 || entries.some(([name, bucket]) => !valid.test(name) || typeof bucket !== "string" || !valid.test(bucket)))
				throw new AdminError("Set up to 100 experiments. Names and buckets use letters, numbers, underscores, dots or hyphens.");
			const experiments = values as Record<string, string>;
			await setSetting("android_experiments", experiments);
			await audit(a, "save_android_experiments", null, { experiments });
			return {};
		}),
	},
	resetFeatureSwitches: {
		role: "admin",
		run: (a, b) => updateSwitches(async () => {
			if (b.build === undefined) await resetSwitchOverrides();
			else {
				const build = buildOf(b.build);
				if (!build) throw new AdminError("No client build is pinned.");
				const overrides = { ...settings().build_switch_overrides };
				delete overrides[build.sha];
				await setSetting("build_switch_overrides", overrides);
			}
			await audit(a, "reset_feature_switches", null, b.build === undefined ? { all: true } : { build: String(b.build) });
			return {};
		}),
	},
	setFeatureSwitch: {
		role: "admin",
		run: (a, b) => updateSwitches(async () => {
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
		}),
	},
};
