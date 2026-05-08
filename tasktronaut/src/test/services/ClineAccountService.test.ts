import * as assert from "assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { ClineAccountService } from "../../services/account/ClineAccountService"
import { Logger } from "../../shared/services/Logger"

describe("ClineAccountService", () => {
	it("returns undefined for remote-config and featurebase lookups in the Tasktronaut fork", async () => {
		const service = new ClineAccountService()

		assert.strictEqual(await service.fetchUserRemoteConfig(), undefined)
		assert.strictEqual(await service.fetchFeaturebaseToken(), undefined)
	})

	it("exposes an empty baseUrl because the hosted account system is disabled", () => {
		const service = new ClineAccountService()
		assert.strictEqual(service.baseUrl, "")
	})

	it("logs no-op messages for account actions that are disabled in this fork", async () => {
		const infoStub = sinon.stub(Logger, "info")
		const service = new ClineAccountService()

		await service.submitLimitIncreaseRequestRPC()
		await service.switchAccount("org-123")

		assert.strictEqual(infoStub.callCount, 2)
		assert.match(String(infoStub.firstCall.args[0]), /account system disabled/i)
		assert.match(String(infoStub.secondCall.args[0]), /account system disabled/i)
	})
})
