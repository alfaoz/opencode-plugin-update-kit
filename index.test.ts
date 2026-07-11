import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { autoUpdate, opencodeSpawnSpec } from "./index"

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

function withWin32(fn: () => void) {
  const desc = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { value: "win32" })
  try {
    fn()
  } finally {
    Object.defineProperty(process, "platform", desc)
  }
}

describe("opencodeSpawnSpec", () => {
  test("is a passthrough on posix", () => {
    if (process.platform === "win32") return
    expect(opencodeSpawnSpec("opencode", ["plugin", "x@1.0.0"])).toEqual({
      cmd: "opencode",
      args: ["plugin", "x@1.0.0"],
      options: {},
    })
  })

  test("resolves extension-less paths to .exe when present", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-kit-spawn-"))
    const bin = path.join(root, "opencode")
    fs.writeFileSync(`${bin}.exe`, "")
    withWin32(() => {
      const spec = opencodeSpawnSpec(bin, ["plugin", "x@1.0.0"])
      expect(spec.cmd).toBe(`${bin}.exe`)
      expect(spec.args).toEqual(["plugin", "x@1.0.0"])
      expect(spec.options).toEqual({})
    })
  })

  test("routes .cmd shims through cmd.exe with batch quoting", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-kit-spawn-"))
    const shim = path.join(root, "with space", "opencode.cmd")
    fs.mkdirSync(path.dirname(shim), { recursive: true })
    fs.writeFileSync(shim, "")
    withWin32(() => {
      const spec = opencodeSpawnSpec(shim, ["run", "hello world", 'say "hi"'])
      expect(spec.cmd).toBe(process.env.ComSpec || "cmd.exe")
      expect(spec.options.windowsVerbatimArguments).toBe(true)
      expect(spec.args.slice(0, 3)).toEqual(["/d", "/s", "/c"])
      expect(spec.args[3]).toBe(
        `""${shim}" run "hello world" "say ""hi""""`,
      )
    })
  })

  test("finds bare commands on PATH", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-kit-spawn-"))
    fs.writeFileSync(path.join(root, "opencode.cmd"), "")
    process.env.PATH = root
    withWin32(() => {
      const spec = opencodeSpawnSpec("opencode", ["--version"])
      expect(spec.cmd).toBe(process.env.ComSpec || "cmd.exe")
      expect(spec.args[3]).toContain("opencode.cmd")
    })
  })
})
