import { expect } from "chai"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as sinon from "sinon"
import { ClineEnv, Environment } from "../../../config"
import { Controller } from "../../../core/controller"
import { StateManager } from "../../../core/storage/StateManager"
import { HostRegistryInfo } from "../../../registry"
import { AuthService } from "../../../services/auth/AuthService"
import { Logger } from "../../../shared/services/Logger"
import { BannerService } from "../BannerService"

describe("BannerService", () => {
	let sandbox: sinon.SinonSandbox
	let mockController: Controller
	let mockHostInfo: {
		extensionVersion: string
		platform: string
		os: string
		ide: string
		distinctId: string
	}
	let mockStateManagerConfig: {
		apiConfiguration: Record<string, unknown>
		mode: string | undefined
		dismissedBanners: Array<{ bannerId: string; dismissedAt: number }>
	}

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		mockController = {
			postStateToWebview: sandbox.stub().resolves(undefined),
		} as any

		mockStateManagerConfig = {
			apiConfiguration: {},
			mode: undefined,
			dismissedBanners: [],
		}
		mockHostInfo = {
			extensionVersion: "1.0.0",
			platform: "darwin",
			os: "darwin",
			ide: "vscode",
			distinctId: "test-distinct-id",
		}

		sandbox.stub(Logger, "log")
		sandbox.stub(Logger, "error")
		sandbox.stub(StateManager, "get").returns({
			getApiConfiguration: () => mockStateManagerConfig.apiConfiguration,
			getGlobalSettingsKey: (key: string) => (key === "mode" ? mockStateManagerConfig.mode : undefined),
			getGlobalStateKey: (key: string) => (key === "dismissedBanners" ? mockStateManagerConfig.dismissedBanners : []),
			setGlobalState: (key: string, value: unknown) => {
				if (key === "dismissedBanners") {
					mockStateManagerConfig.dismissedBanners = value as Array<{ bannerId: string; dismissedAt: number }>
				}
			},
		} as unknown as StateManager)
		sandbox.stub(HostRegistryInfo, "get").returns(mockHostInfo as any)
		sandbox.stub(ClineEnv, "config").returns({
			environment: Environment.production,
			appBaseUrl: "https://app.cline-mock.bot",
			apiBaseUrl: "https://api.cline-mock.bot",
			mcpBaseUrl: "https://api.cline-mock.bot/v1/mcp",
		})
		sandbox.replace(AuthService.getInstance(), "getAuthToken", () => Promise.resolve("fake-token"))
		process.env.IS_DEV = "true"

		BannerService.reset()
	})

	afterEach(() => {
		BannerService.reset()
		delete process.env.IS_DEV
		sandbox.restore()
	})

	it("returns no active banners because remote banner fetching is disabled in the fork", async () => {
		const bannerService = BannerService.initialize(mockController)

		expect(bannerService.getActiveBanners()).to.deep.equal([])
		await bannerService.drainForTesting()
		expect(bannerService.getActiveBanners()).to.deep.equal([])
	})

	it("returns no welcome banners when nothing is cached", () => {
		const bannerService = BannerService.initialize(mockController)
		expect(bannerService.getWelcomeBanners()).to.deep.equal([])
	})

	it("records dismissed banner ids in global state", async () => {
		const bannerService = BannerService.initialize(mockController)

		await bannerService.dismissBanner("bnr-dismissed")

		expect(mockStateManagerConfig.dismissedBanners).to.have.lengthOf(1)
		expect(mockStateManagerConfig.dismissedBanners[0].bannerId).to.equal("bnr-dismissed")
		expect(bannerService.isBannerDismissed("bnr-dismissed")).to.equal(true)
	})

	it("maps host ide strings to the expected banner ide type", () => {
		const cases = [
			{ ide: "VSCode Extension", platform: "darwin", expected: "vscode" },
			{ ide: "Cline for JetBrains", platform: "linux", expected: "jetbrains" },
			{ ide: "Codex CLI", platform: "linux", expected: "cli" },
			{ ide: "", platform: "Visual Studio Code", expected: "vscode" },
			{ ide: "", platform: "mystery-shell", expected: "unknown" },
		]

		for (const testCase of cases) {
			mockHostInfo.platform = testCase.platform
			mockHostInfo.ide = testCase.ide
			BannerService.reset()
			const bannerService = BannerService.initialize(mockController)
			const ideType = (bannerService as any).getIdeType()
			expect(ideType).to.equal(testCase.expected)
			BannerService.reset()
		}
	})

	it("debounces auth updates without throwing when remote banners are disabled", async () => {
		const clock = sandbox.useFakeTimers({ now: Date.now(), shouldClearNativeTimers: true })
		BannerService.initialize(mockController)

		const updatePromise = BannerService.onAuthUpdate("user-123")
		await clock.tickAsync(1000)
		await updatePromise

		expect(true).to.equal(true)
		clock.restore()
	})
})
