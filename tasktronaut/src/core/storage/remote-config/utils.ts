import { synchronizeRemoteRuleToggles } from "@core/context/instructions/user-instructions/rule-helpers"
import { parseRemoteSkillEntries } from "@core/context/instructions/user-instructions/skills"
import type { RemoteConfig, S3AccessKeySettings } from "@shared/remote-config/schema"
import { ConfiguredAPIKeys, GlobalStateAndSettings, RemoteConfigFields } from "@shared/storage/state-keys"
import { AuthService } from "@/services/auth/AuthService"
import { getDistinctId } from "@/services/logging/distinctId"
import { type McpHub } from "@/services/mcp/McpHub"
import { ApiProvider, SUPPORTED_API_PROVIDER, coerceSupportedApiProvider } from "@/shared/api"
import { Logger } from "@/shared/services/Logger"
import { syncWorker } from "@/shared/services/worker/sync"
import { BlobStoreSettings } from "@/shared/storage"
import { ensureSettingsDirectoryExists } from "../disk"
import { StateManager } from "../StateManager"
import { syncRemoteMcpServersToSettings } from "./syncRemoteMcpServers"

function accessSettingsToBlobStorage(type: BlobStoreSettings["adapterType"], settings: S3AccessKeySettings): BlobStoreSettings {
	return {
		adapterType: type,
		accessKeyId: settings.accessKeyId,
		secretAccessKey: settings.secretAccessKey,
		region: settings.region,
		bucket: settings.bucket,
		endpoint: settings.endpoint,
		accountId: settings.accountId,
		intervalMs: settings.intervalMs,
		maxRetries: settings.maxRetries,
		batchSize: settings.batchSize,
		maxQueueSize: settings.maxQueueSize,
		maxFailedAgeMs: settings.maxFailedAgeMs,
		backfillEnabled: settings.backfillEnabled,
	}
}

/**
 * Transforms RemoteConfig schema to RemoteConfigFields shape
 * @param remoteConfig The remote configuration object
 * @returns Partial<RemoteConfigFields> containing only the fields present in remote config
 */
export function transformRemoteConfigToStateShape(remoteConfig: RemoteConfig): Partial<RemoteConfigFields> {
	const transformed: Partial<RemoteConfigFields> = {}

	// Map top-level settings
	if (remoteConfig.mcpMarketplaceEnabled !== undefined) {
		transformed.mcpMarketplaceEnabled = remoteConfig.mcpMarketplaceEnabled
	}
	if (remoteConfig.allowedMCPServers !== undefined) {
		transformed.allowedMCPServers = remoteConfig.allowedMCPServers
	}
	if (remoteConfig.blockPersonalRemoteMCPServers !== undefined) {
		transformed.blockPersonalRemoteMCPServers = remoteConfig.blockPersonalRemoteMCPServers
	}
	if (remoteConfig.remoteMCPServers !== undefined) {
		transformed.remoteMCPServers = remoteConfig.remoteMCPServers
	}

	// Only the OpenAI-compatible provider is supported as configured product state.
	const providers: ApiProvider[] = []

	// Map OpenAiCompatible provider settings
	const openAiSettings = remoteConfig.providerSettings?.OpenAiCompatible
	if (openAiSettings) {
		transformed.planModeApiProvider = SUPPORTED_API_PROVIDER
		transformed.actModeApiProvider = SUPPORTED_API_PROVIDER
		providers.push(SUPPORTED_API_PROVIDER)

		if (openAiSettings.openAiBaseUrl !== undefined) {
			transformed.openAiBaseUrl = openAiSettings.openAiBaseUrl
		}
		if (openAiSettings.openAiHeaders !== undefined) {
			transformed.openAiHeaders = openAiSettings.openAiHeaders
		}
		if (openAiSettings.azureApiVersion !== undefined) {
			transformed.azureApiVersion = openAiSettings.azureApiVersion
		}
		if (openAiSettings.azureIdentity !== undefined) {
			transformed.azureIdentity = openAiSettings.azureIdentity
		}
	}

	// This line needs to stay here, it is order dependent on the above code checking the configured providers
	if (providers.length > 0) {
		transformed.remoteConfiguredProviders = providers
	}

	// Map global rules, workflows, and skills
	if (remoteConfig.globalRules !== undefined) {
		transformed.remoteGlobalRules = remoteConfig.globalRules
	}
	if (remoteConfig.globalWorkflows !== undefined) {
		transformed.remoteGlobalWorkflows = remoteConfig.globalWorkflows
	}
	if (remoteConfig.globalSkills !== undefined) {
		transformed.remoteGlobalSkills = remoteConfig.globalSkills
	}

	if (remoteConfig.enterpriseTelemetry?.promptUploading) {
		const promptUplaoding = remoteConfig.enterpriseTelemetry.promptUploading
		if (promptUplaoding.type === "s3_access_keys" && promptUplaoding.s3AccessSettings) {
			transformed.blobStoreConfig = accessSettingsToBlobStorage("s3", promptUplaoding.s3AccessSettings)
		} else if (promptUplaoding.type === "r2_access_keys" && promptUplaoding.r2AccessSettings) {
			transformed.blobStoreConfig = accessSettingsToBlobStorage("r2", promptUplaoding.r2AccessSettings)
		} else if (promptUplaoding.type === "azure_access_keys" && promptUplaoding.azureAccessSettings) {
			transformed.blobStoreConfig = accessSettingsToBlobStorage("azure", promptUplaoding.azureAccessSettings)
		}
	}

	return transformed
}
async function applyRemoteSyncQueueConfig(transformed: Partial<RemoteConfigFields>) {
	try {
		const blobStoreConfig = transformed.blobStoreConfig
		if (!blobStoreConfig) {
			return
		}

		syncWorker().init({ ...blobStoreConfig, userDistinctId: getDistinctId() })
	} catch (err) {
		Logger.error("[REMOTE CONFIG DEBUG] Failed to apply remote sync queue config", err)
	}
}

