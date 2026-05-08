import fs from "node:fs"
import path from "node:path"

const extractedVsixDir = process.argv[2]

if (!extractedVsixDir) {
	console.error("Usage: node scripts/inline-vsix-readme-images.mjs <extracted-vsix-dir>")
	process.exit(1)
}

const extensionDir = path.join(extractedVsixDir, "extension")
const readmePath = path.join(extensionDir, "readme.md")

if (!fs.existsSync(readmePath)) {
	console.error(`README not found at ${readmePath}`)
	process.exit(1)
}

const toDataUri = (imagePath) => {
	const extension = path.extname(imagePath).toLowerCase()
	const mimeType =
		extension === ".png"
			? "image/png"
			: extension === ".jpg" || extension === ".jpeg"
				? "image/jpeg"
				: extension === ".gif"
					? "image/gif"
					: extension === ".svg"
						? "image/svg+xml"
						: null

	if (!mimeType) {
		throw new Error(`Unsupported image type for README inlining: ${imagePath}`)
	}

	const fileBuffer = fs.readFileSync(imagePath)
	return `data:${mimeType};base64,${fileBuffer.toString("base64")}`
}

let readme = fs.readFileSync(readmePath, "utf8")

readme = readme.replace(/!\[([^\]]*)\]\((\.\/assets\/branding\/[^)]+)\)/g, (_match, altText, relativePath) => {
	const imagePath = path.join(extensionDir, relativePath)
	const width = altText.toLowerCase().includes("wordmark") ? ' width="720"' : ""
	return `<img src="${toDataUri(imagePath)}" alt="${altText}"${width} />`
})

readme = readme.replace(
	/<img\s+([^>]*?)src="(\.\/assets\/branding\/[^"]+)"([^>]*?)>/g,
	(_match, beforeSrc, relativePath, afterSrc) => {
		const imagePath = path.join(extensionDir, relativePath)
		return `<img ${beforeSrc}src="${toDataUri(imagePath)}"${afterSrc}>`
	},
)

fs.writeFileSync(readmePath, readme)
console.log(`Inlined README images in ${readmePath}`)
