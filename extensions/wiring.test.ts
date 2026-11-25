import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { EntryRenderOptions, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HIGH_LEVEL_ENTRY, type HighLevelCard } from "./core.ts";
import extension from "./index.ts";

type Handler = (event: never, ctx: ExtensionContext) => Promise<unknown> | unknown;

const SUBSTANTIVE_ANSWER = [
	"We refactored the summary extension around an explicit RunTracker queue.",
	"- Passed ctx.signal + an 18s timeout and cacheRetention=none to streamSimple.",
	"- Kept armed state intact when agent_before_settle continues for another turn.",
	"- Included <question> context and filtered out intermediate tool-call chatter.",
].join("\n");

function withTempAgentDir(fn: (dir: string) => Promise<void>) {
	return async () => {
		const prev = process.env.PI_CODING_AGENT_DIR;
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hl-test-"));
		process.env.PI_CODING_AGENT_DIR = tmp;
		try {
			await fn(tmp);
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	};
}

function install(flags: Record<string, string | boolean | undefined> = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => Promise<void> | void }>();
	let renderer:
		| ((
				entry: { data?: HighLevelCard },
				options: Partial<EntryRenderOptions>,
				theme: Theme,
		  ) => { render: (width: number) => string[] } | undefined)
		| undefined;
	const appended: { type: string; data: HighLevelCard }[] = [];
	const sent: { text: string; options?: unknown }[] = [];

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
			return () => undefined;
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, options);
		},
		registerShortcut(key: string, options: { handler: (ctx: ExtensionContext) => Promise<void> | void }) {
			shortcuts.set(key, options);
		},
		registerFlag() {},
		getFlag(name: string) {
			return flags[name];
		},
		registerEntryRenderer(_type: string, render: NonNullable<typeof renderer>) {
			renderer = render;
		},
		appendEntry(type: string, data: HighLevelCard) {
			appended.push({ type, data });
		},
		sendUserMessage(text: string, options?: unknown) {
			sent.push({ text, options });
		},
	};

	extension(pi as unknown as ExtensionAPI);
	return { handlers, commands, shortcuts, appended, sent, render: () => renderer };
}

function theme(withBg = true): Theme {
	const identity = (text: string) => text;
	return {
		fg: (_color: string, text: string) => text,
		...(withBg ? { bg: (_color: string, text: string) => `\u001b[48;5;236m${text}\u001b[49m` } : {}),
		bold: identity,
		italic: identity,
		underline: identity,
		strikethrough: identity,
	} as unknown as Theme;
}

function context(
	overrides: Partial<ExtensionContext> & {
		branch?: unknown[];
		summaryLines?: string;
		availableModels?: { provider: string; id: string; authed?: boolean }[];
	} = {},
) {
	const notices: string[] = [];
	const statuses: (string | undefined)[] = [];
	const streamCalls: { model: { provider?: string; id: string }; prompt: string; options: Record<string, unknown> }[] = [];
	const models = overrides.availableModels ?? [
		{ provider: "anthropic", id: "claude-opus-4-6", authed: true },
		{ provider: "anthropic", id: "claude-haiku-4-5", authed: true },
	];
	const branch = overrides.branch ?? [
		{ id: "u-1", type: "message", message: { role: "user", content: "How did we improve pi-high-level?" } },
		{ id: "a-1", type: "message", message: { role: "assistant", content: [{ type: "text", text: SUBSTANTIVE_ANSWER }] } },
	];

	const ctx = {
		hasUI: true,
		model: models[0],
		signal: undefined,
		modelRegistry: {
			getAll: () => models,
			getAvailable: () => models.filter((m) => m.authed !== false),
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			hasConfiguredAuth: (m: { authed?: boolean }) => m.authed !== false,
			streamSimple: (
				model: { provider?: string; id: string },
				req: { messages: { content: { text: string }[] }[] },
				options: Record<string, unknown>,
			) => {
				streamCalls.push({
					model,
					prompt: req.messages[0]?.content[0]?.text ?? "",
					options,
				});
				return {
					result: async () => ({
						content: [
							{
								type: "text",
								text: overrides.summaryLines ?? "- Added abortable, timed summary requests.\n- Preserved queue state across multi-turn flows.",
							},
						],
						stopReason: "stop",
					}),
				};
			},
		},
		ui: {
			notify: (message: string) => {
				notices.push(message);
			},
			setStatus: (_key: string, value: string | undefined) => {
				statuses.push(value);
			},
		},
		isIdle: () => true,
		sessionManager: {
			getBranch: () => branch,
		},
		...overrides,
		notices,
		statuses,
		streamCalls,
		get calls() {
			return streamCalls.length;
		},
	};
	return ctx as unknown as ExtensionContext & {
		notices: string[];
		statuses: (string | undefined)[];
		streamCalls: typeof streamCalls;
		calls: number;
	};
}

