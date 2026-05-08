// FORK MOD: Cline account service stubbed for ITAR/EAR compliance.
// All methods return undefined/empty — no calls to api.cline.bot.

import type {
	BalanceResponse,
	FeaturebaseTokenResponse,
	OrganizationBalanceResponse,
	OrganizationUsageTransaction,
	PaymentTransaction,
	UsageTransaction,
	UserRemoteConfigDiscoveryResponse,
	UserResponse,
} from "@shared/ClineAccount"
import { Logger } from "@/shared/services/Logger"

export class ClineAccountService {
	private static instance: ClineAccountService

	public static getInstance(): ClineAccountService {
		if (!ClineAccountService.instance) {
			ClineAccountService.instance = new ClineAccountService()
		}
		return ClineAccountService.instance
	}

	get baseUrl(): string {
		return ""
	}

	async fetchBalanceRPC(): Promise<BalanceResponse | undefined> {
		return undefined
	}

	async fetchUsageTransactionsRPC(): Promise<UsageTransaction[] | undefined> {
		return undefined
	}

	async fetchPaymentTransactionsRPC(): Promise<PaymentTransaction[] | undefined> {
		return undefined
	}

	async fetchMe(): Promise<UserResponse | undefined> {
		return undefined
	}

	async fetchFeaturebaseToken(): Promise<FeaturebaseTokenResponse | undefined> {
		return undefined
	}

	async fetchUserOrganizationsRPC(): Promise<UserResponse["organizations"] | undefined> {
		return undefined
	}

	async fetchOrganizationCreditsRPC(_organizationId: string): Promise<OrganizationBalanceResponse | undefined> {
		return undefined
	}

	async fetchOrganizationUsageTransactionsRPC(_organizationId: string): Promise<OrganizationUsageTransaction[] | undefined> {
		return undefined
	}

	async fetchUserRemoteConfig(): Promise<UserRemoteConfigDiscoveryResponse | undefined> {
		return undefined
	}

	async submitLimitIncreaseRequestRPC(): Promise<void> {
		Logger.info("[ClineAccountService] FORK: account system disabled, submitLimitIncreaseRequestRPC is a no-op")
	}

	async switchAccount(_organizationId?: string): Promise<void> {
		Logger.info("[ClineAccountService] FORK: account system disabled, switchAccount is a no-op")
	}
}
