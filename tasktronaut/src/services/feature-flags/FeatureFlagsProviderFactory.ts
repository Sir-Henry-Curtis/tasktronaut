// FORK MOD: Remote feature flags (PostHog) disabled for ITAR/EAR compliance.
// All feature flags use static defaults defined in shared/services/feature-flags/feature-flags.ts.
// No external network calls are made.

import { Logger } from "@/shared/services/Logger"
import type { FeatureFlagsAndPayloads, IFeatureFlagsProvider } from "./providers/IFeatureFlagsProvider"

export type FeatureFlagsProviderType = "no-op"
export interface FeatureFlagsProviderConfig {
	type: FeatureFlagsProviderType
}

export class FeatureFlagsProviderFactory {
	public static createProvider(_config: FeatureFlagsProviderConfig): IFeatureFlagsProvider {
		return new NoOpFeatureFlagsProvider()
	}

	public static getDefaultConfig(): FeatureFlagsProviderConfig {
		return { type: "no-op" }
	}
}

class NoOpFeatureFlagsProvider implements IFeatureFlagsProvider {
	async getAllFlagsAndPayloads(_: { flagKeys?: string[] }): Promise<FeatureFlagsAndPayloads | undefined> {
		return {}
	}

	public isEnabled(): boolean {
		return true
	}

	public getSettings() {
		return { enabled: true, timeout: 1000 }
	}

	public async dispose(): Promise<void> {
		Logger.info("[NoOpFeatureFlagsProvider] Disposing")
	}
}
