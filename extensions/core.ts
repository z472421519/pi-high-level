import os from "node:os";
import path from "node:path";

export const HIGH_LEVEL_ENTRY = "high-level";
export const DEFAULT_TIMEOUT_MS = 18_000;
export const DEFAULT_MAX_TOKENS = 320;
export const MIN_ANSWER_CHARS = 160;
export const MIN_ANSWER_LINES = 4;
export const DEFAULT_AUTO_MIN_CHARS = 1_200;
export const DEFAULT_AUTO_MIN_LINES = 28;
export const MAX_COLLAPSED_LINES = 5;
export const MAX_PROMPT_TEMPLATE_CHARS = 8_000;

const MARKER = "+hl";
const LABEL = " high-level ";
const SHORT_LABEL = " hl ";
const QUESTION_LIMIT = 1_200;
const ANSWER_LIMIT = 16_000;
const LIGHTWEIGHT_MODEL_RE = /\b(?:haiku|flash|mini|nano|instant)\b|(?:haiku|flash|mini|nano)/iu;

export type SummaryTrigger = "marked" | "manual" | "shortcut" | "auto";

export interface ChatMessage {
	id?: string;
	role?: string;
	content?: unknown;
	stopReason?: string;
}

export interface TurnExchange {
	question: string;
	answer: string;
	targetEntryId?: string;
}

export interface AutoSummaryConfig {
	enabled: boolean;
	minChars: number;
	minLines: number;
}

export interface HighLevelConfig {
	model?: string;
	timeoutMs: number;
	auto: AutoSummaryConfig;
	/** Local file whose text replaces the built-in summary instructions. */
	promptFile?: string;
}

export interface HighLevelCard {
	summary: string;
	model?: string;
	durationMs?: number;
	sourceChars?: number;
	targetEntryId?: string;
	trigger?: SummaryTrigger;
	timestamp?: number;
}

export interface BranchEntryLike {
	id?: string;
	type: string;
	customType?: string;
	message?: ChatMessage;
	data?: unknown;
}

export interface ModelCandidate {
	provider: string;
	id: string;
}

export function defaultConfig(): HighLevelConfig {
	return {
		model: undefined,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		auto: {
			enabled: false,
			minChars: DEFAULT_AUTO_MIN_CHARS,
			minLines: DEFAULT_AUTO_MIN_LINES,
		},
	};
}

export function normalizeConfig(raw: unknown): HighLevelConfig {
	const base = defaultConfig();
	if (!raw || typeof raw !== "object") return base;
	const record = raw as Record<string, unknown>;

	if (typeof record.model === "string" && record.model.trim()) {
		const model = record.model.trim();
		base.model = model === "current" || model === "default" ? undefined : model;
	}
	if (typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs)) {
		base.timeoutMs = Math.min(120_000, Math.max(3_000, Math.round(record.timeoutMs)));
	}
	if (record.auto && typeof record.auto === "object") {
		const auto = record.auto as Record<string, unknown>;
		if (typeof auto.enabled === "boolean") base.auto.enabled = auto.enabled;
		if (typeof auto.minChars === "number" && Number.isFinite(auto.minChars) && auto.minChars >= 200) {
			base.auto.minChars = Math.round(auto.minChars);
		}
		if (typeof auto.minLines === "number" && Number.isFinite(auto.minLines) && auto.minLines >= 4) {
			base.auto.minLines = Math.round(auto.minLines);
		}
	}
	if (typeof record.promptFile === "string" && record.promptFile.trim()) {
		base.promptFile = record.promptFile.trim();
	}
	return base;
}

/** Expand a leading `~` so a hand-edited config can point at a home-relative file. */
export function expandHomePath(filePath: string, home = os.homedir()): string {
	const trimmed = filePath.trim();
	if (trimmed === "~") return home;
	if (trimmed.startsWith("~/")) return path.join(home, trimmed.slice(2));
	return trimmed;
}

