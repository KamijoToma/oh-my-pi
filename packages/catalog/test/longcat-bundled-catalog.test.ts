import { describe, expect, it } from "bun:test";
import modelsJson from "../src/models.json";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { LONGCAT_STATIC_MODELS, longcatModelManagerOptions } from "../src/provider-models/openai-compat";

interface BundledModel {
	api: string;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number | null;
	maxTokens: number | null;
	compat?: Record<string, unknown>;
	thinking?: { mode: string; efforts: string[] };
}

describe("longcat descriptor", () => {
	it("exposes the longcat provider with the documented default model and env var", () => {
		expect(DEFAULT_MODEL_PER_PROVIDER.longcat).toBe("LongCat-2.0");

		const descriptor = PROVIDER_DESCRIPTORS.find(d => d.providerId === "longcat");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("LongCat-2.0");
	});

	it("uses the OpenAI-compatible base URL ending in /openai/v1", () => {
		const model = LONGCAT_STATIC_MODELS.find(m => m.id === "LongCat-2.0");
		expect(model?.baseUrl).toBe("https://api.longcat.chat/openai/v1");
	});

	it("resolves model-manager options without an API key (seed-only boot)", () => {
		const options = longcatModelManagerOptions({});
		expect(options.providerId).toBe("longcat");
		expect(options.fetchDynamicModels).toBeUndefined();
	});

	it("enables dynamic discovery when an API key is supplied", () => {
		const options = longcatModelManagerOptions({ apiKey: "test-key" });
		expect(options.fetchDynamicModels).toBeDefined();
	});
});

describe("longcat bundled catalog", () => {
	it("pins LongCat-2.0 with 1M context, 128K output, reasoning, and zai thinking format", () => {
		const longcatModels = modelsJson.longcat as Record<string, BundledModel>;
		const model = longcatModels["LongCat-2.0"];

		expect(model).toBeDefined();
		expect(model.provider).toBe("longcat");
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://api.longcat.chat/openai/v1");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(model.compat?.thinkingFormat).toBe("zai");
		expect(model.compat?.reasoningContentField).toBe("reasoning_content");
	});

	it("omits xhigh from thinking efforts — LongCat-2.0 thinking is binary (enabled/disabled)", () => {
		const longcatModels = modelsJson.longcat as Record<string, BundledModel>;
		const model = longcatModels["LongCat-2.0"];

		// LongCat-2.0 supports only `thinking: { type: "enabled" | "disabled" }` —
		// no discrete effort tiers. xhigh has no wire meaning and must not appear.
		expect(model.thinking?.efforts).toEqual(["minimal", "low", "medium", "high"]);
		expect(model.thinking?.efforts).not.toContain("xhigh");
	});
});
