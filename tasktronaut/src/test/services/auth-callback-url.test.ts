import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import sinon from "sinon"
import { AuthHandler } from "../../hosts/external/AuthHandler"

describe("Auth Callback URL", () => {
	describe("AuthHandler.getCallbackUrl (standalone/CLI)", () => {
		let authHandler: AuthHandler
		let createServerStub: sinon.SinonStub

		beforeEach(() => {
			authHandler = AuthHandler.getInstance()
			authHandler.setEnabled(true)
			createServerStub = sinon.stub(authHandler as unknown as { createServer: () => Promise<void> }, "createServer").callsFake(
				async () => {
					;(authHandler as any).port = 48801
					;(authHandler as any).server = { close: () => undefined }
				},
			)
		})

		afterEach(() => {
			createServerStub.restore()
			authHandler?.stop()
			;(AuthHandler as any).instance = null
		})

		it("should include the path in the callback URL", async () => {
			const url = await authHandler.getCallbackUrl("/auth")
			url.should.equal("http://127.0.0.1:48801/auth")
		})

		it("should include complex paths in the callback URL", async () => {
			const url = await authHandler.getCallbackUrl("/mcp-auth/callback/abc123")
			url.should.equal("http://127.0.0.1:48801/mcp-auth/callback/abc123")
		})

		it("should work with empty path for backwards compatibility", async () => {
			const url = await authHandler.getCallbackUrl()
			url.should.equal("http://127.0.0.1:48801")
		})
	})

	describe("callback URL encoding", () => {
		it("should preserve callback_url with query params when URL-encoded via searchParams", () => {
			const webCallback = "https://codespace-abc.github.dev/callback?tkn=secret123&extra=val"

			const authUrl = new URL("https://openrouter.ai/auth")
			authUrl.searchParams.set("callback_url", webCallback)

			const parsed = new URL(authUrl.toString())
			parsed.searchParams.get("callback_url")!.should.equal(webCallback)

			const raw = authUrl.toString()
			raw.should.not.containEql("&extra=")
			raw.should.not.containEql("&tkn=")
			raw.should.containEql(encodeURIComponent("&extra=val"))
		})

		it("should encode vscode:// callback URLs correctly", () => {
			const desktopCallback = "vscode://saoudrizwan.claude-dev/openrouter"

			const authUrl = new URL("https://openrouter.ai/auth")
			authUrl.searchParams.set("callback_url", desktopCallback)

			const parsed = new URL(authUrl.toString())
			parsed.searchParams.get("callback_url")!.should.equal(desktopCallback)
		})
	})
})