export function parseAutoSpec(spec: string, current: AutoSummaryConfig): AutoSummaryConfig | undefined {
	const value = spec.trim().toLowerCase();
	if (!value || value === "on" || value === "true") {
		return { ...current, enabled: true };
	}
	if (value === "off" || value === "false" || value === "0") {
		return { ...current, enabled: false };
	}
	if (value === "toggle") {
		return { ...current, enabled: !current.enabled };
	}
	const charMatch = value.match(/^(\d+)\s*c(?:hars?)?$/u);
	if (charMatch) {
		const minChars = Number.parseInt(charMatch[1], 10);
		if (minChars >= MIN_ANSWER_CHARS) {
			return { ...current, enabled: true, minChars };
		}
		return undefined;
	}
	const lineMatch = value.match(/^(\d+)\s*l(?:ines?)?$/u);
	if (lineMatch) {
		const minLines = Number.parseInt(lineMatch[1], 10);
		if (minLines >= MIN_ANSWER_LINES) {
			return { ...current, enabled: true, minLines };
		}
		return undefined;
	}
	if (/^\d+$/u.test(value)) {
		const amount = Number.parseInt(value, 10);
		if (amount >= 200) return { ...current, enabled: true, minChars: amount };
		if (amount >= MIN_ANSWER_LINES) return { ...current, enabled: true, minLines: amount };
	}
	return undefined;
}

export function stripHighLevelMarker(input: string): { text: string; marked: boolean } {
	const text = input.replace(/\s+$/u, "");
	const lineBreak = text.lastIndexOf("\n");
	const lastLine = (lineBreak === -1 ? text : text.slice(lineBreak + 1)).trim();
	if (lastLine === MARKER) {
		const body = lineBreak === -1 ? "" : text.slice(0, lineBreak).replace(/\s+$/u, "");
		return { text: body, marked: true };
	}

	const token = text.match(/^(.*?)(?:^|\s)\+hl$/u);
	if (token) {
		return { text: token[1].replace(/\s+$/u, ""), marked: true };
	}

	return { text: input, marked: false };
}

export function messageText(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}
	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as { type?: unknown; text?: unknown };
		if (record.type === "text" && typeof record.text === "string") {
			const text = record.text.trim();
			if (text) parts.push(text);
		}
	}
	return parts.join("\n\n");
}

export function hasToolCalls(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some(
		(block) => Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall"),
	);
}

export function extractTurnExchange(messages: readonly ChatMessage[]): TurnExchange {
	let userIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") {
			userIndex = index;
			break;
		}
	}

	const rawQuestion = userIndex >= 0 ? messageText(messages[userIndex]?.content) : "";
	const question = stripHighLevelMarker(rawQuestion).text.trim();
	const replySlice = userIndex >= 0 ? messages.slice(userIndex + 1) : messages;
	const assistantEntries = replySlice
		.filter((message) => message.role === "assistant")
		.map((message) => ({
			id: message.id,
			text: messageText(message.content),
			toolTurn: message.stopReason === "toolUse" || hasToolCalls(message.content),
		}))
		.filter((item) => item.text.length > 0);

	if (assistantEntries.length === 0) {
		return { question, answer: "" };
	}

	const last = assistantEntries[assistantEntries.length - 1]!;
	if (assistantEntries.length === 1 || !isAnswerTooShort(last.text)) {
		return { question, answer: last.text, targetEntryId: last.id };
	}

	// If the final turn was just a short post-tool confirmation ("Tests pass.") after an
	// earlier substantive explanation in the same turn, keep that substantive explanation
	// while still dropping short procedural tool-call chatter ("Let me read core.ts...").
	const substantiveEarlier = assistantEntries
		.slice(0, -1)
		.filter((item) => !isAnswerTooShort(item.text))
		.map((item) => item.text);
	if (substantiveEarlier.length > 0) {
		const prev = substantiveEarlier[substantiveEarlier.length - 1]!;
		return {
			question,
			answer: `${prev}\n\n${last.text}`,
			targetEntryId: last.id,
		};
	}

	return { question, answer: last.text, targetEntryId: last.id };
}

export function answerSinceLastUser(messages: readonly ChatMessage[]): string {
	return extractTurnExchange(messages).answer;
}

export function nonEmptyLineCount(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	return trimmed
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean).length;
}

export function isAnswerTooShort(answer: string): boolean {
	const trimmed = answer.trim();
	if (!trimmed) return true;
	return trimmed.length < MIN_ANSWER_CHARS && nonEmptyLineCount(trimmed) < MIN_ANSWER_LINES;
}

