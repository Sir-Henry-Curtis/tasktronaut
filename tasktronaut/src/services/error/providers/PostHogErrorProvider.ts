// FORK MOD: PostHog removed for ITAR/EAR compliance. This is a no-op stub.
import { Logger } from "@/shared/services/Logger"
import { ClineError } from "../ClineError"
import type { ErrorSettings, IErrorProvider } from "./IErrorProvider"

export class PostHogErrorProvider implements IErrorProvider {
	async captureException(error: Error | ClineError, _properties?: Record<string, unknown>): Promise<void> {
		Logger.error("[PostHogErrorProvider stub] captureException", error.message || String(error))
	}
	logException(error: Error | ClineError, _properties?: Record<string, unknown>): void {
		Logger.error("[PostHogErrorProvider stub]", error.message || String(error))
	}
	logMessage(message: string, _level?: string, _properties?: Record<string, unknown>): void {
		Logger.log("[PostHogErrorProvider stub]", message)
	}
	isEnabled(): boolean {
		return false
	}
	getSettings(): ErrorSettings {
		return { enabled: false, hostEnabled: false, level: "off" }
	}
	async dispose(): Promise<void> {}
}
