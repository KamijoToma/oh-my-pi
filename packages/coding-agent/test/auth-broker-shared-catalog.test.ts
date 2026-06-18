import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { loadSharedBrokerCatalog, validateSharedBrokerCatalog } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
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
