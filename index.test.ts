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

describe("install notices", () => {
  test("toasts when the install starts and again when it finishes", async () => {
    const pkgName = `my-plugin-${process.pid}-${Date.now()}-toast`
    const { root, pluginDir, binDir } = makeTempPlugin(pkgName)
    const config = path.join(root, "opencode.jsonc")
    fs.writeFileSync(config, `{ "plugin": ["${pkgName}"] }\n`)

    process.env.PATH = binDir
    process.env.OPENCODE_CONFIG = config
    delete process.env.OPENCODE_CLIENT

    const toasts: any[] = []
    const client = {
      tui: {
        showToast: async (req: any) => {
          toasts.push(req.body)
        },
      },
    }

    try {
      await autoUpdate({
        pkgName,
        client,
        importMeta: { url: `file://${pluginDir}/entry.ts` } as ImportMeta,
        registryUrl: "data:application/json,%7B%22version%22%3A%221.1.0%22%7D",
        opencodeBin: path.join(binDir, "missing-opencode"),
        skipOsNotification: true,
        checkIntervalMs: 0,
      })
    } finally {
      fs.rmSync(
        path.join(os.homedir(), ".cache", "opencode", `${pkgName}.update-kit.json`),
        { force: true },
      )
    }

    expect(toasts).toHaveLength(2)
    expect(toasts[0].variant).toBe("info")
    expect(toasts[0].message).toContain("installing")
    expect(toasts[1].variant).toBe("success")
    expect(toasts[1].message).toContain("restart")
  })

  test("skipInstallNotice suppresses only the install-start toast", async () => {
    const pkgName = `my-plugin-${process.pid}-${Date.now()}-skip`
    const { root, pluginDir, binDir } = makeTempPlugin(pkgName)
    const config = path.join(root, "opencode.jsonc")
    fs.writeFileSync(config, `{ "plugin": ["${pkgName}"] }\n`)

    process.env.PATH = binDir
    process.env.OPENCODE_CONFIG = config
    delete process.env.OPENCODE_CLIENT

    const toasts: any[] = []
    const client = {
      tui: {
        showToast: async (req: any) => {
          toasts.push(req.body)
        },
      },
    }

    try {
      await autoUpdate({
        pkgName,
        client,
        importMeta: { url: `file://${pluginDir}/entry.ts` } as ImportMeta,
        registryUrl: "data:application/json,%7B%22version%22%3A%221.1.0%22%7D",
        opencodeBin: path.join(binDir, "missing-opencode"),
        skipInstallNotice: true,
        skipOsNotification: true,
        checkIntervalMs: 0,
      })
    } finally {
      fs.rmSync(
        path.join(os.homedir(), ".cache", "opencode", `${pkgName}.update-kit.json`),
        { force: true },
      )
    }

    expect(toasts).toHaveLength(1)
    expect(toasts[0].variant).toBe("success")
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

describe("v2 runtime", () => {
  const stateFile = (pkgName: string) =>
    path.join(os.homedir(), ".cache", "opencode", `${pkgName}.update-kit.json`)

  // Fake v2 CLI: records its argv and prints what `plugin update` would.
  function fakeCli(binDir: string, stdout: string) {
    const bin = path.join(binDir, "opencode2")
    const argsFile = path.join(binDir, "args.txt")
    fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > "${argsFile}"\necho "${stdout}"\n`)
    fs.chmodSync(bin, 0o755)
    return { bin, argsFile }
  }

  async function run(pkgName: string, pluginDir: string, bin: string) {
    await autoUpdate({
      pkgName,
      runtime: "v2",
      importMeta: { url: `file://${pluginDir}/entry.ts` } as ImportMeta,
      registryUrl: "data:application/json,%7B%22version%22%3A%221.1.0%22%7D",
      opencodeBin: bin,
      skipOsNotification: true,
      checkIntervalMs: 0,
    })
  }

  test("moves exact pins in plugin and plugins, leaves the rest", async () => {
    const pkgName = `my-plugin-${process.pid}-${Date.now()}`
    const { root, pluginDir, binDir } = makeTempPlugin(pkgName)
    const { bin, argsFile } = fakeCli(binDir, "Updated Server plugin")
    const config = path.join(root, "opencode.jsonc")
    fs.writeFileSync(
      config,
      [
        "{",
        `  "plugin": ["${pkgName}@1.0.0", ["${pkgName}@1.0.0", { "label": "${pkgName}" }], "other@1.0.0"],`,
        `  "plugins": [{ "package": "${pkgName}@1.0.0", "options": { "note": "${pkgName}@1.0.0" } }, "${pkgName}@latest"],`,
        `  "note": "${pkgName}@1.0.0"`,
        "}",
        "",
      ].join("\n"),
    )
    process.env.OPENCODE_CONFIG = config

    try {
      await run(pkgName, pluginDir, bin)
      const text = fs.readFileSync(config, "utf8")
      expect(text).toContain(
        `"plugin": ["${pkgName}@1.1.0", ["${pkgName}@1.1.0", { "label": "${pkgName}" }], "other@1.0.0"]`,
      )
      expect(text).toContain(
        `"plugins": [{ "package": "${pkgName}@1.1.0", "options": { "note": "${pkgName}@1.0.0" } }, "${pkgName}@latest"]`,
      )
      expect(text).toContain(`"note": "${pkgName}@1.0.0"`)
      expect(fs.existsSync(argsFile)).toBe(false)
      expect(JSON.parse(fs.readFileSync(stateFile(pkgName), "utf8")).installed).toBe("1.1.0")
    } finally {
      fs.rmSync(stateFile(pkgName), { force: true })
    }
  })

  test("hands unpinned entries to `plugin update`", async () => {
    const pkgName = `my-plugin-${process.pid}-${Date.now()}`
    const { root, pluginDir, binDir } = makeTempPlugin(pkgName)
    const { bin, argsFile } = fakeCli(binDir, `Updated Server plugin "${pkgName}"`)
    const config = path.join(root, "opencode.jsonc")
    fs.writeFileSync(config, `{ "plugins": ["${pkgName}"] }\n`)
    process.env.OPENCODE_CONFIG = config

    try {
      await run(pkgName, pluginDir, bin)
      expect(fs.readFileSync(argsFile, "utf8").trim()).toBe(`plugin update ${pkgName}`)
      expect(fs.readFileSync(config, "utf8")).toBe(`{ "plugins": ["${pkgName}"] }\n`)
      expect(JSON.parse(fs.readFileSync(stateFile(pkgName), "utf8")).installed).toBe("1.1.0")
    } finally {
      fs.rmSync(stateFile(pkgName), { force: true })
    }
  })

  test("does not stamp an install when v2 applied nothing", async () => {
    const pkgName = `my-plugin-${process.pid}-${Date.now()}`
    const { root, pluginDir, binDir } = makeTempPlugin(pkgName)
    const { bin } = fakeCli(binDir, "No plugin updates available")
    const config = path.join(root, "opencode.jsonc")
    fs.writeFileSync(config, `{ "plugins": ["${pkgName}"] }\n`)
    process.env.OPENCODE_CONFIG = config

    try {
      await run(pkgName, pluginDir, bin)
      expect(JSON.parse(fs.readFileSync(stateFile(pkgName), "utf8")).installed).toBeUndefined()
    } finally {
      fs.rmSync(stateFile(pkgName), { force: true })
    }
  })
})
