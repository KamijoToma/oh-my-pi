/**
 * ArkType schemas for the auth-broker wire protocol.
 *
 * Shared between the server (validates inbound request bodies) and the client
 * (validates responses from the broker). Schemas mirror the TypeScript types
 * in `./types.ts` 1:1; the types remain the source of truth for static typing,
 * and `Type` is asserted-compatible with them where possible.
 *
 * Envelope and fixed-shape schemas use `"+": "reject"` so unknown keys are
 * rejected — the previous implementation used a hand-rolled `hasOnlyFields`
 * allowlist for the same effect. The OAuth credential schema is the deliberate
 * exception (standard type keeps extra keys): it preserves provider-specific extension fields so
 * they round-trip through the broker instead of being dropped (see below).
 */
import { type } from "arktype";
import { REMOTE_REFRESH_SENTINEL } from "../auth-storage";

// ─── Credential payloads ───────────────────────────────────────────────────

/** Real OAuth credential (broker-side) — refresh token is the actual upstream value. */
export const oauthCredentialSchema = type({
	"apiEndpoint?": "string",
	type: "'oauth'",
	refresh: type("string").narrow(
		(value, ctx) =>
			value !== REMOTE_REFRESH_SENTINEL ||
			ctx.mustBe(`not equal to the remote sentinel (${REMOTE_REFRESH_SENTINEL})`),
	),
	access: type("string").atLeastLength(1),
	expires: "number",
	"enterpriseUrl?": "string",
	"projectId?": "string",
	"email?": "string",
	"accountId?": "string",
});

/** OAuth credential as it appears in broker snapshots — refresh replaced with sentinel. */
export const remoteOauthCredentialSchema = type({
	"apiEndpoint?": "string",
	type: "'oauth'",
	refresh: type.enumerated(REMOTE_REFRESH_SENTINEL),
	access: type("string").atLeastLength(1),
	expires: "number",
	"enterpriseUrl?": "string",
	"projectId?": "string",
	"email?": "string",
	"accountId?": "string",
});

export const apiKeyCredentialSchema = type({
	"+": "reject",
	type: "'api_key'",
	key: type("string").atLeastLength(1),
});

/** Discriminated union accepted on POST /v1/credential (writes). */
export const writableAuthCredentialSchema = oauthCredentialSchema.or(apiKeyCredentialSchema);

/** Discriminated union returned in snapshots (refresh is sentinel for OAuth). */
export const snapshotCredentialSchema = remoteOauthCredentialSchema.or(apiKeyCredentialSchema);

// ─── Snapshot ──────────────────────────────────────────────────────────────

export const credentialSnapshotEntrySchema = type({
	"+": "reject",
	id: "number.integer",
	provider: type("string").atLeastLength(1),
	credential: snapshotCredentialSchema,
	identityKey: "string | null",
});

export const snapshotEntrySchema = type({
	"+": "reject",
	id: "number.integer",
	provider: type("string").atLeastLength(1),
	credential: snapshotCredentialSchema,
	identityKey: "string | null",
	rotatesInMs: "number | null",
});

export const refresherScheduleSchema = type({
	"+": "reject",
	enabled: "boolean",
	intervalMs: "number",
	skewMs: "number",
	nextSweepInMs: "number",
});

export const snapshotResponseSchema = type({
	"+": "reject",
	generation: "number.integer",
	generatedAt: "number",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	credentials: snapshotEntrySchema.array(),
});

// ─── Snapshot stream (SSE) ────────────────────────────────────────────────

/** First frame on connect — full snapshot embedded inline with a `kind` tag. */
export const snapshotStreamSnapshotEventSchema = type({
	"+": "reject",
	generation: "number.integer",
	generatedAt: "number",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	credentials: snapshotEntrySchema.array(),
	kind: "'snapshot'",
});

/** Per-credential upsert/refresh delta. */
export const snapshotStreamEntryEventSchema = type({
	"+": "reject",
	kind: "'entry'",
	generation: "number.integer",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	entry: snapshotEntrySchema,
});

/** Per-credential delete delta. */
export const snapshotStreamRemovedEventSchema = type({
	"+": "reject",
	kind: "'removed'",
	generation: "number.integer",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	id: "number.integer",
});

/** Discriminated union over every event frame the snapshot stream emits. */
export const snapshotStreamCatalogChangedEventSchema = type({
	"+": "reject",
	kind: "'catalog-changed'",
	generatedAt: "number",
});

/** Discriminated union over every known event frame the snapshot stream emits. */
export const snapshotStreamEventSchema = snapshotStreamSnapshotEventSchema
	.or(snapshotStreamEntryEventSchema)
	.or(snapshotStreamRemovedEventSchema)
	.or(snapshotStreamCatalogChangedEventSchema);

// ─── Healthz ────────────────────────────────────────────────────────────────

export const healthzResponseSchema = type({
	"+": "reject",
	ok: "boolean",
	"version?": "string",
});

// ─── Usage ─────────────────────────────────────────────────────────────────

const usageUnitSchema = type("'percent' | 'tokens' | 'requests' | 'usd' | 'minutes' | 'bytes' | 'unknown'");
const usageStatusSchema = type("'ok' | 'warning' | 'exhausted' | 'unknown'");

const usageWindowSchema = type({
	id: "string",
	label: "string",
	"durationMs?": "number",
	"resetsAt?": "number",
});

