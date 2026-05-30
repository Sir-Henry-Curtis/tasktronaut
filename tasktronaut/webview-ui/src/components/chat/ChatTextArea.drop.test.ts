import { describe, expect, it } from "vitest"
import { isSupportedDroppedAttachment } from "./ChatTextArea"

const makeFile = (name: string, type = "text/plain") => new File(["content"], name, { type })

describe("ChatTextArea dropped file attachments", () => {
	it("accepts the same non-image document types as the attachment picker", () => {
		for (const name of [
			"notes.md",
			"debug.log",
			"data.json",
			"report.pdf",
			"brief.docx",
			"notebook.ipynb",
			"sheet.xlsx",
			"table.csv",
			"payload.xml",
		]) {
			expect(isSupportedDroppedAttachment(makeFile(name))).toBe(true)
		}
	})

	it("rejects unknown dropped file types", () => {
		expect(isSupportedDroppedAttachment(makeFile("archive.zip", "application/zip"))).toBe(false)
		expect(isSupportedDroppedAttachment(makeFile("binary.bin", "application/octet-stream"))).toBe(false)
	})
})
