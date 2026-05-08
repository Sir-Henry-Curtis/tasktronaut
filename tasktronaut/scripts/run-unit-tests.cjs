#!/usr/bin/env node

const { spawnSync } = require("node:child_process")
const path = require("node:path")

const mochaBin = require.resolve("mocha/bin/mocha.js")
const userArgs = process.argv.slice(2)
const optionsWithValue = new Set([
	"--async-only",
	"--bail",
	"--check-leaks",
	"--color",
	"--config",
	"--delay",
	"--diff",
	"--exit",
	"--extension",
	"--fgrep",
	"--file",
	"--forbid-only",
	"--forbid-pending",
	"--full-trace",
	"--global",
	"--globals",
	"--grep",
	"--ignore",
	"--inline-diffs",
	"--invert",
	"--jobs",
	"--node-option",
	"--package",
	"--parallel",
	"--recursive",
	"--reporter",
	"--reporter-option",
	"--require",
	"--retries",
	"--slow",
	"--sort",
	"--spec",
	"--timeout",
	"--ui",
	"-b",
	"-c",
	"-f",
	"-g",
	"-i",
	"-j",
	"-n",
	"-O",
	"-R",
	"-r",
	"-s",
	"-t",
	"-u",
])

function hasExplicitTargets(args) {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === "--") {
			return args.slice(i + 1).some((value) => !value.startsWith("-"))
		}
		if (optionsWithValue.has(arg)) {
			i += 1
			continue
		}
		if (!arg.startsWith("-")) {
			return true
		}
	}
	return false
}

const defaultSpecs = ["--spec", "src/**/__tests__/*.ts", "--spec", "src/test/services/**/*.test.ts"]
const bootstrapArgs = [
	"--no-config",
	"--extension",
	"ts",
	"--require",
	"ts-node/register",
	"--require",
	"tsconfig-paths/register",
	"--require",
	"source-map-support/register",
	"--require",
	"./src/test/requires.ts",
	"--recursive",
	"--exit",
]

const mochaArgs = [
	...bootstrapArgs,
	...(hasExplicitTargets(userArgs) ? [] : defaultSpecs),
	...userArgs,
]

const result = spawnSync(process.execPath, [mochaBin, ...mochaArgs], {
	cwd: path.resolve(__dirname, ".."),
	stdio: "inherit",
	env: {
		...process.env,
		TS_NODE_PROJECT: process.env.TS_NODE_PROJECT || "./tsconfig.unit-test.json",
	},
})

if (result.error) {
	throw result.error
}

process.exit(result.status ?? 1)