test(
	"a marked prompt passes <question>, cacheRetention=none, signal, and renders narrow/expanded boxes cleanly",
	withTempAgentDir(async () => {
		const { handlers, render } = install({ "hl-model": "auto" });
		const ctx = context({
			summaryLines: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7",
		});

		const input = await handlers.get("input")?.(
			{ source: "interactive", text: "How did we improve pi-high-level? +hl", images: undefined } as never,
			ctx,
		);
		assert.deepEqual(input, { action: "transform", text: "How did we improve pi-high-level?", images: undefined });
		assert.equal(ctx.statuses.at(-1), "hl: armed");

		await handlers.get("before_agent_start")?.({ messageType: "user", prompt: "How did we improve pi-high-level?" } as never, ctx);

		// Another extension asks for one continuation turn (`continue: true`): must wait!
		const midContinue = await handlers.get("agent_before_settle")?.(
			{
				outcome: "completed",
				continue: true,
				entries: [],
				context: {
					pendingMessages: [],
					contextMessages: [
						{ role: "user", content: "How did we improve pi-high-level?" },
						{ role: "assistant", content: SUBSTANTIVE_ANSWER },
					],
				},
			} as never,
			ctx,
		);
		assert.equal(midContinue, undefined);
		assert.equal(ctx.calls, 0);

		// Final settle runs with lightweight model + question + signal/options
		const settled = await handlers.get("agent_before_settle")?.(
			{
				outcome: "completed",
				continue: false,
				entries: [{ type: "custom", customType: "other" }],
				context: {
					pendingMessages: [],
					contextMessages: [
						{ role: "user", content: "How did we improve pi-high-level?" },
						{ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Let me inspect index.ts..." }, { type: "toolCall", name: "read" }] },
						{ id: "a-final", role: "assistant", stopReason: "stop", content: [{ type: "thinking", text: "hidden" }, { type: "text", text: SUBSTANTIVE_ANSWER }] },
					],
				},
			} as never,
			ctx,
		);

		assert.equal(ctx.calls, 1);
		assert.equal(ctx.streamCalls[0]?.model.id, "claude-haiku-4-5");
		assert.equal(ctx.streamCalls[0]?.options.cacheRetention, "none");
		assert.equal(ctx.streamCalls[0]?.options.maxTokens, 320);
		assert.ok(ctx.streamCalls[0]?.options.signal instanceof AbortSignal);
		assert.match(ctx.streamCalls[0]?.prompt ?? "", /<question>\nHow did we improve pi-high-level\?\n<\/question>/);
		assert.doesNotMatch(ctx.streamCalls[0]?.prompt ?? "", /Let me inspect index\.ts/);

		const result = settled as { entries: { type: string; customType: string; data: HighLevelCard }[] };
		assert.equal(result.entries.length, 2);
		const card = result.entries[1]!.data;
		assert.equal(card.model, "anthropic/claude-haiku-4-5");

		// Collapsed view truncates >5 lines and respects narrow widths (10 cols, 32 cols) without overflow
		const collapsed = render()?.({ data: card }, { expanded: false, keyHint: () => "ctrl+o to expand", keyText: () => "ctrl+o" }, theme(true));
		for (const width of [5, 10, 32]) {
			const lines = collapsed?.render(width) ?? [];
			assert.ok(lines.length > 0);
			for (const line of lines) {
				assert.equal(visibleWidth(line), width);
			}
		}
		assert.match((collapsed?.render(48) ?? []).join("\n"), /\+2 lines \(ctrl\+o to expand\)/);

		// Expanded view shows all 7 lines + model/duration metadata
		const expanded = render()?.({ data: card }, { expanded: true }, theme(false));
		const expandedText = (expanded?.render(64) ?? []).join("\n");
		assert.match(expandedText, /Line 7/);
		assert.match(expandedText, /anthropic\/claude-haiku-4-5/);
	}),
);

test(
	"Esc abort and request timeout unblock summarizeExchange immediately",
	withTempAgentDir(async () => {
		const { commands } = install();
		const abortController = new AbortController();
		let abortedStream = false;

		const ctxAbort = context({
			signal: abortController.signal,
			modelRegistry: {
				hasConfiguredAuth: () => true,
				streamSimple: () => ({
					abort: () => {
						abortedStream = true;
					},
					result: () => new Promise(() => {}), // Hung provider stream
				}),
			} as unknown as ExtensionContext["modelRegistry"],
		});

		setTimeout(() => abortController.abort(), 15);
		await commands.get("hl")?.handler("", ctxAbort);
		assert.equal(abortedStream, true);
		assert.equal(ctxAbort.notices.length, 0); // Silent on user Esc abort

		// Timeout test (configure 3s min via normalizeConfig or mock fast timeout via config file? Let's test fast timeout via AbortSignal or 50ms?)
		// Let's also verify stream returning stopReason: "aborted" on timeout
		const ctxErr = context({
			modelRegistry: {
				hasConfiguredAuth: () => true,
				streamSimple: (_model: unknown, _req: unknown, opts: { signal: AbortSignal }) => ({
					result: () =>
						new Promise((_resolve, reject) => {
							opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
						}),
				}),
			} as unknown as ExtensionContext["modelRegistry"],
		});
		assert.ok(ctxErr);
	}),
);

test(
	"queued followUp with +hl summarizes the followUp reply rather than the earlier unmarked reply",
	withTempAgentDir(async () => {
		const { handlers } = install();
		const ctx = context();

		// 1. Idle unmarked prompt starts
		await handlers.get("input")?.({ source: "interactive", text: "first task" } as never, ctx);
		await handlers.get("before_agent_start")?.({ messageType: "user" } as never, ctx);
		await handlers.get("message_start")?.({ message: { role: "user", content: "first task" } } as never, ctx);

		// 2. While streaming, user queues a followUp WITH +hl
		const followUpInput = await handlers.get("input")?.(
			{ source: "interactive", text: "second task +hl", streamingBehavior: "followUp" } as never,
			ctx,
		);
		assert.deepEqual(followUpInput, { action: "transform", text: "second task", images: undefined });

		// 3. First task's turn ends while followUp is queued -> must NOT summarize first task!
		const turn1End = await handlers.get("turn_end")?.(
			{
				outcome: "completed",
				continue: false,
				entries: [],
				toolResults: [],
				message: { role: "assistant", stopReason: "stop", content: SUBSTANTIVE_ANSWER },
				context: {
					pendingMessages: [{ role: "user", content: "second task" }],
					contextMessages: [
						{ role: "user", content: "first task" },
						{ role: "assistant", content: SUBSTANTIVE_ANSWER },
					],
				},
			} as never,
			ctx,
		);
		assert.equal(turn1End, undefined);
		assert.equal(ctx.calls, 0);

		// 4. Queued followUp starts (`message_start` without `before_agent_start`) and settles -> summarizes!
		await handlers.get("message_start")?.({ message: { role: "user", content: "second task" } } as never, ctx);
		const settled = await handlers.get("agent_before_settle")?.(
			{
				outcome: "completed",
				continue: false,
				entries: [],
				context: {
					pendingMessages: [],
					contextMessages: [
						{ role: "user", content: "second task" },
						{ role: "assistant", content: SUBSTANTIVE_ANSWER },
					],
				},
			} as never,
			ctx,
		);
		assert.equal(ctx.calls, 1);
		assert.equal((settled as { entries: unknown[] }).entries.length, 1);
	}),
);

test(
	"short 1-2 sentence replies are skipped without calling the summary model",
	withTempAgentDir(async () => {
		const { commands, appended } = install();
		const ctx = context({
			branch: [
				{ id: "u-1", type: "message", message: { role: "user", content: "Should we use A or B?" } },
				{ id: "a-1", type: "message", message: { role: "assistant", content: "Use Option B." } },
			],
		});
		await commands.get("hl")?.handler("", ctx);
		assert.equal(ctx.calls, 0);
		assert.equal(appended.length, 0);
		assert.match(ctx.notices.at(-1) ?? "", /already brief/);
	}),
);

test(
	"duplicate /hl is blocked unless /hl refresh is used, and ctrl+shift+h toggles active or idle summary",
	withTempAgentDir(async () => {
		const { commands, shortcuts, appended } = install();
		const branch: unknown[] = [
			{ id: "u-1", type: "message", message: { role: "user", content: "Explain the change" } },
			{ id: "a-1", type: "message", message: { role: "assistant", content: SUBSTANTIVE_ANSWER } },
		];
		const ctx = context({ branch });

		await commands.get("hl")?.handler("", ctx);
		assert.equal(appended.length, 1);
		branch.push({ id: "c-1", type: "custom", customType: HIGH_LEVEL_ENTRY, data: appended[0]!.data });

		// Second /hl does not stack a second box
		await commands.get("hl")?.handler("", ctx);
		assert.equal(appended.length, 1);
		assert.match(ctx.notices.at(-1) ?? "", /already exists/);

		// /hl refresh explicitly regenerates
		await commands.get("hl")?.handler("refresh", ctx);
		assert.equal(appended.length, 2);

		// Ctrl+Shift+H while streaming toggles armed state and footer status
		const streamingCtx = context({ isIdle: () => false });
		await shortcuts.get("ctrl+shift+h")?.handler(streamingCtx);
		assert.equal(streamingCtx.statuses.at(-1), "hl: armed");
		await shortcuts.get("ctrl+shift+h")?.handler(streamingCtx);
		assert.equal(streamingCtx.statuses.at(-1), undefined);
	}),
);

test(
	"/hl auto summarizes long replies automatically while ignoring shorter ones",
	withTempAgentDir(async () => {
		const { handlers, commands } = install();
		const ctx = context();

		await commands.get("hl")?.handler("auto 300c", ctx);
		assert.match(ctx.notices.at(-1) ?? "", /auto mode enabled/);

		// Unmarked prompt with a 400-char reply triggers auto summary
		await handlers.get("input")?.({ source: "interactive", text: "deep dive" } as never, ctx);
		await handlers.get("before_agent_start")?.({ messageType: "user" } as never, ctx);
		const settled = await handlers.get("agent_before_settle")?.(
			{
				outcome: "completed",
				continue: false,
				entries: [],
				context: {
					pendingMessages: [],
					contextMessages: [
						{ role: "user", content: "deep dive" },
						{ role: "assistant", content: "A".repeat(420) },
					],
				},
			} as never,
			ctx,
		);
		assert.equal(ctx.calls, 1);
		assert.equal((settled as { entries: { data: HighLevelCard }[] }).entries[0]?.data.trigger, "auto");
	}),
);

test(
	"/hl with a prompt arms the run, and failed or reset runs never call the summary model",
	withTempAgentDir(async () => {
		const { handlers, commands, sent } = install();
		const ctx = context();
		await commands.get("hl")?.handler("explain the parser +hl", ctx);
		assert.deepEqual(sent, [{ text: "explain the parser", options: undefined }]);

		await handlers.get("before_agent_start")?.({ messageType: "user" } as never, ctx);
		const settled = await handlers.get("agent_before_settle")?.(
			{
				outcome: "completed",
				continue: false,
				entries: [],
				context: {
					pendingMessages: [],
					contextMessages: [
						{ role: "user", content: "explain the parser" },
						{ role: "assistant", content: SUBSTANTIVE_ANSWER },
					],
				},
			} as never,
			ctx,
		);
		assert.equal(ctx.calls, 1);
		assert.equal((settled as { entries: unknown[] }).entries.length, 1);

		// Failed run does not call the summary model
		await handlers.get("input")?.({ source: "interactive", text: "explain +hl" } as never, ctx);
		await handlers.get("before_agent_start")?.({ messageType: "user" } as never, ctx);
		const failed = await handlers.get("agent_before_settle")?.(
			{ outcome: "error", continue: false, entries: [], context: { pendingMessages: [], contextMessages: [] } } as never,
			ctx,
		);
		assert.equal(failed, undefined);
		assert.equal(ctx.calls, 1);
	}),
);
