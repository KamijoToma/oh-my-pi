import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginLongcat = createApiKeyLogin({
	providerLabel: "LongCat",
	authUrl: "https://longcat.chat/platform",
	instructions: "Copy your API key from the LongCat platform dashboard",
	promptMessage: "Paste your LongCat API key",
	placeholder: "lc-...",
	validation: {
		kind: "models-endpoint",
		provider: "LongCat",
		modelsUrl: "https://api.longcat.chat/openai/v1/models",
	},
});

export const longcatProvider = {
	id: "longcat",
	name: "LongCat",
	login: loginLongcat,
} as const satisfies ProviderDefinition;
