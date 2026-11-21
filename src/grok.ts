import Anthropic from "@anthropic-ai/sdk";
import type { Viewer } from "./auth";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { isId, newId } from "./ids";
import { hit, limitedResponse } from "./ratelimit";
import { feature, settings } from "./settings";

const FAKE = process.env.GROK_FAKE === "1";
const BEE_URL = process.env.BEE_URL?.trim().replace(/\/+$/, "");
const CLAUDE_READY = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
let client: Anthropic | undefined;

export class GrokError extends Error {}

const MAX_INPUT = 8000;
const HISTORY = 20;

export function grokReady(): boolean {
	return feature("grok") && !!(FAKE || BEE_URL || CLAUDE_READY);
}

async function ownConversation(viewer: Viewer, id: unknown) {
	if (!isId(id)) return undefined;
	const [c] = await sql`select id::text, title, pinned, created_at from grok_conversations where id = ${id}::bigint and user_id = ${viewer.id}::bigint`;
	return c as { id: string; title: string; pinned: boolean; created_at: Date } | undefined;
}

const conversationEntry = (c: any) => ({
	grokConversation: { id: Buffer.from(`GrokConversation:${c.id}`).toString("base64"), rest_id: c.id },
	title: c.title || "New chat",
	is_pinned: !!c.pinned,
	created_at_ms: new Date(c.updated_at ?? c.created_at).getTime(),
});

async function history(viewer: Viewer, pinnedOnly: boolean) {
	const rows = await sql`select id::text, title, pinned, created_at, updated_at from grok_conversations
		where user_id = ${viewer.id}::bigint and (${!pinnedOnly} or pinned) and exists (select 1 from grok_items i where i.conversation_id = grok_conversations.id)
		order by updated_at desc limit 100`;
	return { cursor: null, items: rows.map(conversationEntry) };
}

async function setPinned(viewer: Viewer, vars: any, pinned: boolean) {
	const id = vars?.conversationId ?? vars?.restId ?? vars?.conversation_id;
	if (isId(id)) await sql`update grok_conversations set pinned = ${pinned} where id = ${id}::bigint and user_id = ${viewer.id}::bigint`;
	return { data: {} };
}

const gate = () => {
	if (!grokReady()) throw new GrokError("Grok is unavailable on this instance.");
};

export const grokHandlers = {
	CreateGrokConversation: async (viewer: Viewer) => {
		gate();
		const id = newId();
		await sql`insert into grok_conversations (id, user_id) values (${id}::bigint, ${viewer.id}::bigint)`;
		return { data: { create_grok_conversation: { conversation_id: id } } };
	},
	GrokHome: () => ({
		data: {
			grok_home: {
				default_grok_mode: "Regular",
				default_grok_model_option_id: "xitter",
				grok_model_options: [{ id: "xitter", name: BEE_URL ? "GBee" : "Grok", description: BEE_URL ? "Buzz" : "Claude" }],
				free_access_enabled: grokReady(),
				ineligible_reasons: grokReady() ? [] : ["Disabled"],
			},
		},
	}),
	GrokHistory: async (viewer: Viewer) => ({ data: { grok_conversation_history: await history(viewer, false) } }),
	GrokPinnedConversations: async (viewer: Viewer) => ({ data: { grok_pinned_conversations: await history(viewer, true) } }),
	GrokMediaHistory: () => ({ data: { grok_media_history: { cursor: null, items: [] } } }),
	GrokConversationItemsByRestId: async (viewer: Viewer, vars: any) => {
		const c = await ownConversation(viewer, vars?.restId);
		if (!c) return { data: { grok_conversation_items_by_rest_id: { items: [], cursor: null } } };
		const rows = await sql`select id::text, sender, message, created_at from grok_items where conversation_id = ${c.id}::bigint order by id desc limit 200`;
		return {
			data: {
				grok_conversation_items_by_rest_id: {
					cursor: null,
					is_pinned: c.pinned,
					items: rows.map((r: any) => ({ chat_item_id: r.id, message: r.message, sender_type: r.sender, created_at_ms: new Date(r.created_at).getTime(), is_partial: false, grok_mode: "Normal" })),
				},
			},
		};
	},
	ClearGrokConversations: async (viewer: Viewer) => {
		await sql`delete from grok_conversations where user_id = ${viewer.id}::bigint`;
		return { data: { clear_grok_conversations: {} } };
	},
	DeleteGrokMessage: async (viewer: Viewer, vars: any) => {
		const { conversation_id, chat_item_id } = vars;
		if (isId(conversation_id) && isId(chat_item_id))
			await sql`delete from grok_items i using grok_conversations c
				where i.id = ${chat_item_id}::bigint and i.conversation_id = c.id
				and c.id = ${conversation_id}::bigint and c.user_id = ${viewer.id}::bigint`;
		return { data: {} };
	},
	GrokPinConversation: (viewer: Viewer, vars: any) => setPinned(viewer, vars, true),
	GrokUnpinConversation: (viewer: Viewer, vars: any) => setPinned(viewer, vars, false),
	SetGrokPreferences: () => ({ data: {} }),
	GrokUserEventsLog: () => ({ data: {} }),
	GrokShare: () => ({ data: {} }),
};

