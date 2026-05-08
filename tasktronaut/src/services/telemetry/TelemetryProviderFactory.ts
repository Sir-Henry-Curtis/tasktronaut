// FORK MOD: All telemetry providers removed for ITAR/EAR compliance.
// This factory always returns a no-op provider. No data leaves the approved boundary.
// PostHog and OpenTelemetry providers have been deleted.

import { Logger } from "@/shared/services/Logger"
import type { ITelemetryProvider, TelemetryProperties, TelemetrySettings } from "./providers/ITelemetryProvider"

export type TelemetryProviderType = "no-op"
export type TelemetryProviderConfig = { type: "no-op" }

export class TelemetryProviderFactory {
	public static async createProviders(): Promise<ITelemetryProvider[]> {
		Logger.info("TelemetryProviderFactory: ITAR/EAR fork — returning no-op provider only")
		return [new NoOpTelemetryProvider()]
	}

	public static getDefaultConfigs(): TelemetryProviderConfig[] {
		return [{ type: "no-op" }]
	}
}

export class NoOpTelemetryProvider implements ITelemetryProvider {
	readonly name = "NoOpTelemetryProvider"

	log(_event: string, _properties?: TelemetryProperties): void {}
	logRequired(_event: string, _properties?: TelemetryProperties): void {}
	identifyUser(_userInfo: any, _properties?: TelemetryProperties): void {}
	isEnabled(): boolean {
		return false
	}
	getSettings(): TelemetrySettings {
		return { hostEnabled: false, level: "off" }
	}
	recordCounter(
		_name: string,
		_value: number,
		_attributes?: TelemetryProperties,
		_description?: string,
		_required = false,
	): void {}
	recordHistogram(
		_name: string,
		_value: number,
		_attributes?: TelemetryProperties,
		_description?: string,
		_required = false,
	): void {}
	recordGauge(
		_name: string,
		_value: number | null,
		_attributes?: TelemetryProperties,
		_description?: string,
		_required = false,
	): void {}
	async forceFlush(): Promise<void> {}
	async dispose(): Promise<void> {}
}
