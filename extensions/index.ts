import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	EntryRenderOptions,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type BranchEntryLike,
	buildSummaryPrompt,
	type ChatMessage,
	DEFAULT_MAX_TOKENS,
	defaultConfig,
	expandHomePath,
	extractTurnExchange,
	formatCardMeta,
	frameLines,
	HIGH_LEVEL_ENTRY,
	type HighLevelCard,
	type HighLevelConfig,
	hasExistingCardForLatestReply,
	hasToolCalls,
	isAnswerTooShort,
	MAX_COLLAPSED_LINES,
	MAX_PROMPT_TEMPLATE_CHARS,
	type ModelCandidate,
	messageText,
	normalizeConfig,
	parseAutoSpec,
	pickSummaryModel,
	RunTracker,
	type SummaryTrigger,
	shouldAutoSummarize,
	stripHighLevelMarker,
	type TurnExchange,
} from "./core.ts";

interface ModelLike extends ModelCandidate {
	api?: string;
}

function resolveConfigPath(): string {
	const dir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
	return path.join(dir, "pi-high-level.json");
}

function loadConfig(): HighLevelConfig {
	try {
		const raw = fs.readFileSync(resolveConfigPath(), "utf8");
		return normalizeConfig(JSON.parse(raw));
	} catch {
		return defaultConfig();
	}
}

