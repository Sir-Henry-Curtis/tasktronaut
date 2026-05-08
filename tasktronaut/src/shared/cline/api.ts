// FORK MOD: Approved government API endpoint configuration.
// These values are injected at build time from environment variables.
// Set APPROVED_API_KEY at runtime from the government-issued key — never hardcode it.
export const APPROVED_PROVIDER = process.env.APPROVED_API_PROVIDER ?? "bedrock"
export const APPROVED_BASE_URL = process.env.APPROVED_API_BASE_URL ?? ""
export const APPROVED_MODEL_ID = process.env.APPROVED_MODEL_ID ?? ""

enum CLINE_API_AUTH_ENDPOINTS {
	AUTH = "/api/v1/auth/authorize",
	REFRESH_TOKEN = "/api/v1/auth/refresh",
}

enum CLINE_API_ENDPOINT_V1 {
	TOKEN_EXCHANGE = "/api/v1/auth/token",
	USER_INFO = "/api/v1/users/me",
	FEATUREBASE_TOKEN = "/api/v1/users/me/featurebase-token",
	ACTIVE_ACCOUNT = "/api/v1/users/active-account",
	USER_REMOTE_CONFIG = "/api/v1/users/me/remote-config",
	REMOTE_CONFIG = "/api/v1/organizations/{id}/remote-config",
	API_KEYS = "/api/v1/organizations/{id}/api-keys",
}

export const CLINE_API_ENDPOINT = {
	...CLINE_API_AUTH_ENDPOINTS,
	...CLINE_API_ENDPOINT_V1,
}
