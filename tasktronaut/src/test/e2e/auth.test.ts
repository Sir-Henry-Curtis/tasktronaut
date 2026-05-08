import { expect } from "@playwright/test"
import { e2e } from "./utils/helpers"

// Test for setting up API keys
e2e("Views - can set up API keys and navigate to Settings from Chat", async ({ sidebar }) => {
	// Use the page object to interact with editor outside the sidebar
	// Verify initial state
	await expect(sidebar.getByRole("button", { name: "Login to Cline" })).toBeVisible()
	await expect(sidebar.getByText("Bring my own API key")).toBeVisible()

	// Navigate to API key setup
	await sidebar.getByText("Bring my own API key").click()
	await sidebar.getByRole("button", { name: "Continue" }).click()

	const baseUrlInput = sidebar.getByRole("textbox", { name: "Base URL" })
	await baseUrlInput.fill("https://example.com/v1")
	await expect(baseUrlInput).toHaveValue("https://example.com/v1")

	const apiKeyInput = sidebar.getByRole("textbox", {
		name: "OpenAI Compatible API Key",
	})
	await apiKeyInput.fill("test-api-key")
	await expect(apiKeyInput).toHaveValue("test-api-key")
	await apiKeyInput.click({ delay: 100 })
	await sidebar.getByRole("button", { name: "Continue" }).click()

	await expect(sidebar.getByRole("button", { name: "Login to Cline" })).not.toBeVisible()

	// Verify start up page is no longer visible
	await expect(apiKeyInput).not.toBeVisible()
	await expect(baseUrlInput).not.toBeVisible()

	// Verify you are now in the chat page after setup was completed.
	// cline logo container
	const clineLogo = sidebar.locator(".size-20")
	await expect(clineLogo).toBeVisible()
	const chatInputBox = sidebar.getByTestId("chat-input")
	await expect(chatInputBox).toBeVisible()
})
