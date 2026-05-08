import * as diskStorage from "@core/storage/disk"
import * as remoteConfigFetch from "@core/storage/remote-config/fetch"
import * as remoteConfigUtils from "@core/storage/remote-config/utils"
import * as assert from "assert"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { ClineAccountService } from "@/services/account/ClineAccountService"
import { AuthService } from "@/services/auth/AuthService"

describe("fetchRemoteConfig", () => {
	let sandbox: sinon.SinonSandbox
	let accountService: ClineAccountService

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		sandbox.stub(AuthService, "getInstance").returns({} as AuthService)
		accountService = new ClineAccountService()
		sandbox.stub(ClineAccountService, "getInstance").returns(accountService)
		sandbox.stub(accountService, "fetchUserRemoteConfig")
		sandbox.stub(remoteConfigUtils, "applyRemoteConfig").resolves()
		sandbox.stub(remoteConfigUtils, "clearRemoteConfig")
		sandbox.stub(diskStorage, "writeRemoteConfigToCache").resolves()
		sandbox.stub(diskStorage, "readRemoteConfigFromCache").resolves({ version: "v1" })
		sandbox.stub(diskStorage, "deleteRemoteConfigFromCache").resolves()
	})

	afterEach(() => {
		sandbox.restore()
	})

	it("is a no-op in the Tasktronaut fork", async () => {
		const controller = {
			accountService: { switchAccount: sandbox.stub().resolves() },
			stateManager: { setSecret: sandbox.stub() },
			mcpHub: {},
			postStateToWebview: sandbox.stub(),
		}

		const result = await remoteConfigFetch.fetchRemoteConfig(controller as any)

		assert.strictEqual(result, undefined)
		assert.strictEqual(controller.accountService.switchAccount.callCount, 0)
		assert.strictEqual(controller.postStateToWebview.callCount, 0)
		assert.strictEqual((remoteConfigUtils.applyRemoteConfig as sinon.SinonStub).callCount, 0)
		assert.strictEqual((remoteConfigUtils.clearRemoteConfig as sinon.SinonStub).callCount, 0)
		assert.strictEqual((diskStorage.writeRemoteConfigToCache as sinon.SinonStub).callCount, 0)
		assert.strictEqual((diskStorage.readRemoteConfigFromCache as sinon.SinonStub).callCount, 0)
	})

	it("does not consult remote discovery services", async () => {
		const controller = {
			accountService: { switchAccount: sandbox.stub().resolves() },
			stateManager: { setSecret: sandbox.stub() },
			mcpHub: {},
			postStateToWebview: sandbox.stub(),
		}

		await remoteConfigFetch.fetchRemoteConfig(controller as any)

		assert.strictEqual((accountService.fetchUserRemoteConfig as sinon.SinonStub).callCount, 0)
	})
})
