import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ReadToolGroupComponent,
	readArgsTargetInternalUrl,
} from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { readToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/read";
import {
	decodePartialJsonStringFragment,
	extractPartialJsonFilePath,
	extractPartialJsonString,
} from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

async function getUiTheme() {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	const t = await themeModule.getThemeByName("dark");
	expect(t).toBeDefined();
	return t!;
}

describe("extractPartialJsonString", () => {
	it("returns undefined for missing/empty buffer or absent key", () => {
		expect(extractPartialJsonString(undefined, "path")).toBeUndefined();
		expect(extractPartialJsonString("", "path")).toBeUndefined();
		expect(extractPartialJsonString('{"other":"x"}', "path")).toBeUndefined();
	});

	it("recovers a complete string value", () => {
		expect(extractPartialJsonString('{"path":"/tmp/foo.txt"}', "path")).toBe("/tmp/foo.txt");
	});

	it("recovers a value whose closing quote has not arrived yet", () => {
		// Streaming chunk: opening `"` is in the buffer, closing `"` is not.
		expect(extractPartialJsonString('{"path":"/tmp/foo.txt', "path")).toBe("/tmp/foo.txt");
	});

	it("decodes JSON escapes inside the recovered fragment", () => {
		expect(extractPartialJsonString('{"path":"a\\nb\\tc"', "path")).toBe("a\nb\tc");
	});

	it("trims a trailing unfinished `\\uXXXX` escape", () => {
		expect(decodePartialJsonStringFragment("abc\\u12")).toBe("abc");
		expect(extractPartialJsonString('{"path":"abc\\u12', "path")).toBe("abc");
	});

	it("drops an orphaned trailing backslash", () => {
		expect(decodePartialJsonStringFragment("abc\\")).toBe("abc");
	});

	it("falls back to raw text when JSON.parse cannot recover the fragment", () => {
		// Unbalanced double-quote inside the fragment — JSON.parse throws.
		// The regex peels the quote off before we get here; this guards the
		// pathological direct call.
		const raw = 'a"b';
		expect(decodePartialJsonStringFragment(raw)).toBe(raw);
	});
});

describe("extractPartialJsonFilePath", () => {
	it("prefers `path` over `file_path` when both are present", () => {
		expect(
			extractPartialJsonFilePath({
				__partialJson: '{"path":"/a","file_path":"/b"}',
			}),
		).toBe("/a");
	});

	it("falls back to legacy `file_path`", () => {
		expect(extractPartialJsonFilePath({ __partialJson: '{"file_path":"/legacy"' })).toBe("/legacy");
	});

	it("returns undefined without __partialJson", () => {
		expect(extractPartialJsonFilePath({})).toBeUndefined();
	});
});

describe("writeToolRenderer.renderCall — streaming __partialJson fallback", () => {
	it("surfaces the path from __partialJson before structured args parse", async () => {
		const uiTheme = await getUiTheme();
		const component = writeToolRenderer.renderCall(
			{ __partialJson: '{"path":"/tmp/hello.sh","content":"#!/bin/sh\\necho' } as never,
			{ expanded: false, isPartial: true, spinnerFrame: 0 } as never,
			uiTheme,
		);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("/tmp/hello.sh");
	});

	it("falls back to __partialJson for the legacy `file_path` key", async () => {
		const uiTheme = await getUiTheme();
		const component = writeToolRenderer.renderCall(
			{ __partialJson: '{"file_path":"/tmp/legacy.md","content":"hi' } as never,
			{ expanded: false, isPartial: true, spinnerFrame: 0 } as never,
			uiTheme,
		);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("/tmp/legacy.md");
	});

	it("prefers the structured `path` field when both sources are present", async () => {
		const uiTheme = await getUiTheme();
		const component = writeToolRenderer.renderCall(
			{
				path: "/tmp/structured.ts",
				__partialJson: '{"path":"/tmp/partial.ts"',
			} as never,
			{ expanded: false, isPartial: true, spinnerFrame: 0 } as never,
			uiTheme,
		);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("/tmp/structured.ts");
		expect(rendered).not.toContain("/tmp/partial.ts");
	});
});

describe("readToolRenderer.renderCall — streaming __partialJson fallback", () => {
	it("surfaces the path from __partialJson before structured args parse", async () => {
		const uiTheme = await getUiTheme();
		const component = readToolRenderer.renderCall(
			{ __partialJson: '{"path":"/tmp/notes.txt"' } as never,
			{} as never,
			uiTheme,
		);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("/tmp/notes.txt");
	});

	it("routes to the URL renderer when __partialJson reveals a URL target", async () => {
		const uiTheme = await getUiTheme();
		const component = readToolRenderer.renderCall(
			{ __partialJson: '{"path":"https://example.com/docs"' } as never,
			{} as never,
			uiTheme,
		);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		// URL renderer surfaces the host; the file-read renderer would emit a `Read:` prefix.
		expect(rendered).toContain("example.com");
	});
});

describe("readArgsTargetInternalUrl — partial-json aware", () => {
	it("recognises an internal URL streamed only via __partialJson", () => {
		expect(readArgsTargetInternalUrl({ __partialJson: '{"path":"skill://my-skill"' })).toBe(true);
		expect(readArgsTargetInternalUrl({ __partialJson: '{"file_path":"agent://abc"' })).toBe(true);
	});

	it("returns false for a filesystem path streamed only via __partialJson", () => {
		expect(readArgsTargetInternalUrl({ __partialJson: '{"path":"/tmp/foo.txt"' })).toBe(false);
	});

	it("ignores __partialJson when structured fields already carry a target", () => {
		// Structured path wins; partial buffer's stale value is irrelevant.
		expect(
			readArgsTargetInternalUrl({
				path: "/tmp/real.txt",
				__partialJson: '{"path":"skill://stale"',
			}),
		).toBe(false);
	});
});

describe("ReadToolGroupComponent.updateArgs — partial-json fallback", () => {
	it("renders the path from __partialJson when structured fields are still empty", () => {
		const group = new ReadToolGroupComponent();
		group.updateArgs({ __partialJson: '{"path":"/tmp/streamed.log"' } as never, "tc-1");
		const rendered = Bun.stripANSI(group.render(160).join("\n"));
		expect(rendered).toContain("/tmp/streamed.log");
	});

	it("appends `:sel` to the partial-json path", () => {
		const group = new ReadToolGroupComponent();
		group.updateArgs({ sel: "10-20", __partialJson: '{"path":"/tmp/range.log"' } as never, "tc-2");
		const rendered = Bun.stripANSI(group.render(160).join("\n"));
		expect(rendered).toContain("/tmp/range.log:10-20");
	});
});