export function shouldAutoSummarize(answer: string, auto: AutoSummaryConfig): boolean {
	if (!auto.enabled || isAnswerTooShort(answer)) return false;
	const trimmed = answer.trim();
	const totalLines = trimmed.split(/\r?\n/u).length;
	return trimmed.length >= auto.minChars || totalLines >= auto.minLines;
}

export function clipText(text: string, limit: number): { text: string; clipped: boolean } {
	if (text.length <= limit) {
		return { text, clipped: false };
	}
	const half = Math.floor(limit / 2);
	const head = text.slice(0, half);
	const tail = text.slice(-half);
	return {
		text: `${head}\n\n[...middle omitted...]\n\n${tail}`,
		clipped: true,
	};
}

export function clipAnswer(answer: string): { text: string; clipped: boolean } {
	return clipText(answer, ANSWER_LIMIT);
}

const BUILTIN_SUMMARY_INSTRUCTIONS = [
	"Summarize the assistant's final answer at a high level.",
	"Write 3 to 5 concise lines or bullets in the answer's language.",
	"Focus on the conclusion, key decision/trade-off, and concrete change or next step.",
	"Do not repeat intermediate steps, code blocks, or long file lists.",
	"Do not add a title or preamble.",
];

interface SummarySource {
	rawQuestion: string;
	safeQuestion: string;
	safeAnswer: string;
}

function summarySource(input: string | { question?: string; answer: string }): SummarySource {
	const rawQuestion = typeof input === "string" ? "" : (input.question ?? "").trim();
	const rawAnswer = typeof input === "string" ? input : input.answer;
	return {
		rawQuestion,
		safeQuestion: rawQuestion
			? clipText(rawQuestion, QUESTION_LIMIT).text.replaceAll("</question>", "</ question>")
			: "",
		safeAnswer: clipAnswer(rawAnswer).text.replaceAll("</answer>", "</ answer>"),
	};
}

function appendExchange(lines: string[], source: SummarySource): string[] {
	if (source.rawQuestion) {
		lines.push("", "<question>", source.safeQuestion, "</question>");
	}
	lines.push("", "<answer>", source.safeAnswer, "</answer>");
	return lines;
}

/**
 * `template` replaces the built-in instructions. `{{question}}` and `{{answer}}`
 * insert the clipped exchange. A template that uses neither placeholder still
 * receives both blocks after the instructions.
 */
export function buildSummaryPrompt(
	input: string | { question?: string; answer: string },
	template?: string,
): string {
	const source = summarySource(input);
	const custom = template?.trim() ?? "";
	if (!custom) {
		return appendExchange([...BUILTIN_SUMMARY_INSTRUCTIONS], source).join("\n");
	}

	const bounded = custom.length > MAX_PROMPT_TEMPLATE_CHARS ? custom.slice(0, MAX_PROMPT_TEMPLATE_CHARS) : custom;
	const hasQuestion = bounded.includes("{{question}}");
	const hasAnswer = bounded.includes("{{answer}}");
	const filled = bounded.replaceAll("{{question}}", source.safeQuestion).replaceAll("{{answer}}", source.safeAnswer);
	if (hasQuestion || hasAnswer) return filled;
	return appendExchange([filled], source).join("\n");
}

export function pickSummaryModel<T extends ModelCandidate>(
	spec: string | undefined,
	activeModel: T | undefined,
	candidates: readonly T[],
	hasAuth: (model: T) => boolean,
): T | undefined {
	const trimmed = spec?.trim();
	if (trimmed && trimmed !== "current" && trimmed !== "default") {
		if (trimmed === "auto") {
			const sameProviderLight = activeModel
				? candidates.find(
						(m) => m.provider === activeModel.provider && LIGHTWEIGHT_MODEL_RE.test(m.id) && hasAuth(m),
					)
				: undefined;
			if (sameProviderLight) return sameProviderLight;

			const anyLight = candidates.find((m) => LIGHTWEIGHT_MODEL_RE.test(m.id) && hasAuth(m));
			if (anyLight) return anyLight;
		} else {
			const slash = trimmed.indexOf("/");
			if (slash > 0) {
				const provider = trimmed.slice(0, slash);
				const id = trimmed.slice(slash + 1);
				const exact = candidates.find((m) => m.provider === provider && m.id === id && hasAuth(m));
				if (exact) return exact;
			} else {
				const lower = trimmed.toLowerCase();
				const sameProviderExact = activeModel
					? candidates.find(
							(m) => m.provider === activeModel.provider && m.id.toLowerCase() === lower && hasAuth(m),
						)
					: undefined;
				if (sameProviderExact) return sameProviderExact;

				const exact = candidates.find((m) => m.id.toLowerCase() === lower && hasAuth(m));
				if (exact) return exact;

				const fuzzy = candidates.find(
					(m) => `${m.provider}/${m.id}`.toLowerCase().includes(lower) && hasAuth(m),
				);
				if (fuzzy) return fuzzy;
			}
		}
	}

	if (activeModel && hasAuth(activeModel)) {
		return activeModel;
	}
	return undefined;
}

