import axios from "axios"
import { type JwtPayload } from "jwt-decode"
import { ClineEnv, EnvironmentConfig } from "@/config"
import { Controller } from "@/core/controller"
import { HostProvider } from "@/hosts/host-provider"
import { buildBasicClineHeaders } from "@/services/EnvUtils"
import { AuthInvalidTokenError, AuthNetworkError } from "@/services/error/ClineError"
import { telemetryService } from "@/services/telemetry"
import { CLINE_API_ENDPOINT } from "@/shared/cline/api"
import { fetch, getAxiosSettings } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { type ClineAccountUserInfo, type ClineAuthInfo } from "../AuthService"
import { parseJwtPayload } from "../oca/utils/utils"

interface ClineAuthApiUser {
	subject: string | null
	email: string
	name: string
	clineUserId: string | null
	accounts: string[] | null
}

// Unified API response data shape for token exchange/refresh
interface ClineAuthResponseData {
	/**
	 * Auth token to be used for authenticated requests
	 */
	accessToken: string
	/**
	 * Refresh token to be used for refreshing the access token
	 */
	refreshToken?: string
	/**
	 * Token type
	 * E.g. "Bearer"
	 */
	tokenType: string
	/**
	 * Access token expiration time in ISO 8601 format
	 * E.g. "2025-09-17T04:32:24.842636548Z"
	 */
	expiresAt: string
	/**
	 * User information associated with the token
	 */
	userInfo: ClineAuthApiUser
}

type TokenData = JwtPayload & {
	sid?: string
	external_id?: string
}

export interface ClineAuthApiTokenExchangeResponse {
	success: boolean
	data: ClineAuthResponseData
}

export interface ClineAuthApiTokenRefreshResponse {
	success: boolean
	data: ClineAuthResponseData
}

export class ClineAuthProvider {
	readonly name = "cline"
	private refreshRetryCount = 0
	private lastRefreshAttempt = 0
	private readonly MAX_REFRESH_RETRIES = 3
	private readonly RETRY_DELAY_MS = 30000 // 30 seconds

	get config(): EnvironmentConfig {
		return ClineEnv.config()
	}

	/**
	 * Checks if the access token needs to be refreshed (expired or about to expire).
	 * Since the new flow doesn't support refresh tokens, this will return true if token is expired.
	 * @param _refreshToken - The existing refresh token to check.
	 * @returns {Promise<boolean>} True if the token is expired or about to expire.
	 */
	async shouldRefreshIdToken(_refreshToken: string, expiresAt?: number): Promise<boolean> {
		try {
			// expiresAt is in seconds
			const expirationTime = expiresAt || 0
			const currentTime = Date.now() / 1000
			const next5Min = currentTime + 5 * 60

			// Check if token is expired or will expire in the next 5 minutes
			return expirationTime < next5Min // Access token is expired or about to expire
		} catch (error) {
			Logger.error("Error checking token expiration:", error)
			return true // If we can't decode the token, assume it needs refresh
		}
	}

	/**
	 * Returns the time in seconds until token expiry
	 */
	timeUntilExpiry(jwt: string): number {
		const data = this.extractTokenData(jwt)
		if (!data.exp) {
			return 0
		}

		const currentTime = Date.now() / 1000
		const expirationTime = data.exp

		return expirationTime - currentTime
	}

	private clearSession(controller: Controller, reason: string, storedAuthData?: ClineAuthInfo) {
		Logger.error(reason)

		const startedAt = storedAuthData?.startedAt
		const timeSinceStarted = Date.now() - (startedAt || 0)

		const tokenData = this.extractTokenData(storedAuthData?.idToken)
		telemetryService.capture({
			event: "extension_logging_user_out",
			properties: {
				reason,
				time_since_started: timeSinceStarted,
				session_id: tokenData.sid,
				user_id: tokenData.external_id,
			},
		})

		controller.stateManager.setSecret("cline:clineAccountId", undefined)
		this.refreshRetryCount = 0
		this.lastRefreshAttempt = 0
		return null
	}

	private logFailedRefreshAttempt(response: Response, storedAuthData?: ClineAuthInfo) {
		const startedAt = storedAuthData?.startedAt
		const timeSinceStarted = Date.now() - (startedAt || 0)

		const tokenData = this.extractTokenData(storedAuthData?.idToken)
		telemetryService.capture({
			event: "extension_refresh_attempt_failed",
			properties: {
				status_code: response.status,
				request_id: response.headers.get("x-request-id"),
				session_id: tokenData.sid,
				user_id: tokenData.external_id,
				time_since_started: timeSinceStarted,
			},
		})
	}

	private extractTokenData(token: string | undefined): Partial<TokenData> {
		if (!token) {
			return {}
		}

		return parseJwtPayload<TokenData>(token) || {}
	}

	/**
	 * Retrieves Cline auth info using the stored access token.
	 * @param controller - The controller instance to access stored secrets.
	 * @returns {Promise<ClineAuthInfo | null>} A promise that resolves with the auth info or null.
	 */
	async retrieveClineAuthInfo(_controller: Controller): Promise<ClineAuthInfo | null> {
		// FORK MOD: ITAR/network-isolated build — Cline account auth (api.cline.bot) disabled.
		return null
	}

