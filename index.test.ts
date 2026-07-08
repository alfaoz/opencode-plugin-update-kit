import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { autoUpdate } from "./index"

const oldEnv = { ...process.env }

afterEach(() => {
  process.env = { ...oldEnv }
})

function makeTempPlugin(pkgName: string, version = "1.0.0") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-kit-test-"))
  const pluginDir = path.join(root, "plugin")
  const binDir = path.join(root, "bin")
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({ name: pkgName, version }),
  )
  return { root, pluginDir, binDir }
}

describe("autoUpdate config fallback", () => {
  test("only rewrites plugin specs when the CLI is unavailable", async () => {
    const pkgName = `my-plugin-${process.pid}-${Date.now()}`
    const { root, pluginDir, binDir } = makeTempPlugin(pkgName)
    const config = path.join(root, "opencode.jsonc")
    fs.writeFileSync(
      config,
      [
        "{",
        `  "plugin": ["${pkgName}", ["${pkgName}", { "label": "${pkgName}" }]],`,
        `  "note": "${pkgName}"`,
        "}",
        "",
      ].join("\n"),
    )

    process.env.PATH = binDir
    process.env.OPENCODE_CONFIG = config

    try {
      await autoUpdate({
        pkgName,
        client: {},
        importMeta: { url: `file://${pluginDir}/entry.ts` } as ImportMeta,
        registryUrl: "data:application/json,%7B%22version%22%3A%221.1.0%22%7D",
        opencodeBin: path.join(binDir, "missing-opencode"),
        skipToast: true,
        skipOsNotification: true,
        checkIntervalMs: 0,
      })
    } finally {
      fs.rmSync(
        path.join(os.homedir(), ".cache", "opencode", `${pkgName}.update-kit.json`),
        { force: true },
      )
    }

    expect(fs.readFileSync(config, "utf8")).toContain(
      `"plugin": ["${pkgName}@1.1.0", ["${pkgName}@1.1.0", { "label": "${pkgName}" }]]`,
    )
    expect(fs.readFileSync(config, "utf8")).toContain(`"note": "${pkgName}"`)
  })
})
