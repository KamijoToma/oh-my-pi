import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

const originalImageProtocol = TERMINAL.imageProtocol;

const RENDER_WIDTH = 120;

function erroredMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

function renderLines(message: AssistantMessage, hideThinkingBlock = false): string[] {
	const component = new AssistantMessageComponent(message, hideThinkingBlock);
	return Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"))
		.split("\n")
		.map(line => line.trimEnd());
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	setTerminalImageProtocol(null);
});

afterEach(() => {
	resetSettingsForTest();
	setTerminalImageProtocol(originalImageProtocol);
	// Bun:test fake timers leak if a test fails before calling useRealTimers();
	// restore real timers unconditionally to keep the rest of the suite safe.
	vi.useRealTimers();
});

describe("AssistantMessageComponent error rendering", () => {
	// A proxy 502 returns its own HTML page as the body; AnthropicApiError folds
	// that whole document into `errorMessage`. The inline transcript render must
	// not faithfully reprint every line, or the scrollback fills with the HTML
	// page's blank lines (the reported "weird terminal state").
	const longLine = "x".repeat(300);
	const body = Array.from({ length: 25 }, (_, i) => `marker-${i} <div>content</div>`).join("\n\n");
	const proxy502 = `${longLine}\n\n${body}`;

	it("drops the blank-line flood from a multi-line HTML error body", () => {
		const lines = renderLines(erroredMessage(proxy502));
		// The body interleaves 25 markers with blank lines (~50 source lines). If
		// blanks leaked through, the rendered block would be dozens of lines tall.
		const blankRun = lines.reduce(
			(acc, line) => {
				const run = line === "" ? acc.run + 1 : 0;
				return { run, max: Math.max(acc.max, run) };
			},
			{ run: 0, max: 0 },
		);
		expect(blankRun.max).toBeLessThanOrEqual(1);
		expect(lines.length).toBeLessThan(15);
	});

	it("clamps the line count of a runaway error body", () => {
		const lines = renderLines(erroredMessage(proxy502));
		const markerLines = lines.filter(line => line.includes("marker-"));
		// MAX_TRANSCRIPT_ERROR_LINES is 8; the first preview line is the long line,
		// so at most 7 markers survive — and the late ones are gone entirely.
		expect(markerLines.length).toBeLessThanOrEqual(8);
		expect(lines.some(line => line.includes("marker-0"))).toBe(true);
		expect(lines.some(line => line.includes("marker-24"))).toBe(false);
	});

	it("width-truncates an overlong error line", () => {
		const lines = renderLines(erroredMessage(proxy502));
		const head = lines.find(line => line.trim().startsWith("Error:"));
		expect(head).toBeDefined();
		// 300 'x' chars must not survive the render width; the line is truncated
		// with an ellipsis well under the 120-col terminal width.
		expect(head?.includes("…")).toBe(true);
		expect(head?.length).toBeLessThan(RENDER_WIDTH);
	});

	it("renders a short single-line error unchanged", () => {
		const lines = renderLines(erroredMessage("overloaded_error: Overloaded"));
		expect(lines.some(line => line.includes("Error: overloaded_error: Overloaded"))).toBe(true);
	});
});

describe("AssistantMessageComponent hidden thinking rendering", () => {
	function thinkingMessage(): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "Visible answer" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	it("renders a placeholder for hidden thinking instead of the reasoning text", () => {
		const lines = renderLines(thinkingMessage(), true);
		expect(lines.some(line => line.includes("thinking"))).toBe(true);
		expect(lines.some(line => line.includes("private reasoning"))).toBe(false);
		expect(lines.some(line => line.includes("Visible answer"))).toBe(true);
	});

	it("still renders thinking when it is not hidden", () => {
		const lines = renderLines(thinkingMessage());
		expect(lines.some(line => line.includes("private reasoning"))).toBe(true);
	});

	it("retains the duration placeholder when a finalized visible message is collapsed", () => {
		vi.useFakeTimers();
		const component = new AssistantMessageComponent(thinkingMessage(), false);
		const message = thinkingMessage();
		component.updateContent(message);
		vi.advanceTimersByTime(2500);
		component.markTranscriptBlockFinalized();
		expect(Bun.stripANSI(component.render(RENDER_WIDTH).join("\n")).includes("private reasoning")).toBe(true);

		component.setHideThinkingBlock(true);
		component.updateContent(message);
		const collapsed = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		expect(collapsed.includes("think for")).toBe(true);
		expect(collapsed.includes("private reasoning")).toBe(false);
		component.dispose();
		vi.useRealTimers();
	});
});