	/**
	 * Refreshes an access token using a refresh token.
	 * @param refreshToken - The refresh token.
	 * @returns {Promise<ClineAuthInfo>} The new access token and user info.
	 */
	async refreshToken(refreshToken: string, storedData: ClineAuthInfo): Promise<ClineAuthInfo> {
		try {
			const endpoint = new URL(CLINE_API_ENDPOINT.REFRESH_TOKEN, this.config.apiBaseUrl)
			const response = await fetch(endpoint.toString(), {
				method: "POST",
				headers: await this.headers(),
				body: JSON.stringify({
					refreshToken: storedData.refreshToken,
					grantType: "refresh_token",
				}),
			})

			if (!response.ok) {
				this.logFailedRefreshAttempt(response, storedData)

				// 400/401 = Invalid/expired token (permanent failure)
				if (response.status === 400 || response.status === 401) {
					const errorData = await response.json().catch(() => ({}))
					const errorMessage = errorData?.error || "Invalid or expired token"
					throw new AuthInvalidTokenError(errorMessage)
				}
				// 5xx, 429, network errors = transient failures
				const errorData = await response.json().catch(() => ({}))
				throw new AuthNetworkError(`status: ${response.status}`, errorData)
			}

			const data: ClineAuthApiTokenExchangeResponse = await response.json()

			if (!data.success || !data.data.refreshToken || !data.data.accessToken) {
				throw new Error("Failed to exchange authorization code for access token")
			}

			const userInfo = await this.fetchRemoteUserInfo(data.data)

			return {
				idToken: data.data.accessToken,
				// data.data.expiresAt example: "2025-09-17T03:43:57Z"; store in seconds
				expiresAt: new Date(data.data.expiresAt).getTime() / 1000,
				refreshToken: data.data.refreshToken || refreshToken,
				userInfo,
				provider: this.name,
				startedAt: storedData.startedAt || Date.now(),
			}
		} catch (error: any) {
			// Network errors (ECONNREFUSED, timeout, etc)
			if (error.name === "TypeError" || error.code === "ECONNREFUSED" || error.code === "ETIMEDOUT") {
				throw new AuthNetworkError("Network error during token refresh", error)
			}
			throw error
		}
	}

	async getAuthRequest(_callbackUrl: string): Promise<string> {
		// FORK MOD: ITAR/network-isolated build — Cline account sign-in disabled.
		throw new Error("Cline account sign-in is disabled in this build.")
	}

	async signIn(controller: Controller, authorizationCode: string, provider: string): Promise<ClineAuthInfo | null> {
		try {
			// Get the callback URL that was used during the initial auth request
			const callbackUrl = await HostProvider.get().getCallbackUrl("/auth")

			// Exchange the authorization code for tokens
			const tokenUrl = new URL(CLINE_API_ENDPOINT.TOKEN_EXCHANGE, this.config.apiBaseUrl)

			const response = await fetch(tokenUrl.toString(), {
				method: "POST",
				headers: await this.headers(),
				body: JSON.stringify({
					grant_type: "authorization_code",
					code: authorizationCode,
					client_type: "extension",
					redirect_uri: callbackUrl,
					provider: provider,
				}),
			})

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}))
				throw new Error(errorData.error_description || "Failed to exchange authorization code for tokens")
			}

			const responseJSON = await response.json()
			const responseType: ClineAuthApiTokenExchangeResponse = responseJSON
			const tokenData = responseType.data

			if (!tokenData.accessToken || !tokenData.refreshToken || !tokenData.userInfo) {
				throw new Error("Invalid token response from server")
			}

			const userInfo = await this.fetchRemoteUserInfo(tokenData)

			// Store the tokens and user info
			const clineAuthInfo = {
				idToken: tokenData.accessToken,
				refreshToken: tokenData.refreshToken,
				userInfo,
				expiresAt: new Date(tokenData.expiresAt).getTime() / 1000, // "2025-09-17T04:32:24.842636548Z"
				provider: this.name,
				startedAt: Date.now(),
			}

			controller.stateManager.setSecret("cline:clineAccountId", JSON.stringify(clineAuthInfo))

			return clineAuthInfo
		} catch (error) {
			Logger.error("Error handling auth callback:", error)
			throw error
		}
	}

	private async fetchRemoteUserInfo(tokenData: ClineAuthApiTokenExchangeResponse["data"]): Promise<ClineAccountUserInfo> {
		try {
			const userResponse = await axios.get(`${ClineEnv.config().apiBaseUrl}/api/v1/users/me`, {
				headers: {
					Authorization: `Bearer workos:${tokenData.accessToken}`,
					...(await this.headers()),
				},
				...getAxiosSettings(),
			})

			return userResponse.data.data
		} catch (error) {
			Logger.error("Error fetching user info:", error)

			// If fetching user info fail for whatever reason, fallback to the token data and refetch on token expiry (10 minutes)
			return {
				id: tokenData.userInfo.clineUserId || "",
				email: tokenData.userInfo.email || "",
				displayName: tokenData.userInfo.name || "",
				createdAt: new Date().toISOString(),
				organizations: [],
			}
		}
	}

	private async headers() {
		return {
			Accept: "application/json",
			"Content-Type": "application/json",
			...(await buildBasicClineHeaders()),
		}
	}
}
