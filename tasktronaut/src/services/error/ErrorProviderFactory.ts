// FORK MOD: PostHog removed for ITAR/EAR compliance. Factory always returns no-op.
import { Logger } from "@/shared/services/Logger"
import { ClineError } from "./ClineError"
import { IErrorProvider } from "./providers/IErrorProvider"

export type ErrorProviderType = "no-op"

export interface ErrorProviderConfig {
	type: ErrorProviderType
}

export class ErrorProviderFactory {
	public static async createProvider(_config: ErrorProviderConfig): Promise<IErrorProvider> {
		return new NoOpErrorProvider()
	}

	public static getDefaultConfig(): ErrorProviderConfig {
		return { type: "no-op" }
	}
}

class NoOpErrorProvider implements IErrorProvider {
	async captureException(error: Error | ClineError, properties?: Record<string, unknown>): Promise<void> {
		Logger.error("[NoOpErrorProvider] captureException called", { error: error.message || String(error), properties })
	}

	public logException(error: Error | ClineError, _properties?: Record<string, unknown>): void {
		Logger.error("[NoOpErrorProvider]", error.message || String(error))
	}

	public logMessage(
		message: string,
		level?: "error" | "warning" | "log" | "debug" | "info",
		properties?: Record<string, unknown>,
	): void {
		Logger.log("[NoOpErrorProvider]", { message, level, properties })
	}

	public isEnabled(): boolean {
		return true
	}

	public getSettings() {
		return {
			enabled: true,
			hostEnabled: true,
			level: "all" as const,
		}
	}

	public async dispose(): Promise<void> {
		Logger.info("[NoOpErrorProvider] Disposing")
	}
}