describe("AssistantMessageComponent streaming thinking placeholder", () => {
	// The in-flight streaming partial always carries stopReason "stop" (proxy.ts
	// seeds it), so "still streaming" is keyed off the block not yet being
	// finalized — a live component is constructed with no message.
	function streaming(content: AssistantMessage["content"]): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function liveLines(message: AssistantMessage, hideThinkingBlock = true): string[] {
		const component = new AssistantMessageComponent(undefined, hideThinkingBlock);
		component.updateContent(message);
		const lines = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"))
			.split("\n")
			.map(line => line.trimEnd());
		component.dispose();
		return lines;
	}

	it("shows a placeholder in place of hidden reasoning while thinking streams", () => {
		const lines = liveLines(streaming([{ type: "thinking", thinking: "private reasoning" }]));
		expect(lines.some(line => line.includes("thinking"))).toBe(true);
		expect(lines.some(line => line.includes("private reasoning"))).toBe(false);
	});

	it("shows the completed placeholder once visible text starts streaming", () => {
		const lines = liveLines(
			streaming([
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "Visible answer" },
			]),
		);
		expect(lines.some(line => line.includes("think for"))).toBe(true);
		expect(lines.some(line => line.includes("Visible answer"))).toBe(true);
	});

	it("does not show a placeholder when thinking is visible", () => {
		const lines = liveLines(streaming([{ type: "thinking", thinking: "private reasoning" }]), false);
		expect(lines.some(line => line.includes("thinking"))).toBe(false);
		expect(lines.some(line => line.includes("private reasoning"))).toBe(true);
	});

	it("shows the completed placeholder once a tool call streams", () => {
		const lines = liveLines(
			streaming([
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } },
			]),
		);
		expect(lines.some(line => line.includes("think for"))).toBe(true);
	});

	it("replaces the active placeholder with a duration when the block is finalized", () => {
		vi.useFakeTimers();
		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(streaming([{ type: "thinking", thinking: "private reasoning" }]));
		const beforeFinalize = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		expect(beforeFinalize.includes("thinking")).toBe(true);
		expect(beforeFinalize.includes("private reasoning")).toBe(false);

		vi.advanceTimersByTime(500);
		component.markTranscriptBlockFinalized();
		const afterFinalize = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		expect(afterFinalize.includes("think for 1s")).toBe(true);
		expect(afterFinalize.includes("private reasoning")).toBe(false);
		component.dispose();
	});

	it("keeps the placeholder across thinking deltas on a reused component, then shows it as completed when text arrives", () => {
		// Mirrors live streaming: one component reused across updateContent calls
		// until visible text arrives; the completed thinking placeholder stays.
		const component = new AssistantMessageComponent(undefined, true);
		const rendered = () => Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		component.updateContent(streaming([{ type: "thinking", thinking: "a" }]));
		expect(rendered().includes("thinking")).toBe(true);
		component.updateContent(streaming([{ type: "thinking", thinking: "ab" }]));
		expect(rendered().includes("thinking")).toBe(true);
		component.updateContent(
			streaming([
				{ type: "thinking", thinking: "abc" },
				{ type: "text", text: "Answer" },
			]),
		);
		expect(rendered().includes("think for")).toBe(true);
		expect(rendered().includes("Answer")).toBe(true);
		component.dispose();
	});
});