const DEFAULT_PROMPT = [
	"You are Grok on {instance} ({origin}), a small Twitter-like social network.",
	"Answer concisely in plain language.",
	"Reply in the language the person writes in. Use markdown sparingly.",
].join("\n");

const systemPrompt = () => DEFAULT_PROMPT.replaceAll("{instance}", settings().instance_name).replaceAll("{origin}", PUBLIC_ORIGIN);

async function* claudeBrain(turns: { role: "user" | "assistant"; content: string }[], signal: AbortSignal): AsyncGenerator<string> {
	const c = client ??= new Anthropic();
	const stream = c.messages.stream({ model: process.env.GROK_MODEL || "claude-haiku-5-5", max_tokens: 1500, system: systemPrompt(), messages: turns }, { signal, timeout: 60_000 });
	for await (const ev of stream) if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
}

async function* beeBrain(turns: { role: "user" | "assistant"; content: string }[], signal: AbortSignal): AsyncGenerator<string> {
	const messages = turns.slice(-6).map((t) => ({ role: t.role, content: t.content.slice(-600) }));
	const r = await fetch(`${BEE_URL}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ messages, max_tokens: 160, stream: true, temperature: 0.9 }),
		signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
	}).catch(() => undefined);
	if (!r?.ok || !r.body) throw new GrokError("The bees aren't home right now.");
	let head: string | null = "";
	let lead = true;
	for await (let piece of beeStream(r.body)) {
		if (head === null) {
			if (lead) piece = piece.trimStart();
			if (!piece) continue;
			lead = false;
			yield piece;
			continue;
		}
		head += piece;
		const tag = /^\s*\[[a-z]+:[a-z]+\]\s*/i.exec(head);
		if (tag || !/^\s*\[?[a-z:]*\]?\s*$/i.test(head) || head.length > 24) {
			const rest = (tag ? head.slice(tag[0].length) : head).trimStart();
			head = null;
			if (rest) {
				lead = false;
				yield rest;
			}
		}
	}
	if (head) yield head;
}

async function* beeStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const l of lines) {
			if (!l.startsWith("data:")) continue;
			const data = l.slice(5).trim();
			if (data === "[DONE]") return;
			const piece = JSON.parse(data || "{}").choices?.[0]?.delta?.content;
			if (typeof piece === "string" && piece) yield piece;
		}
	}
}

async function* fakeBrain(turns: { role: string; content: string }[]): AsyncGenerator<string> {
	for (const w of `you said: ${turns.at(-1)?.content.slice(0, 200)}`.split(/(?<= )/)) yield w;
}

const line = (o: unknown) => `${JSON.stringify(o)}\n`;

export async function addResponse(viewer: Viewer, req: Request): Promise<Response> {
	if (req.method !== "POST") return Response.json({ errors: [{ code: 34, message: "Sorry, that page does not exist." }] }, { status: 404 });
	if (!grokReady()) return Response.json({ errors: [{ code: 403, message: "Grok is unavailable on this instance." }] }, { status: 403 });
	const body = (await req.json().catch(() => null)) as any;
	if (body?.isCancel) return new Response("", { status: 200 });
	const sent: any[] = Array.isArray(body?.responses) ? body.responses.filter((r: any) => typeof r?.message === "string") : [];
	const asked = (sent.filter((r) => r.sender === undefined || r.sender === 1).at(-1) ?? sent.at(-1))?.message?.slice(0, MAX_INPUT) ?? "";
	if (!asked.trim()) return Response.json({ errors: [{ code: 400, message: "Ask something." }] }, { status: 400 });
	let conv = await ownConversation(viewer, body?.conversationId);
	if (body?.conversationId && !conv) return Response.json({ errors: [{ code: 34, message: "Conversation not found." }] }, { status: 404 });
	const limit = hit("grok", viewer.id);
	if (!limit.ok) return limitedResponse(limit);
	if (!conv) {
		const id = newId();
		await sql`insert into grok_conversations (id, user_id) values (${id}::bigint, ${viewer.id}::bigint)`;
		conv = { id, title: "", pinned: false, created_at: new Date() };
	}
	const userItem = newId();
	const agentItem = newId();
	const [saved] = await sql`with conversation as (
		update grok_conversations set title = coalesce(nullif(title, ''), ${asked.replace(/\s+/g, " ").trim().slice(0, 60)}), updated_at = now()
		where id = ${conv.id}::bigint returning id
	) insert into grok_items (id, conversation_id, sender, message)
		select ${userItem}::bigint, id, 'User', ${asked} from conversation returning id`;
	if (!saved) return Response.json({ errors: [{ code: 34, message: "Conversation not found." }] }, { status: 404 });

	const past = await sql`select sender, message from grok_items where conversation_id = ${conv.id}::bigint and id < ${userItem}::bigint order by id desc limit ${HISTORY}`;
	const turns: { role: "user" | "assistant"; content: string }[] = past.reverse().map((r: any) => ({ role: r.sender === "User" ? "user" : "assistant", content: r.message || "…" }));
	turns.push({ role: "user", content: asked });
	while (turns.length && turns[0].role !== "user") turns.shift();

	const abort = new AbortController();
	const conversationId = conv.id;
	const stream = new ReadableStream<Uint8Array>({
		async start(ctrl) {
			const enc = new TextEncoder();
			const send = (o: unknown) => ctrl.enqueue(enc.encode(line(o)));
			send({ conversationId, userChatItemId: userItem, agentChatItemId: agentItem });
			let said = "";
			const say = (t: string) => {
				said += t;
				send({ result: { sender: "ASSISTANT", message: t, isThinking: false } });
			};
			try {
				const gen = FAKE ? fakeBrain(turns) : BEE_URL ? beeBrain(turns, abort.signal) : claudeBrain(turns, abort.signal);
				for await (const t of gen) {
					if (abort.signal.aborted) return;
					say(t);
				}
				if (abort.signal.aborted) return;
				if (!said) say(BEE_URL ? "bzz." : "…");
			} catch (e) {
				if (abort.signal.aborted) return;
				if (e instanceof Anthropic.APIError) console.log(`grok: API error ${e.status}`);
				else if (!(e instanceof GrokError)) console.log(`grok: ${e instanceof Error ? e.name : "provider error"}`);
				say(`${said ? "\n\n" : ""}${e instanceof GrokError ? e.message : "Grok broke. Try again in a minute."}`);
			}
			await sql`with conversation as (
				update grok_conversations set updated_at = now() where id = ${conversationId}::bigint returning id
			) insert into grok_items (id, conversation_id, sender, message)
				select ${agentItem}::bigint, id, 'Agent', ${said} from conversation`;
			if (!abort.signal.aborted) ctrl.close();
		},
		cancel() {
			abort.abort();
		},
	});
	return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
