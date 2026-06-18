import { describe, expect, test } from "bun:test";
import type { ModelsConfigResponse, SnapshotResponse } from "@oh-my-pi/pi-ai";
import { buildGatewayModelIndex, isGatewayCatalogBaseUrlAllowed } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";

const REFRESHER = {
	enabled: false,
	intervalMs: 0,
	skewMs: 0,
	nextSweepInMs: Number.MAX_SAFE_INTEGER,
};

function snapshot(providers: string[]): SnapshotResponse {
	return {
		generation: 1,
		generatedAt: 100,
		serverNowMs: 100,
		refresher: REFRESHER,
		credentials: providers.map((provider, index) => ({
			id: index + 1,
			provider,
			credential: { type: "api_key", key: `${provider}-key` },
			identityKey: null,
			rotatesInMs: null,
		})),
	};
}

function catalog(providers: ModelsConfigResponse["providers"]): ModelsConfigResponse {
	return {
		generatedAt: 200,
		schemaVersion: 1,
		providers,
	};
}

describe("auth-gateway broker-served catalog", () => {
	test("adds enabled broker catalog models for credentialed and keyless providers", () => {
		const index = buildGatewayModelIndex(
			snapshot(["acme"]),
			catalog({
				acme: {
					baseUrl: "https://acme.example/v1",
					api: "openai-completions",
					headers: { "X-Team": "platform" },
					models: [{ id: "custom-chat", name: "Custom Chat" }],
				},
				keyless: {
					baseUrl: "https://keyless.example/v1",
					api: "openai-completions",
					auth: "none",
					models: [{ id: "free-chat" }],
				},
			}),
			{ enabled: true, allowedBaseUrls: [] },
		);

		const credentialed = index.byId.get("acme/custom-chat");
		expect(credentialed?.provider).toBe("acme");
		expect(credentialed?.baseUrl).toBe("https://acme.example/v1");
		expect(credentialed?.headers).toEqual({ "X-Team": "platform" });
		expect(index.byId.get("custom-chat")).toBe(credentialed);

		const keyless = index.byId.get("keyless/free-chat");
		expect(keyless?.provider).toBe("keyless");
		expect(keyless?.auth).toBe("none");
		expect(keyless ? index.models.includes(keyless) : false).toBe(true);
	});

	test("ignores catalog models when disabled or baseUrl is outside the allowlist", () => {
		const response = catalog({
			acme: {
				baseUrl: "https://acme.example/v1/models",
				api: "openai-completions",
				models: [{ id: "custom-chat" }],
			},
		});

		expect(
			buildGatewayModelIndex(snapshot(["acme"]), response, { enabled: false, allowedBaseUrls: [] }).byId.has(
				"acme/custom-chat",
			),
		).toBe(false);
		expect(
			buildGatewayModelIndex(snapshot(["acme"]), response, {
				enabled: true,
				allowedBaseUrls: ["https://acme.example/v10"],
			}).byId.has("acme/custom-chat"),
		).toBe(false);
		expect(
			buildGatewayModelIndex(
				snapshot(["acme"]),
				catalog({
					acme: {
						baseUrl: "https://acme.example/v1",
						api: "openai-completions",
						models: [{ id: "override", baseUrl: "https://evil.example/v1" }],
					},
				}),
				{ enabled: true, allowedBaseUrls: ["https://acme.example/v1"] },
			).byId.has("acme/override"),
		).toBe(false);
		expect(
			buildGatewayModelIndex(snapshot(["acme"]), response, {
				enabled: true,
				allowedBaseUrls: ["https://acme.example/v1"],
			}).byId.has("acme/custom-chat"),
		).toBe(true);
	});

	test("full rebuild drops models removed from the latest catalog", () => {
		const initial = buildGatewayModelIndex(
			snapshot(["acme"]),
			catalog({
				acme: { baseUrl: "https://acme.example/v1", api: "openai-completions", models: [{ id: "old" }] },
			}),
			{ enabled: true, allowedBaseUrls: [] },
		);
		const next = buildGatewayModelIndex(
			snapshot(["acme"]),
			catalog({
				acme: { baseUrl: "https://acme.example/v1", api: "openai-completions", models: [{ id: "new" }] },
			}),
			{ enabled: true, allowedBaseUrls: [] },
		);

		expect(initial.byId.has("acme/old")).toBe(true);
		expect(next.byId.has("acme/old")).toBe(false);
		expect(next.byId.has("acme/new")).toBe(true);
	});

	test("baseUrl allowlist is URL-aware", () => {
		expect(isGatewayCatalogBaseUrlAllowed("https://api.example.com/v1/models", ["https://api.example.com/v1"])).toBe(
			true,
		);
		expect(isGatewayCatalogBaseUrlAllowed("https://api.example.com/v10", ["https://api.example.com/v1"])).toBe(false);
		expect(isGatewayCatalogBaseUrlAllowed("https://api.example.com.evil.test/v1", ["https://api.example.com"])).toBe(
			false,
		);
		expect(isGatewayCatalogBaseUrlAllowed("https://api.example.com:8443/v1", ["https://api.example.com/v1"])).toBe(
			false,
		);
	});
});