function saveConfig(config: HighLevelConfig): boolean {
	try {
		const filePath = resolveConfigPath();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const payload: Record<string, unknown> = {
			...(config.model ? { model: config.model } : {}),
			timeoutMs: config.timeoutMs,
			auto: config.auto,
			...(config.promptFile ? { promptFile: config.promptFile } : {}),
		};
		fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

function readPromptTemplate(filePath: string | undefined): { template?: string; problem?: string } {
	if (!filePath) return {};
	const resolved = path.resolve(expandHomePath(filePath));
	let text: string;
	try {
		const stat = fs.statSync(resolved);
		if (!stat.isFile()) return { problem: `Summary prompt path is not a file: ${resolved}` };
		text = fs.readFileSync(resolved, "utf8");
	} catch {
		return { problem: `Cannot read summary prompt file: ${resolved}` };
	}
	const trimmed = text.replace(/^\uFEFF/u, "").trim();
	if (!trimmed) return { problem: `Summary prompt file is empty: ${resolved}` };
	if (trimmed.length > MAX_PROMPT_TEMPLATE_CHARS) {
		return {
			template: trimmed.slice(0, MAX_PROMPT_TEMPLATE_CHARS),
			problem: `Summary prompt file exceeds ${MAX_PROMPT_TEMPLATE_CHARS} characters; only the start is used`,
		};
	}
	return { template: trimmed };
}

function markdownTheme(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("accent", text),
		link: (text) => theme.fg("accent", text),
		linkUrl: (text) => theme.fg("muted", text),
		code: (text) => theme.fg("accent", text),
		codeBlock: (text) => theme.fg("muted", text),
		codeBlockBorder: (text) => theme.fg("border", text),
		quote: (text) => theme.fg("muted", text),
		quoteBorder: (text) => theme.fg("border", text),
		hr: (text) => theme.fg("border", text),
		listBullet: (text) => theme.fg("accent", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
}

function expandHintText(options: Partial<EntryRenderOptions> | undefined): string {
	if (options && typeof options.keyHint === "function") {
		const hint = options.keyHint("app.tools.expand", "to expand");
		if (hint) return hint;
	}
	return "ctrl+o to expand";
}

function renderCard(card: HighLevelCard, options: Partial<EntryRenderOptions> | undefined, theme: Theme) {
	const textStyle =
		typeof theme.fg === "function"
			? { color: (text: string) => theme.fg("customMessageText", text) }
			: undefined;
	const markdown = new Markdown(card.summary, 0, 0, markdownTheme(theme), textStyle);
	const expanded = Boolean(options?.expanded);
	const meta = formatCardMeta(card);
	const paintBg =
		typeof theme.bg === "function" ? (line: string) => theme.bg("customMessageBg", line) : undefined;

	return {
		invalidate() {
			markdown.invalidate();
		},
		render(width: number) {
			const columns = Math.floor(width);
			if (columns <= 0) return [];
			const inner = Math.max(1, columns < 6 ? columns : columns - 4);
			const rawLines = markdown.render(inner).map((line) => truncateToWidth(line, inner, "", false));

			let body: string[];
			if (!expanded && rawLines.length > MAX_COLLAPSED_LINES) {
				const hiddenCount = rawLines.length - MAX_COLLAPSED_LINES;
				const hint = truncateToWidth(`… +${hiddenCount} lines (${expandHintText(options)})`, inner, "…", false);
				body = [...rawLines.slice(0, MAX_COLLAPSED_LINES), theme.fg("dim", hint)];
			} else if (expanded && meta) {
				const metaLine = truncateToWidth(meta, inner, "…", false);
				body = [...rawLines, theme.fg("dim", metaLine)];
			} else {
				body = rawLines;
			}

			return frameLines(body, columns, (text) => theme.fg("borderAccent", text), visibleWidth, paintBg);
		},
	};
}

function chatFrom(messages: readonly object[]): ChatMessage[] {
	const chats: ChatMessage[] = [];
	for (const message of messages) {
		if (!("role" in message) || typeof message.role !== "string") continue;
		chats.push({
			id: "id" in message && typeof message.id === "string" ? message.id : undefined,
			role: message.role,
			content: "content" in message ? message.content : undefined,
			stopReason: "stopReason" in message && typeof message.stopReason === "string" ? message.stopReason : undefined,
		});
	}
	return chats;
}

function branchEntries(ctx: ExtensionContext): BranchEntryLike[] {
	const rawEntries = ctx.sessionManager.getBranch();
	return rawEntries.map((entry) => {
		if (entry.type === "message" && "content" in entry.message) {
			const msg = entry.message as { role?: string; content?: unknown; stopReason?: string };
			return {
				id: "id" in entry && typeof entry.id === "string" ? entry.id : undefined,
				type: entry.type,
				message: {
					id: "id" in entry && typeof entry.id === "string" ? entry.id : undefined,
					role: msg.role,
					content: msg.content,
					stopReason: msg.stopReason,
				},
			};
		}
		return {
			id: "id" in entry && typeof entry.id === "string" ? entry.id : undefined,
			type: entry.type,
			customType: "customType" in entry && typeof entry.customType === "string" ? entry.customType : undefined,
			data: "data" in entry ? entry.data : undefined,
		};
	});
}

function branchMessages(entries: readonly BranchEntryLike[]): ChatMessage[] {
	const chats: ChatMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "message" && entry.message) {
			chats.push(entry.message);
		}
	}
	return chats;
}

function resolveModel(ctx: ExtensionContext, modelSpec: string | undefined) {
	const active = ctx.model as (ModelLike & NonNullable<ExtensionContext["model"]>) | undefined;
	const registry = ctx.modelRegistry as ExtensionContext["modelRegistry"] & {
		getAll?: () => ModelLike[];
		find?: (provider: string, id: string) => ModelLike | undefined;
	};

	const candidates: ModelLike[] = [];
	if (modelSpec && modelSpec.includes("/") && typeof registry.find === "function") {
		const slash = modelSpec.indexOf("/");
		const direct = registry.find(modelSpec.slice(0, slash), modelSpec.slice(slash + 1));
		if (direct) candidates.push(direct);
	}
	if (typeof registry.getAll === "function") {
		for (const item of registry.getAll()) {
			if (!candidates.some((existing) => existing.provider === item.provider && existing.id === item.id)) {
				candidates.push(item);
			}
		}
	}
	if (active && !candidates.some((existing) => existing.provider === active.provider && existing.id === active.id)) {
		candidates.push(active);
	}

	const normalizedActive = active
		? { ...active, provider: active.provider ?? "default" }
		: undefined;
	const normalizedCandidates = candidates.map((item) => ({
		...item,
		provider: item.provider ?? "default",
	}));

	return pickSummaryModel(
		modelSpec,
		normalizedActive,
		normalizedCandidates,
		(candidate) => registry.hasConfiguredAuth(candidate as NonNullable<ExtensionContext["model"]>),
	) as NonNullable<ExtensionContext["model"]> | undefined;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
	if (signal.aborted) {
		onAbort?.();
		return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
	}
	return new Promise<T>((resolve, reject) => {
		const abortHandler = () => {
			onAbort?.();
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		};
		signal.addEventListener("abort", abortHandler, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abortHandler);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abortHandler);
				reject(error);
			},
		);
	});
}