export function hasExistingCardForLatestReply(
	entries: readonly BranchEntryLike[],
	entryType = HIGH_LEVEL_ENTRY,
): boolean {
	let lastAssistantIndex = -1;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;
		if (entry.message?.role === "user") return false;
		if (entry.message?.role === "assistant" && messageText(entry.message.content)) {
			lastAssistantIndex = i;
			break;
		}
	}
	if (lastAssistantIndex === -1) return false;

	const targetId = entries[lastAssistantIndex]?.id;
	for (let i = lastAssistantIndex + 1; i < entries.length; i += 1) {
		const entry = entries[i];
		if (entry?.type === "custom" && entry.customType === entryType) {
			return true;
		}
	}
	if (targetId) {
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== entryType) continue;
			const data = entry.data as HighLevelCard | undefined;
			if (data?.targetEntryId && data.targetEntryId === targetId) return true;
		}
	}
	return false;
}

export function formatCardMeta(card: HighLevelCard): string | undefined {
	const parts: string[] = [];
	if (card.model) parts.push(card.model);
	if (typeof card.durationMs === "number" && Number.isFinite(card.durationMs)) {
		parts.push(card.durationMs >= 1_000 ? `${(card.durationMs / 1_000).toFixed(1)}s` : `${Math.round(card.durationMs)}ms`);
	}
	if (typeof card.sourceChars === "number" && card.sourceChars > 0) {
		parts.push(`from ${card.sourceChars.toLocaleString("en-US")} chars`);
	}
	if (card.trigger && card.trigger !== "marked") {
		parts.push(card.trigger);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

export class RunTracker {
	private idleArmed: SummaryTrigger | undefined;
	private commandArmed: { delivery: "idle" | "followUp"; trigger: SummaryTrigger } | undefined;
	private steerQueue: (SummaryTrigger | undefined)[] = [];
	private followUpQueue: (SummaryTrigger | undefined)[] = [];
	private activeTrigger: SummaryTrigger | undefined;
	private awaitingInitialUserMessage = false;

	reset(): void {
		this.idleArmed = undefined;
		this.commandArmed = undefined;
		this.steerQueue.length = 0;
		this.followUpQueue.length = 0;
		this.activeTrigger = undefined;
		this.awaitingInitialUserMessage = false;
	}

	armCommandPrompt(delivery: "idle" | "followUp", trigger: SummaryTrigger = "manual"): void {
		this.commandArmed = { delivery, trigger };
		if (delivery === "idle") {
			this.idleArmed = trigger;
		}
	}

	onInput(opts: {
		marked: boolean;
		source: "interactive" | "rpc" | "extension";
		streamingBehavior?: "steer" | "followUp";
	}): SummaryTrigger | undefined {
		let trigger: SummaryTrigger | undefined = opts.marked ? "marked" : undefined;
		if (opts.source === "extension" && this.commandArmed) {
			trigger = trigger ?? this.commandArmed.trigger;
			this.commandArmed = undefined;
		}

		if (opts.streamingBehavior === "steer") {
			this.steerQueue.push(trigger);
		} else if (opts.streamingBehavior === "followUp") {
			this.followUpQueue.push(trigger);
		} else {
			this.idleArmed = trigger;
		}
		return trigger;
	}

	onBeforeAgentStart(messageType: "user" | "custom"): void {
		if (messageType === "user") {
			this.activeTrigger = this.idleArmed ?? (this.commandArmed?.delivery === "idle" ? this.commandArmed.trigger : undefined);
			this.idleArmed = undefined;
			this.commandArmed = undefined;
			this.awaitingInitialUserMessage = true;
		} else {
			this.activeTrigger = undefined;
			this.awaitingInitialUserMessage = false;
		}
	}

	onUserMessageStart(): void {
		if (this.awaitingInitialUserMessage) {
			this.awaitingInitialUserMessage = false;
			return;
		}
		if (this.steerQueue.length > 0) {
			this.activeTrigger = this.steerQueue.shift();
			return;
		}
		if (this.followUpQueue.length > 0) {
			this.activeTrigger = this.followUpQueue.shift();
			return;
		}
		if (this.commandArmed?.delivery === "followUp") {
			this.activeTrigger = this.commandArmed.trigger;
			this.commandArmed = undefined;
			return;
		}
		this.activeTrigger = undefined;
	}

	toggleActiveTurn(): boolean {
		if (this.activeTrigger) {
			this.activeTrigger = undefined;
			return false;
		}
		this.activeTrigger = "shortcut";
		return true;
	}

	isArmed(): boolean {
		return Boolean(
			this.activeTrigger ||
				this.idleArmed ||
				this.commandArmed ||
				this.steerQueue.some(Boolean) ||
				this.followUpQueue.some(Boolean),
		);
	}

	hasQueuedUserTurns(): boolean {
		return (
			this.steerQueue.length > 0 ||
			this.followUpQueue.length > 0 ||
			this.commandArmed?.delivery === "followUp"
		);
	}

	consumeAtTurnEnd(opts: {
		completed: boolean;
		hasToolCalls: boolean;
		willContinue: boolean;
		hasPendingMessages: boolean;
	}): SummaryTrigger | undefined {
		if (!opts.completed || opts.hasToolCalls || opts.willContinue) {
			return undefined;
		}
		if (!this.hasQueuedUserTurns() && !opts.hasPendingMessages) {
			return undefined;
		}
		const trigger = this.activeTrigger;
		this.activeTrigger = undefined;
		return trigger;
	}

	consumeBeforeSettle(opts: {
		completed: boolean;
		willContinue: boolean;
		hasPendingMessages: boolean;
	}): SummaryTrigger | undefined {
		if (opts.willContinue || opts.hasPendingMessages) {
			return undefined;
		}
		const trigger = this.activeTrigger;
		this.activeTrigger = undefined;
		return opts.completed ? trigger : undefined;
	}
}

function fitPlainLine(line: string, targetWidth: number, measure: (line: string) => number): string {
	if (targetWidth <= 0) return "";
	if (measure(line) <= targetWidth || line.includes("\u001b")) return line;
	let end = Math.min(line.length, targetWidth);
	while (end > 0 && measure(line.slice(0, end)) > targetWidth) end -= 1;
	return line.slice(0, end);
}

export function frameLines(
	body: readonly string[],
	width: number,
	paint: (text: string) => string,
	measure: (line: string) => number = (line) => line.length,
	paintBg?: (line: string) => string,
): string[] {
	const columns = Math.floor(width);
	if (columns <= 0) return [];
	const wrapBg = (line: string) => (paintBg ? paintBg(line) : line);

	if (columns < 6) {
		return (body.length > 0 ? body : [""]).map((raw) => {
			const fitted = fitPlainLine(raw, columns, measure);
			const pad = Math.max(0, columns - measure(fitted));
			return wrapBg(`${fitted}${" ".repeat(pad)}`);
		});
	}

	let label = "";
	let prefix = "╭";
	if (columns >= LABEL.length + 4) {
		label = LABEL;
		prefix = "╭─";
	} else if (columns >= SHORT_LABEL.length + 4) {
		label = SHORT_LABEL;
		prefix = "╭─";
	}
	const dashes = Math.max(0, columns - prefix.length - label.length - 1);
	const top = wrapBg(paint(`${prefix}${label}${"─".repeat(dashes)}╮`));
	const bottom = wrapBg(paint(`╰${"─".repeat(columns - 2)}╯`));
	const inner = columns - 4;

	const lines = body.map((line) => {
		const fitted = fitPlainLine(line, inner, measure);
		const pad = Math.max(0, inner - measure(fitted));
		return wrapBg(`${paint("│ ")}${fitted}${" ".repeat(pad)}${paint(" │")}`);
	});
	return [top, ...lines, bottom];
}
