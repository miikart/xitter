import { expect, test } from "bun:test";

const source = await Bun.file(new URL("../src/admin.html", import.meta.url)).text();
const pages = source.slice(source.indexOf("const PAGES = "), source.indexOf("\nconst GROUPS = "));
const search = source.slice(source.indexOf("function adminSearchMatches("), source.indexOf("function tableSearch("));
const { PAGES, adminSearchMatches, initNavSearch } = new Function(pages + search + "return { PAGES, adminSearchMatches, initNavSearch };")();

test("admin search finds pages by title and by settings inside a page", () => {
	expect(adminSearchMatches(PAGES["settings-branding"], " BRAND ")).toBe(true);
	expect(adminSearchMatches(PAGES.switches, "experiments android")).toBe(true);
	expect(adminSearchMatches(PAGES.users, "android")).toBe(false);
});

test("admin search filters the links the viewer can navigate to", () => {
	const form = { hidden: true, addEventListener() {} };
	let update = () => {};
	const input = { value: "", addEventListener: (event: string, handler: () => void) => { if (event === "input") update = handler; } };
	const empty = { hidden: true };
	const users = { dataset: { page: "users" }, hidden: false };
	const group = { hidden: false, querySelectorAll: () => [users] };
	const nodes: Record<string, unknown> = { ".nav-search": form, "#nav-search": input, ".nav-search-empty": empty };
	const clear = initNavSearch({
		querySelector: (selector: string) => nodes[selector],
		querySelectorAll: () => [group],
		classList: { toggle() {} },
	});
	expect(form.hidden).toBe(false);
	input.value = "android";
	update();
	expect([users.hidden, group.hidden, empty.hidden]).toEqual([true, true, false]);
	clear();
	expect([input.value, users.hidden, group.hidden, empty.hidden]).toEqual(["", false, false, true]);
});
