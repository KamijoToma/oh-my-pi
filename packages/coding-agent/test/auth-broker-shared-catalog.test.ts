import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	loadSharedBrokerCatalog,
	startSharedCatalogAutoRefresh,
	validateSharedBrokerCatalog,
} from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { setAgentDir } from "@oh-my-pi/pi-utils";

const SECRET_ENV = "OMP_TEST_SHARED_CATALOG_KEY";

describe("auth-broker shared catalog", () => {
	let agentDir = "";
	let originalAgentDir: string | undefined;
	let originalSecret: string | undefined;

	beforeEach(async () => {
		originalAgentDir = process.env.OMP_AGENT_DIR;
		originalSecret = process.env[SECRET_ENV];
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shared-catalog-"));
		setAgentDir(agentDir);
		process.env[SECRET_ENV] = "resolved-broker-key";
	});

	afterEach(async () => {
		if (originalAgentDir === undefined) delete process.env.OMP_AGENT_DIR;
		else process.env.OMP_AGENT_DIR = originalAgentDir;
		if (originalSecret === undefined) delete process.env[SECRET_ENV];
		else process.env[SECRET_ENV] = originalSecret;
		await fs.rm(agentDir, { recursive: true, force: true });
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("loadSharedBrokerCatalog resolves apiKey on broker and serves sanitized catalog", async () => {
		const file = path.join(agentDir, "models-shared.yml");
		await Bun.write(
			file,
			[
				"providers:",
				"  acme:",
				"    baseUrl: https://acme.example/v1",
				`    apiKey: ${SECRET_ENV}`,
				"    api: openai-completions",
				"    headers:",
				"      X-Team: platform",
				"    models:",
				"      - id: acme-model",
				"        name: Acme Model",
				"equivalence:",
				"  overrides:",
				"    acme/alias: acme/acme-model",
				"",
			].join("\n"),
		);
		const store = await SqliteAuthCredentialStore.open(path.join(agentDir, "agent.db"));
		const storage = new AuthStorage(store);
		await storage.reload();
		try {
			const loaded = await loadSharedBrokerCatalog(file, storage);

			expect(loaded?.catalog.generatedAt).toBeGreaterThan(0);
			expect(loaded?.catalog.schemaVersion).toBe(1);
			expect(loaded?.catalog.providers.acme).toEqual({
				baseUrl: "https://acme.example/v1",
				api: "openai-completions",
				headers: { "X-Team": "platform" },
				models: [{ id: "acme-model", name: "Acme Model" }],
			});
			expect(loaded?.catalog.equivalence).toEqual({ overrides: { "acme/alias": "acme/acme-model" } });
			expect(storage.listStoredCredentials("acme")[0]?.credential).toEqual({
				type: "api_key",
				key: "resolved-broker-key",
			});
		} finally {
			storage.close();
			store.close();
		}
	});

	test("validateSharedBrokerCatalog rejects secret-bearing fields", () => {
		expect(() =>
			validateSharedBrokerCatalog({
				providers: { acme: { baseUrl: "https://acme.example/v1", apiKey: "sk-test-abcdefghijklmnopqrstuvwxyz" } },
			}),
		).toThrow(/literal secret/);
		expect(() =>
			validateSharedBrokerCatalog({
				providers: { acme: { baseUrl: "https://acme.example/v1", apiKey: "" } },
			}),
		).toThrow(/empty apiKey/);
		expect(() =>
			validateSharedBrokerCatalog({
				providers: { acme: { baseUrl: "https://acme.example/v1", headers: { Authorization: SECRET_ENV } } },
			}),
		).toThrow(/secret-bearing header/);
		expect(() =>
			validateSharedBrokerCatalog({
				providers: { acme: { baseUrl: "https://acme.example/v1", authHeader: true } },
			}),
		).toThrow(/authHeader/);
		expect(() =>
			validateSharedBrokerCatalog({
				providers: { acme: { baseUrl: "https://acme.example/v1", transport: "pi-native" } },
			}),
		).toThrow(/transport/);
		expect(() =>
			validateSharedBrokerCatalog({
				providers: { acme: { baseUrl: "https://acme.example/v1", apiKey: "test-key" } },
			}),
		).toThrow(/apiKey reference/);
		expect(() =>
			validateSharedBrokerCatalog({
				providers: {
					acme: {
						baseUrl: "https://acme.example/v1",
						models: [{ id: "acme-model", headers: { Authorization: "sk-test-abcdefghijklmnopqrstuvwxyz" } }],
					},
				},
			}),
		).toThrow(/model acme-model header/);
		expect(() =>
			validateSharedBrokerCatalog({
				providers: {
					acme: {
						baseUrl: "https://acme.example/v1",
						modelOverrides: { "acme-model": { headers: { Authorization: SECRET_ENV } } },
					},
				},
			}),
		).toThrow(/model override acme-model header/);
		expect(() =>
			validateSharedBrokerCatalog({
				providers: {
					acme: {
						baseUrl: "https://acme.example/v1",
						models: [{ id: "acme-model", apiKey: SECRET_ENV } as never],
					},
				},
			}),
		).toThrow(/model acme-model apiKey/);
		expect(() =>
			validateSharedBrokerCatalog({
				providers: {
					acme: {
						baseUrl: "https://acme.example/v1",
						modelOverrides: { "acme-model": { apiKey: SECRET_ENV } as never },
					},
				},
			}),
		).toThrow(/model override acme-model apiKey/);
		expect(() =>
			validateSharedBrokerCatalog({
				providers: {
					acme: {
						baseUrl: "https://acme.example/v1",
						token: "sk-test-abcdefghijklmnopqrstuvwxyz",
					} as never,
				},
			}),
		).toThrow(/unknown field token/);
	});

	test("loadSharedBrokerCatalog can opt into local literal apiKey ingestion without serving it", async () => {
		const file = path.join(agentDir, "models-shared.yml");
		await Bun.write(
			file,
			[
				"providers:",
				"  acme:",
				"    baseUrl: https://acme.example/v1",
				"    apiKey: sk-test-abcdefghijklmnopqrstuvwxyz",
				"    api: openai-completions",
				"    authHeader: true",
				"    models:",
				"      - id: acme-model",
				"",
			].join("\n"),
		);
		const store = await SqliteAuthCredentialStore.open(path.join(agentDir, "agent.db"));
		const storage = new AuthStorage(store);
		await storage.reload();
		try {
			await expect(loadSharedBrokerCatalog(file, storage)).rejects.toThrow(/literal secret/);

			const loaded = await loadSharedBrokerCatalog(file, storage, new Map(), {
				dangerouslyAllowLocalRawKeys: true,
			});

			expect(loaded?.catalog.providers.acme).toEqual({
				baseUrl: "https://acme.example/v1",
				api: "openai-completions",
				models: [{ id: "acme-model" }],
			});
			expect(loaded?.catalog.providers.acme).not.toHaveProperty("authHeader");
			expect(storage.listStoredCredentials("acme")[0]?.credential).toEqual({
				type: "api_key",
				key: "sk-test-abcdefghijklmnopqrstuvwxyz",
			});
		} finally {
			storage.close();
			store.close();
		}
	});

	test("loadSharedBrokerCatalog returns an empty served catalog after removing a previously loaded file", async () => {
		const store = await SqliteAuthCredentialStore.open(path.join(agentDir, "agent.db"));
		const storage = new AuthStorage(store);
		await storage.reload();
		try {
			const file = path.join(agentDir, "models-shared.yml");
			await Bun.write(
				file,
				`providers:\n  acme:\n    baseUrl: https://acme.example/v1\n    apiKey: ${SECRET_ENV}\n    api: openai-completions\n    models:\n      - id: acme-model\n`,
			);
			const first = await loadSharedBrokerCatalog(file, storage);
			expect(storage.listStoredCredentials("acme")).toHaveLength(1);
			await fs.rm(file);

			const loaded = await loadSharedBrokerCatalog(file, storage, first?.brokerOwnedCredentials);

			expect(loaded?.catalog.providers).toEqual({});
			expect(loaded?.brokerOwnedCredentials.size).toBe(0);
			await storage.reload();
			expect(storage.listStoredCredentials("acme")).toEqual([]);
		} finally {
			storage.close();
			store.close();
		}
	});

	test("loadSharedBrokerCatalog materializes broker-side discovery before serving", async () => {
		const file = path.join(agentDir, "models-shared.yml");
		await Bun.write(
			file,
			[
				"providers:",
				"  acme:",
				"    baseUrl: https://acme.example/v1",
				"    apiKey: sk-test-abcdefghijklmnopqrstuvwxyz",
				"    authHeader: true",
				"    api: openai-completions",
				"    discovery:",
				"      type: openai-models-list",
				"",
			].join("\n"),
		);
		let authorization: string | undefined;
		const store = await SqliteAuthCredentialStore.open(path.join(agentDir, "agent.db"));
		const storage = new AuthStorage(store);
		await storage.reload();
		try {
			const loaded = await loadSharedBrokerCatalog(file, storage, new Map(), {
				dangerouslyAllowLocalRawKeys: true,
				fetch: async (input, init) => {
					expect(String(input)).toBe("https://acme.example/v1/models");
					authorization = new Headers(init?.headers).get("authorization") ?? undefined;
					return Response.json({
						data: [
							{
								id: "acme-model",
								name: "Acme Model",
								contextWindow: 123456,
								maxTokens: 7890,
								reasoning: true,
								input: ["text", "image"],
							},
						],
					});
				},
			});

			expect(authorization).toBe("Bearer sk-test-abcdefghijklmnopqrstuvwxyz");
			expect(loaded?.catalog.providers.acme).toMatchObject({
				baseUrl: "https://acme.example/v1",
				api: "openai-completions",
				models: [
					{
						id: "acme-model",
						name: "Acme Model",
						contextWindow: 123456,
						maxTokens: 7890,
						reasoning: true,
						input: ["text", "image"],
					},
				],
			});
			expect(loaded?.catalog.providers.acme).not.toHaveProperty("apiKey");
			expect(loaded?.catalog.providers.acme).not.toHaveProperty("authHeader");
		} finally {
			storage.close();
			store.close();
		}
	});

	test("loadSharedBrokerCatalog keeps other discovered providers when one discovery fails", async () => {
		const file = path.join(agentDir, "models-shared.yml");
		await Bun.write(
			file,
			[
				"providers:",
				"  blocked:",
				"    baseUrl: https://blocked.example/v1",
				"    apiKey: sk-blocked-abcdefghijklmnopqrstuvwxyz",
				"    authHeader: true",
				"    discovery:",
				"      type: proxy",
				"  acme:",
				"    baseUrl: https://acme.example/v1",
				"    apiKey: sk-test-abcdefghijklmnopqrstuvwxyz",
				"    authHeader: true",
				"    discovery:",
				"      type: proxy",
				"",
			].join("\n"),
		);
		const store = await SqliteAuthCredentialStore.open(path.join(agentDir, "agent.db"));
		const storage = new AuthStorage(store);
		await storage.reload();
		try {
			const loaded = await loadSharedBrokerCatalog(file, storage, new Map(), {
				dangerouslyAllowLocalRawKeys: true,
				fetch: async input => {
					const url = String(input);
					if (url === "https://blocked.example/v1/models") return new Response("blocked", { status: 403 });
					if (url === "https://acme.example/v1/models") {
						return Response.json({ data: [{ id: "acme-model", supported_endpoint_types: ["openai"] }] });
					}
					throw new Error(`Unexpected URL: ${url}`);
				},
			});

			expect(loaded?.catalog.providers.blocked.models).toBeUndefined();
			expect(loaded?.catalog.providers.acme.models?.map(model => model.id)).toEqual(["acme-model"]);
		} finally {
			storage.close();
			store.close();
		}
	});

	async function flushMicrotasks(): Promise<void> {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	}
	test("shared catalog auto refresh runs on the configured interval", async () => {
		vi.useFakeTimers();
		let reloads = 0;
		const stop = startSharedCatalogAutoRefresh({
			intervalMs: 1000,
			reload: async () => {
				reloads += 1;
				return {
					generatedAt: reloads,
					schemaVersion: 1,
					providers: {},
				};
			},
		});
		try {
			expect(reloads).toBe(0);
			vi.advanceTimersByTime(1000);
			await flushMicrotasks();
			expect(reloads).toBe(1);
			vi.advanceTimersByTime(1000);
			await flushMicrotasks();
			expect(reloads).toBe(2);
		} finally {
			stop?.();
		}
	});

	test("shared catalog auto refresh skips overlapping reloads", async () => {
		vi.useFakeTimers();
		const pending = Promise.withResolvers<void>();
		let reloads = 0;
		const stop = startSharedCatalogAutoRefresh({
			intervalMs: 1000,
			reload: async () => {
				reloads += 1;
				await pending.promise;
				return {
					generatedAt: reloads,
					schemaVersion: 1,
					providers: {},
				};
			},
		});
		try {
			vi.advanceTimersByTime(1000);
			await flushMicrotasks();
			expect(reloads).toBe(1);
			vi.advanceTimersByTime(3000);
			await flushMicrotasks();
			expect(reloads).toBe(1);
			pending.resolve();
			await flushMicrotasks();
			vi.advanceTimersByTime(1000);
			await flushMicrotasks();
			expect(reloads).toBe(2);
		} finally {
			pending.resolve();
			stop?.();
		}
	});

	test("loadSharedBrokerCatalog rejects unresolved env apiKey references", async () => {
		delete process.env[SECRET_ENV];
		const file = path.join(agentDir, "models-shared.yml");
		await Bun.write(
			file,
			[
				"providers:",
				"  acme:",
				"    baseUrl: https://acme.example/v1",
				`    apiKey: ${SECRET_ENV}`,
				"    api: openai-completions",
				"    models:",
				"      - id: acme-model",
				"",
			].join("\n"),
		);
		const store = await SqliteAuthCredentialStore.open(path.join(agentDir, "agent.db"));
		const storage = new AuthStorage(store);
		await storage.reload();
		try {
			await expect(loadSharedBrokerCatalog(file, storage)).rejects.toThrow(/Unable to resolve apiKey/);
			expect(storage.listStoredCredentials("acme")).toHaveLength(0);
		} finally {
			storage.close();
			store.close();
		}
	});

	test("loadSharedBrokerCatalog removes broker-owned API keys for removed providers", async () => {
		const store = await SqliteAuthCredentialStore.open(path.join(agentDir, "agent.db"));
		const storage = new AuthStorage(store);
		await storage.reload();
		const firstFile = path.join(agentDir, "models-shared.yml");
		const secondFile = path.join(agentDir, "models-shared-next.yml");
		await Bun.write(
			firstFile,
			[
				"providers:",
				"  acme:",
				"    baseUrl: https://acme.example/v1",
				`    apiKey: ${SECRET_ENV}`,
				"    api: openai-completions",
				"    models:",
				"      - id: acme-model",
				"  keyless:",
				"    baseUrl: https://keyless.example/v1",
				"    auth: none",
				"    api: openai-completions",
				"    models:",
				"      - id: free-model",
				"",
			].join("\n"),
		);
		await Bun.write(
			secondFile,
			"providers:\n  keyless:\n    baseUrl: https://keyless.example/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: free-model\n",
		);
		try {
			const first = await loadSharedBrokerCatalog(firstFile, storage);
			expect(storage.listStoredCredentials("acme")).toHaveLength(1);

			await loadSharedBrokerCatalog(secondFile, storage, first?.brokerOwnedCredentials);

			expect(storage.listStoredCredentials("acme")).toHaveLength(0);
			expect(storage.listStoredCredentials("keyless")).toHaveLength(0);
		} finally {
			storage.close();
			store.close();
		}
	});

	test("loadSharedBrokerCatalog removes only shared API keys for removed providers", async () => {
		const store = await SqliteAuthCredentialStore.open(path.join(agentDir, "agent.db"));
		const storage = new AuthStorage(store);
		await storage.reload();
		await storage.set("acme", {
			type: "oauth",
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 60_000,
			email: "user@example.com",
		});
		const firstFile = path.join(agentDir, "models-shared.yml");
		const secondFile = path.join(agentDir, "models-shared-next.yml");
		await Bun.write(
			firstFile,
			[
				"providers:",
				"  acme:",
				"    baseUrl: https://acme.example/v1",
				`    apiKey: ${SECRET_ENV}`,
				"    api: openai-completions",
				"    models:",
				"      - id: acme-model",
				"",
			].join("\n"),
		);
		await Bun.write(secondFile, "providers: {}\n");
		try {
			const first = await loadSharedBrokerCatalog(firstFile, storage);
			expect(storage.listStoredCredentials("acme")).toHaveLength(2);

			await loadSharedBrokerCatalog(secondFile, storage, first?.brokerOwnedCredentials);

			const remaining = storage.listStoredCredentials("acme");
			expect(remaining).toHaveLength(1);
			expect(remaining[0].credential.type).toBe("oauth");
		} finally {
			storage.close();
			store.close();
		}
	});

	test("loadSharedBrokerCatalog does not claim pre-existing matching API keys", async () => {
		const store = await SqliteAuthCredentialStore.open(path.join(agentDir, "agent.db"));
		const storage = new AuthStorage(store);
		await storage.reload();
		await storage.set("acme", { type: "api_key", key: "resolved-broker-key" });
		const firstFile = path.join(agentDir, "models-shared.yml");
		const secondFile = path.join(agentDir, "models-shared-next.yml");
		await Bun.write(
			firstFile,
			[
				"providers:",
				"  acme:",
				"    baseUrl: https://acme.example/v1",
				`    apiKey: ${SECRET_ENV}`,
				"    api: openai-completions",
				"    models:",
				"      - id: acme-model",
				"",
			].join("\n"),
		);
		await Bun.write(secondFile, "providers: {}\n");
		try {
			const first = await loadSharedBrokerCatalog(firstFile, storage);
			expect(storage.listStoredCredentials("acme")).toHaveLength(1);

			await loadSharedBrokerCatalog(secondFile, storage, first?.brokerOwnedCredentials);

			const remaining = storage.listStoredCredentials("acme");
			expect(remaining).toHaveLength(1);
			expect(remaining[0].credential).toEqual({ type: "api_key", key: "resolved-broker-key" });
		} finally {
			storage.close();
			store.close();
		}
	});
});