export function clearRemoteConfig() {
	try {
		const stateManager = StateManager.get()

		stateManager.clearRemoteConfig()
		// the remote config cline rules toggle state is stored in global state
		stateManager.setGlobalState("remoteRulesToggles", {})
		stateManager.setGlobalState("remoteWorkflowToggles", {})
		stateManager.setGlobalState("remoteSkillsToggles", {})

		// clear secrets
		stateManager.setSecret("remoteLiteLlmApiKey", undefined)
	} catch (err) {
		Logger.error("[REMOTE CONFIG] Failed to clear remote config", err)
	}
}

/**
 * Applies remote config to the StateManager's remote config cache
 * @param remoteConfig The remote configuration object to apply
 * @param mcpHub McpHub instance to prevent watcher triggers during sync
 */
export async function applyRemoteConfig(
	remoteConfig: RemoteConfig,
	configuredKeys: ConfiguredAPIKeys,
	mcpHub: McpHub,
): Promise<void> {
	const stateManager = StateManager.get()
	// If no remote config provided, clear the cache and relevant state
	if (!remoteConfig) {
		clearRemoteConfig()
		return
	}

	// Save previousRemoteMCPServers before clearing cache, this is needed for next sync to detect removals)
	const previousRemoteMCPServers = stateManager.getRemoteConfigSettings().previousRemoteMCPServers

	// Transform remote config to state shape
	// These are then set to the remote config cache in the StateManager
	// We need to ensure the cache is checked for new fields
	const transformed = transformRemoteConfigToStateShape(remoteConfig)

	// Synchronize toggle state
	const currentRuleToggles = stateManager.getGlobalStateKey("remoteRulesToggles") || {}
	const currentWorkflowToggles = stateManager.getGlobalStateKey("remoteWorkflowToggles") || {}

	const syncedRuleToggles = synchronizeRemoteRuleToggles(remoteConfig.globalRules || [], currentRuleToggles)
	const syncedWorkflowToggles = synchronizeRemoteRuleToggles(remoteConfig.globalWorkflows || [], currentWorkflowToggles)

	// Remote skills use shared validation (entry.name must match frontmatter.name)
	const currentSkillToggles = stateManager.getGlobalStateKey("remoteSkillsToggles") || {}
	const validatedSkillEntries = parseRemoteSkillEntries(remoteConfig.globalSkills || [])
	const syncedSkillToggles = synchronizeRemoteRuleToggles(validatedSkillEntries, currentSkillToggles)

	// Enforce alwaysEnabled: override any stale false toggles for skills the admin has locked on.
	// This ensures the toggle store is the single source of truth — both the UI and handler agree.
	for (const entry of validatedSkillEntries) {
		if (entry.alwaysEnabled && syncedSkillToggles[entry.name] === false) {
			syncedSkillToggles[entry.name] = true
		}
	}

	stateManager.setGlobalState("remoteRulesToggles", syncedRuleToggles)
	stateManager.setGlobalState("remoteWorkflowToggles", syncedWorkflowToggles)
	stateManager.setGlobalState("remoteSkillsToggles", syncedSkillToggles)

	// If the existing configured provider is valid, don't update it
	const apiConfiguration = stateManager.getApiConfiguration()
	if (isProviderValid(apiConfiguration.actModeApiProvider, transformed)) {
		transformed.actModeApiProvider = coerceSupportedApiProvider(apiConfiguration.actModeApiProvider)
	}
	if (isProviderValid(apiConfiguration.planModeApiProvider, transformed)) {
		transformed.planModeApiProvider = coerceSupportedApiProvider(apiConfiguration.planModeApiProvider)
	}

	// Build the full new cache and swap atomically to avoid a window where
	// concurrent readers (e.g., UseSkillToolHandler) see an empty cache.
	const newCache: Partial<RemoteConfigFields> = { ...transformed, configuredApiKeys: configuredKeys }
	if (previousRemoteMCPServers !== undefined) {
		newCache.previousRemoteMCPServers = previousRemoteMCPServers
	}
	stateManager.replaceRemoteConfig(newCache)

	applyRemoteSyncQueueConfig(transformed)

	// Always sync remote MCP servers when remote config is active.
	// The sync function uses the persistent `remoteConfigured` marker in the settings file
	// to identify which servers were added by remote config. This means:
	// - Servers no longer in remoteMCPServers but marked `remoteConfigured: true` get removed
	// - New servers get added with the `remoteConfigured: true` marker
	// - No dependency on in-memory state that would be lost across restarts
	try {
		const serversToSync = remoteConfig.remoteMCPServers ?? []
		const settingsPath = await ensureSettingsDirectoryExists()
		await syncRemoteMcpServersToSettings(serversToSync, settingsPath, mcpHub)
		stateManager.setRemoteConfigField("previousRemoteMCPServers", serversToSync)
	} catch (error) {
		Logger.error("[RemoteConfig] Failed to sync remote MCP servers to settings:", error)
		// Continue with other config application even if MCP sync fails
	}
}

