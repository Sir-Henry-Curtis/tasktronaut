import * as cheerio from "cheerio"
import TurndownService from "turndown"

export class UrlContentFetcher {
	async launchBrowser(): Promise<void> {
		// Kept as a no-op for compatibility with existing mention parsing flow.
	}

	async closeBrowser(): Promise<void> {
		// Kept as a no-op for compatibility with existing mention parsing flow.
	}

	async urlToMarkdown(url: string): Promise<string> {
		const response = await fetch(url, {
			headers: {
				"user-agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
			},
		})

		if (!response.ok) {
			throw new Error(`Request failed with status ${response.status}`)
		}

		const content = await response.text()

		// use cheerio to parse and clean up the HTML
		const $ = cheerio.load(content)
		$("script, style, nav, footer, header").remove()

		// convert cleaned HTML to markdown
		const turndownService = new TurndownService()
		const markdown = turndownService.turndown($.html())

		return markdown
	}
}