const usageAmountSchema = type({
	"used?": "number",
	"limit?": "number",
	"remaining?": "number",
	"usedFraction?": "number",
	"remainingFraction?": "number",
	unit: usageUnitSchema,
});

const usageScopeSchema = type({
	provider: "string",
	"accountId?": "string",
	"projectId?": "string",
	"orgId?": "string",
	"modelId?": "string",
	"tier?": "string",
	"windowId?": "string",
	"shared?": "boolean",
});

const usageLimitSchema = type({
	id: "string",
	label: "string",
	scope: usageScopeSchema,
	"window?": usageWindowSchema,
	amount: usageAmountSchema,
	"status?": usageStatusSchema,
	"notes?": "string[]",
});

const usageResetCreditsSchema = type({
	availableCount: "number",
});

const arkUsageReportSchema = type({
	provider: "string",
	fetchedAt: "number",
	limits: usageLimitSchema.array(),
	"resetCredits?": usageResetCreditsSchema,
	"metadata?": { "[string]": "unknown" },
	"raw?": "unknown",
});

/**
 * Broker `/v1/usage` response. Reports are full {@link UsageReport}s minus the
 * heavy provider-specific `raw` field (the server strips it before send) — we
 * keep `raw` optional in the underlying schema so a misconfigured broker that
 * forgot to strip still validates.
 */
export const usageResponseSchema = type({
	"+": "reject",
	generatedAt: "number",
	reports: arkUsageReportSchema.array(),
});

// ─── Catalog ────────────────────────────────────────────────────────────────

const effortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);
const thinkingConfigSchema = z
	.object({
		mode: z.string(),
		efforts: z.array(effortSchema).min(1),
		defaultLevel: effortSchema.optional(),
		effortMap: z.record(z.string(), z.string()).optional(),
		supportsDisplay: z.boolean().optional(),
		effortRouting: z.record(z.string(), z.string()).optional(),
		effortBudgets: z.record(z.string(), z.number()).optional(),
		suppressWhenOff: z.boolean().optional(),
		requiresEffort: z.boolean().optional(),
	})
	.loose();

const modelCostSchema = z
	.object({
		input: z.number().optional(),
		output: z.number().optional(),
		cacheRead: z.number().optional(),
		cacheWrite: z.number().optional(),
	})
	.loose();

const modelPatchSchema = z
	.object({
		name: z.string().optional(),
		api: z.string().optional(),
		baseUrl: z.string().optional(),
		reasoning: z.boolean().optional(),
		input: z.array(z.enum(["text", "image"])).optional(),
		supportsTools: z.boolean().optional(),
		cost: modelCostSchema.optional(),
		premiumMultiplier: z.number().optional(),
		contextWindow: z.number().nullable().optional(),
		maxTokens: z.number().nullable().optional(),
		omitMaxOutputTokens: z.boolean().optional(),
		headers: z.record(z.string(), z.string()).optional(),
		compat: z.record(z.string(), z.unknown()).optional(),
		contextPromotionTarget: z.string().optional(),
		thinking: thinkingConfigSchema.optional(),
	})
	.loose();

export const sanitizedModelDefinitionSchema = modelPatchSchema
	.extend({
		id: z.string().min(1),
	})
	.loose();

export const sanitizedModelOverrideSchema = modelPatchSchema.loose();

export const sanitizedProviderConfigSchema = z
	.object({
		baseUrl: z.string().optional(),
		api: z.string().optional(),
		headers: z.record(z.string(), z.string()).optional(),
		authHeader: z.literal(false).optional(),
		auth: z.enum(["apiKey", "none", "oauth"]).optional(),
		discovery: z
			.object({
				type: z.string(),
			})
			.loose()
			.optional(),
		models: z.array(sanitizedModelDefinitionSchema).optional(),
		modelOverrides: z.record(z.string(), sanitizedModelOverrideSchema).optional(),
		disableStrictTools: z.boolean().optional(),
		compat: z.record(z.string(), z.unknown()).optional(),
	})
	.loose()
	.refine(value => !("apiKey" in value), { message: "catalog provider config must not include apiKey" })
	.refine(value => !("transport" in value), { message: "catalog provider config must not include transport" });

export const modelsConfigResponseSchema = z
	.object({
		generatedAt: z.number(),
		schemaVersion: z.literal(1),
		providers: z.record(z.string(), sanitizedProviderConfigSchema),
		equivalence: z
			.object({
				overrides: z.record(z.string(), z.string()).optional(),
				exclude: z.array(z.string()).optional(),
			})
			.loose()
			.optional(),
	})
	.loose();

// ─── Refresh ───────────────────────────────────────────────────────────────

export const credentialRefreshResponseSchema = type({
	"+": "reject",
	entry: credentialSnapshotEntrySchema,
});

// ─── Disable ───────────────────────────────────────────────────────────────

export const credentialDisableRequestSchema = type({
	"+": "reject",
	"cause?": "string",
});

export const credentialDisableResponseSchema = type({
	"+": "reject",
	ok: "boolean",
});

// ─── Upload ────────────────────────────────────────────────────────────────

export const credentialUploadRequestSchema = type({
	"+": "reject",
	provider: type("string").atLeastLength(1),
	credential: writableAuthCredentialSchema,
});

export const credentialUploadResponseSchema = type({
	"+": "reject",
	entries: credentialSnapshotEntrySchema.array(),
});