const isProviderValid = (provider?: ApiProvider, remoteConfig?: Partial<RemoteConfigFields>) => {
	const remoteConfiguredProviders =
		remoteConfig?.remoteConfiguredProviders ?? StateManager.get().getRemoteConfigSettings().remoteConfiguredProviders
	if (!remoteConfiguredProviders || !remoteConfiguredProviders.length) {
		return provider === undefined || provider === SUPPORTED_API_PROVIDER
	}

	return provider === SUPPORTED_API_PROVIDER && remoteConfiguredProviders.includes(provider)
}

/**
 * Receives a config and returns the subset of fields that can be overriden in the cache
 */
export function filterAllowedRemoteConfigFields(config: Partial<GlobalStateAndSettings>): Partial<GlobalStateAndSettings> {
	const updatedFields: Partial<GlobalStateAndSettings> = {}

	const actModeApiProvider = config.actModeApiProvider
	if (isProviderValid(actModeApiProvider)) {
		updatedFields.actModeApiProvider = coerceSupportedApiProvider(actModeApiProvider)
	}

	const planModeApiProvider = config.planModeApiProvider
	if (isProviderValid(planModeApiProvider)) {
		updatedFields.planModeApiProvider = coerceSupportedApiProvider(planModeApiProvider)
	}

	return updatedFields
}

const canDisableRemoteConfig = (orgId: string) => {
	// Check if they're an admin/owner
	const authService = AuthService.getInstance()
	const userOrgs = authService.getUserOrganizations()

	if (!userOrgs) {
		return false
	}

	const org = userOrgs.find((org) => org.organizationId === orgId)
	const isAdminOrOwner = org?.roles?.some((role) => role === "admin" || role === "owner")

	return isAdminOrOwner
}

export const isRemoteConfigEnabled = (orgId: string) => {
	const stateManager = StateManager.get()
	const hasOptedOut = stateManager.getGlobalSettingsKey("optOutOfRemoteConfig")

	const isDisabled = hasOptedOut && canDisableRemoteConfig(orgId)

	return !isDisabled
}