export default function (pi: ExtensionAPI) {
	const tracker = new RunTracker();
	let config = loadConfig();
	let summarizing = false;

	pi.registerFlag?.("hl-model", {
		type: "string",
		description: "Summary model for pi-high-level (provider/id, id, auto, or current)",
	});
	pi.registerFlag?.("hl-auto", {
		type: "string",
		description: "Auto-summarize long replies (on, off, <N>c, or <N>l)",
	});

	function effectiveConfig(): HighLevelConfig {
		const flagModel = typeof pi.getFlag === "function" ? pi.getFlag("hl-model") : undefined;
		const flagAuto = typeof pi.getFlag === "function" ? pi.getFlag("hl-auto") : undefined;
		const auto =
			typeof flagAuto === "string" && flagAuto.trim()
				? (parseAutoSpec(flagAuto, config.auto) ?? config.auto)
				: config.auto;
		const model =
			typeof flagModel === "string" && flagModel.trim()
				? flagModel.trim() === "current"
					? undefined
					: flagModel.trim()
				: config.model;
		return {
			model,
			timeoutMs: config.timeoutMs,
			auto,
		};
	}

	function syncStatus(ctx: ExtensionContext): void {
		if (summarizing) {
			ctx.ui.setStatus(HIGH_LEVEL_ENTRY, "hl: summarizing");
		} else if (tracker.isArmed()) {
			ctx.ui.setStatus(HIGH_LEVEL_ENTRY, "hl: armed");
		} else {
			ctx.ui.setStatus(HIGH_LEVEL_ENTRY, undefined);
		}
	}

	async function summarizeExchange(
		ctx: ExtensionContext,
		exchange: TurnExchange,
		trigger: SummaryTrigger,
	): Promise<HighLevelCard | undefined> {
		if (!exchange.answer.trim()) {
			if (trigger !== "auto") {
				ctx.ui.notify("High-level needs an answer to summarize", "warning");
			}
			return undefined;
		}
		if (isAnswerTooShort(exchange.answer)) {
			if (trigger !== "auto") {
				ctx.ui.notify("Reply is already brief; skipped high-level summary", "info");
			}
			return undefined;
		}

		const cfg = effectiveConfig();
		const promptFile = readPromptTemplate(config.promptFile);
		if (promptFile.problem) {
			ctx.ui.notify(promptFile.problem, "warning");
		}
		const model = resolveModel(ctx, cfg.model);
		if (!model) {
			if (!ctx.model) {
				ctx.ui.notify("No model selected for the high-level summary", "warning");
			} else {
				ctx.ui.notify("No credentials for the high-level summary model", "warning");
			}
			return undefined;
		}

		const timeoutController = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			timeoutController.abort(new Error("High-level summary timed out"));
		}, cfg.timeoutMs);
		timer.unref?.();

		const signal = ctx.signal
			? AbortSignal.any([ctx.signal, timeoutController.signal])
			: timeoutController.signal;

		const startedAt = Date.now();
		summarizing = true;
		syncStatus(ctx);
		try {
			const stream = ctx.modelRegistry.streamSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: buildSummaryPrompt(exchange, promptFile.template) }],
							timestamp: startedAt,
						},
					],
				},
				{
					reasoning: "minimal",
					toolChoice: "none",
					cacheRetention: "none",
					maxTokens: DEFAULT_MAX_TOKENS,
					disableContinuation: true,
					timeoutMs: cfg.timeoutMs,
					signal,
				},
			) as { result: () => Promise<{ content: unknown; errorMessage?: string; stopReason?: string }>; abort?: () => void };

			const response = await raceWithAbort(stream.result(), signal, () => stream.abort?.());

			if (response.stopReason === "aborted") {
				if (timedOut && !ctx.signal?.aborted) {
					ctx.ui.notify("High-level summary timed out", "warning");
				}
				return undefined;
			}
			if (response.errorMessage || response.stopReason === "error") {
				ctx.ui.notify(response.errorMessage || "High-level summary failed", "error");
				return undefined;
			}

			const summary = messageText(response.content);
			if (!summary) {
				ctx.ui.notify("High-level summary was empty", "warning");
				return undefined;
			}

			const modelLabel = model.provider ? `${model.provider}/${model.id}` : model.id;
			return {
				summary,
				model: modelLabel,
				durationMs: Math.max(0, Date.now() - startedAt),
				sourceChars: exchange.answer.length,
				targetEntryId: exchange.targetEntryId,
				trigger,
				timestamp: Date.now(),
			};
		} catch (error) {
			if (ctx.signal?.aborted) {
				return undefined;
			}
			if (timedOut) {
				ctx.ui.notify("High-level summary timed out", "warning");
				return undefined;
			}
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`High-level summary failed: ${message}`, "error");
			return undefined;
		} finally {
			clearTimeout(timer);
			summarizing = false;
			syncStatus(ctx);
		}
	}

	async function summarizeLatestOnBranch(
		ctx: ExtensionContext,
		trigger: SummaryTrigger,
		force = false,
	): Promise<void> {
		const entries = branchEntries(ctx);
		if (!force && hasExistingCardForLatestReply(entries, HIGH_LEVEL_ENTRY)) {
			ctx.ui.notify("High-level summary already exists for the latest reply (/hl refresh to regenerate)", "info");
			return;
		}
		const exchange = extractTurnExchange(branchMessages(entries));
		const card = await summarizeExchange(ctx, exchange, trigger);
		if (!card) return;
		pi.appendEntry<HighLevelCard>(HIGH_LEVEL_ENTRY, card);
	}

	pi.registerEntryRenderer<HighLevelCard>(HIGH_LEVEL_ENTRY, (entry, options, theme) => {
		const summary = entry.data?.summary?.trim();
		if (!summary) return undefined;
		return renderCard({ ...entry.data, summary }, options, theme);
	});

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig();
		tracker.reset();
		summarizing = false;
		syncStatus(ctx);
	});

	pi.on("input", (event, ctx) => {
		const stripped = stripHighLevelMarker(event.text);
		if (stripped.marked && !stripped.text.trim()) {
			ctx.ui.notify("Add a prompt before +hl, or run /hl to summarize the latest reply", "info");
			return { action: "handled" as const };
		}

		tracker.onInput({
			marked: stripped.marked,
			source: event.source,
			streamingBehavior: event.streamingBehavior,
		});
		syncStatus(ctx);

		if (event.source === "extension" || !stripped.marked) return;
		return { action: "transform" as const, text: stripped.text, images: event.images };
	});

	pi.on("before_agent_start", (event, ctx) => {
		tracker.onBeforeAgentStart(event.messageType);
		syncStatus(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		const role = (event.message as { role?: string } | undefined)?.role;
		if (role === "user") {
			tracker.onUserMessageStart();
			syncStatus(ctx);
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		const msg = event.message as { role?: string; content?: unknown; stopReason?: string };
		const hasTools =
			(event.toolResults?.length ?? 0) > 0 ||
			msg.stopReason === "toolUse" ||
			hasToolCalls(msg.content);
		const hasPending = (event.context?.pendingMessages?.length ?? 0) > 0;
		const trigger = tracker.consumeAtTurnEnd({
			completed: event.outcome === "completed",
			hasToolCalls: hasTools,
			willContinue: Boolean(event.continue),
			hasPendingMessages: hasPending,
		});
		syncStatus(ctx);

		const cfg = effectiveConfig();
		const exchange = extractTurnExchange(chatFrom(event.context?.contextMessages ?? []));
		const effectiveTrigger =
			trigger ??
			(!hasTools &&
			!event.continue &&
			event.outcome === "completed" &&
			(tracker.hasQueuedUserTurns() || hasPending) &&
			shouldAutoSummarize(exchange.answer, cfg.auto)
				? "auto"
				: undefined);

		if (!effectiveTrigger) return;
		const card = await summarizeExchange(ctx, exchange, effectiveTrigger);
		if (!card) return;
		return {
			entries: [
				...event.entries,
				{
					type: "custom" as const,
					customType: HIGH_LEVEL_ENTRY,
					data: card,
				},
			],
		};
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		const hasPending = (event.context?.pendingMessages?.length ?? 0) > 0;
		const trigger = tracker.consumeBeforeSettle({
			completed: event.outcome === "completed",
			willContinue: Boolean(event.continue),
			hasPendingMessages: hasPending,
		});
		syncStatus(ctx);

		if (event.outcome !== "completed" || event.continue || hasPending) return;

		const cfg = effectiveConfig();
		const exchange = extractTurnExchange(chatFrom(event.context?.contextMessages ?? []));
		const effectiveTrigger =
			trigger ?? (shouldAutoSummarize(exchange.answer, cfg.auto) ? "auto" : undefined);
		if (!effectiveTrigger) return;

		const card = await summarizeExchange(ctx, exchange, effectiveTrigger);
		if (!card) return;

		return {
			entries: [
				...event.entries,
				{
					type: "custom" as const,
					customType: HIGH_LEVEL_ENTRY,
					data: card,
				},
			],
		};
	});

	pi.on("agent_settled", (_event, ctx) => {
		tracker.reset();
		syncStatus(ctx);
	});

	pi.registerShortcut?.("ctrl+shift+h", {
		description: "Arm high-level summary for active reply, or summarize latest reply",
		handler: async (ctx) => {
			if (!ctx.isIdle()) {
				const armed = tracker.toggleActiveTurn();
				syncStatus(ctx);
				ctx.ui.notify(
					armed
						? "High-level summary armed for this reply"
						: "High-level summary disarmed for this reply",
					"info",
				);
				return;
			}
			await summarizeLatestOnBranch(ctx, "shortcut");
		},
	});

	pi.registerCommand("hl", {
		description:
			"Box a high-level summary (/hl, /hl refresh, /hl model, /hl auto, /hl prompt, /hl status, or /hl <prompt>)",
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (!requested) {
				await summarizeLatestOnBranch(ctx, "manual", false);
				return;
			}

			if (requested === "refresh" || requested === "force" || requested === "--force") {
				await summarizeLatestOnBranch(ctx, "manual", true);
				return;
			}

			if (requested === "status") {
				const cfg = effectiveConfig();
				const resolved = resolveModel(ctx, cfg.model);
				const resolvedName = resolved
					? resolved.provider
						? `${resolved.provider}/${resolved.id}`
						: resolved.id
					: "none";
				const autoDesc = cfg.auto.enabled
					? `on (>=${cfg.auto.minChars} chars or >=${cfg.auto.minLines} lines)`
					: "off";
				const promptDesc = config.promptFile ?? "builtin";
				ctx.ui.notify(
					`hl · model=${cfg.model ?? "current"} (${resolvedName}) · auto=${autoDesc} · timeout=${Math.round(cfg.timeoutMs / 1_000)}s · prompt=${promptDesc} · key=ctrl+shift+h`,
					"info",
				);
				return;
			}

			const modelMatch = requested.match(/^model(?:\s+(\S+))?$/u);
			if (modelMatch) {
				let nextSpec = modelMatch[1];
				if (!nextSpec && ctx.hasUI && typeof ctx.ui.select === "function") {
					const available =
						(
							ctx.modelRegistry as ExtensionContext["modelRegistry"] & {
								getAvailable?: () => ModelCandidate[];
							}
						).getAvailable?.() ?? [];
					const choices = [
						"current (active session model)",
						"auto (prefer haiku / flash / mini)",
						...available.map((m) => `${m.provider}/${m.id}`),
					];
					const picked = await ctx.ui.select("High-level summary model", choices);
					if (!picked) return;
					if (picked.startsWith("current ")) nextSpec = "current";
					else if (picked.startsWith("auto ")) nextSpec = "auto";
					else nextSpec = picked;
				}
				if (!nextSpec) {
					ctx.ui.notify(`Current summary model setting: ${config.model ?? "current"}`, "info");
					return;
				}
				config = {
					...config,
					model: nextSpec === "current" || nextSpec === "reset" || nextSpec === "default" ? undefined : nextSpec,
				};
				saveConfig(config);
				const resolved = resolveModel(ctx, config.model);
				const resolvedLabel = resolved
					? resolved.provider
						? `${resolved.provider}/${resolved.id}`
						: resolved.id
					: "fallback to active model";
				ctx.ui.notify(`High-level model set to ${config.model ?? "current"} (${resolvedLabel})`, "info");
				return;
			}

			const autoMatch = requested.match(/^auto(?:\s+(\S+))?$/u);
			if (autoMatch) {
				const parsed = parseAutoSpec(autoMatch[1] ?? "toggle", config.auto);
				if (!parsed) {
					ctx.ui.notify("Usage: /hl auto [on | off | toggle | <chars>c | <lines>l]", "warning");
					return;
				}
				config = { ...config, auto: parsed };
				saveConfig(config);
				ctx.ui.notify(
					parsed.enabled
						? `High-level auto mode enabled (>=${parsed.minChars} chars or >=${parsed.minLines} lines)`
						: "High-level auto mode disabled",
					"info",
				);
				return;
			}

			const promptMatch = requested.match(/^prompt(?:\s+([\s\S]+))?$/u);
			if (promptMatch) {
				const rest = promptMatch[1]?.trim() ?? "";
				if (!rest) {
					const loaded = readPromptTemplate(config.promptFile);
					if (!config.promptFile) {
						ctx.ui.notify("High-level summary prompt: built-in", "info");
					} else if (loaded.problem && !loaded.template) {
						ctx.ui.notify(`High-level summary prompt: ${config.promptFile} (${loaded.problem})`, "warning");
					} else {
						ctx.ui.notify(`High-level summary prompt file: ${config.promptFile}`, "info");
					}
					return;
				}
				if (rest === "reset" || rest === "builtin" || rest === "default") {
					config = { ...config, promptFile: undefined };
					saveConfig(config);
					ctx.ui.notify("High-level summary prompt reset to built-in", "info");
					return;
				}
				const fileMatch = rest.match(/^file\s+([\s\S]+)$/u);
				if (!fileMatch) {
					ctx.ui.notify("Usage: /hl prompt | /hl prompt file <path> | /hl prompt reset", "warning");
					return;
				}
				let fileArg = fileMatch[1].trim();
				if (
					(fileArg.startsWith('"') && fileArg.endsWith('"') && fileArg.length >= 2) ||
					(fileArg.startsWith("'") && fileArg.endsWith("'") && fileArg.length >= 2)
				) {
					fileArg = fileArg.slice(1, -1);
				}
				if (!fileArg) {
					ctx.ui.notify("Usage: /hl prompt file <path>", "warning");
					return;
				}
				const resolved = path.resolve(expandHomePath(fileArg));
				let isFile = false;
				try {
					isFile = fs.statSync(resolved).isFile();
				} catch {
					isFile = false;
				}
				if (!isFile) {
					ctx.ui.notify(`Summary prompt file not found: ${resolved}`, "warning");
					return;
				}
				config = { ...config, promptFile: resolved };
				if (!saveConfig(config)) {
					ctx.ui.notify("Could not save the summary prompt path", "warning");
					return;
				}
				ctx.ui.notify(`High-level summary prompt file set to ${resolved}`, "info");
				return;
			}

			const timeoutMatch = requested.match(/^timeout\s+(\d+)(ms|s)?$/u);
			if (timeoutMatch) {
				const rawAmount = Number.parseInt(timeoutMatch[1], 10);
				const ms = timeoutMatch[2] === "ms" ? rawAmount : rawAmount * 1_000;
				const nextCfg = normalizeConfig({ ...config, timeoutMs: ms });
				config = nextCfg;
				saveConfig(config);
				ctx.ui.notify(`High-level summary timeout set to ${Math.round(config.timeoutMs / 1_000)}s`, "info");
				return;
			}

			const stripped = stripHighLevelMarker(requested);
			const prompt = (stripped.marked ? stripped.text : requested).trim();
			if (!prompt) {
				ctx.ui.notify("Add a prompt before +hl, or run /hl to summarize the latest reply", "info");
				return;
			}

			const idle = ctx.isIdle();
			tracker.armCommandPrompt(idle ? "idle" : "followUp", "manual");
			syncStatus(ctx);
			pi.sendUserMessage(prompt, idle ? undefined : { deliverAs: "followUp" });
		},
	});
}
