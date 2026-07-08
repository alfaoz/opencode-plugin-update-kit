import path from "path"
import os from "os"
import fs from "fs"
import { spawn } from "child_process"

export interface AutoUpdateOptions {
  /** npm package name (e.g. "my-plugin") */
  pkgName: string
  /** opencode client from plugin context */
  client: any
  /**
   * Bun shell ($) from plugin context. Optional: the desktop app's server
   * runs on Node and passes no shell — the kit falls back to child_process.
   */
  $?: any
  /**
   * Pass `import.meta` from your plugin entry file so the kit
   * can locate your package.json for version detection.
   */
  importMeta: ImportMeta
  /** Optional log function. Defaults to client.app.log with console fallback. */
  log?: (message: string, level?: string) => void
  /** Custom npm registry URL. Default: https://registry.npmjs.org/${pkgName}/latest */
  registryUrl?: string
  /** Custom opencode binary path. Default: process.env.OPENCODE_BIN || ~/.opencode/bin/opencode */
  opencodeBin?: string
  /** Toast duration in ms. Default: 86_400_000 (24h). Set 0 for app-default. */
  toastDuration?: number
  /** Skip toast notification. Default: false */
  skipToast?: boolean
  /**
   * Skip the OS-native notification shown when running under the opencode
   * desktop app. The desktop UI does not render TUI toasts, so the kit sends
   * a system notification instead (osascript / notify-send / PowerShell).
   * Default: false.
   */
  skipOsNotification?: boolean
  /**
   * Minimum time between npm registry checks, in ms. The kit records the last
   * check time and skips the network request if called again within this
   * window (e.g. several opencode restarts in a row). Default: 5s. Set 0 to
   * check on every startup.
   */
  checkIntervalMs?: number
}

// ── Concurrency guard ──────────────────────────────────────────────
// All updates chain through this promise so multiple plugins never
// run `opencode plugin` at the same time (config file / npm cache races).
let queue = Promise.resolve()

// ── Version helpers ────────────────────────────────────────────────

/** Semver greater-than comparison (x.y.z only). */
export function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0)
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

/**
 * Read the calling plugin's version from its package.json.
 *
 * Walks up from the caller's file (via `importMeta`) to find a
 * package.json whose `name` matches `pkgName`.
 */
export function currentVersion(
  pkgName: string,
  importMeta: ImportMeta,
): string | null {
  try {
    let dir = new URL(".", importMeta.url)
    for (let i = 0; i < 10; i++) {
      const pkgPath = new URL("package.json", dir)
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
        if (pkg.name === pkgName && pkg.version) return pkg.version
      } catch {}
      const parent = new URL("../", dir)
      if (parent.href === dir.href) break
      dir = parent
    }
  } catch {}

  // Fallback: check opencode cache. Cache dirs are named "<pkgName>@<version>",
  // so match exactly or by the "<pkgName>@" prefix — a bare startsWith would
  // also match unrelated packages whose name begins with pkgName (e.g.
  // "foo" matching "foobar"). When several versions are cached, return the
  // greatest rather than whichever the directory listing happens to yield first.
  try {
    const cacheDir = path.join(os.homedir(), ".cache/opencode/packages")
    if (fs.existsSync(cacheDir)) {
      let best: string | null = null
      for (const sub of fs.readdirSync(cacheDir)) {
        if (sub !== pkgName && !sub.startsWith(`${pkgName}@`)) continue
        const pkgPath = path.join(
          cacheDir,
          sub,
          "node_modules",
          pkgName,
          "package.json",
        )
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
          if (pkg.version && (!best || semverGt(pkg.version, best))) {
            best = pkg.version
          }
        } catch {}
      }
      if (best) return best
    }
  } catch {}

  return null
}

// ── Persisted state (throttle + install stamp) ─────────────────────

interface UpdateState {
  /** Epoch ms of the last npm registry check. */
  lastCheck?: number
  /** Version most recently installed by this kit (awaiting restart). */
  installed?: string
}

function statePath(pkgName: string): string {
  return path.join(
    os.homedir(),
    ".cache/opencode",
    `${pkgName}.update-kit.json`,
  )
}

function readState(pkgName: string): UpdateState {
  try {
    return JSON.parse(fs.readFileSync(statePath(pkgName), "utf8")) as UpdateState
  } catch {
    return {}
  }
}

function writeState(pkgName: string, state: UpdateState): void {
  try {
    const p = statePath(pkgName)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(state))
  } catch {
    // state is best-effort; failing just means we recheck next time
  }
}

// ── Process + notification helpers ─────────────────────────────────

function spawnQuiet(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: "ignore" })
      p.on("error", () => resolve(false))
      p.on("close", (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

/**
 * OS-native notification. Used under the desktop app, whose UI does not
 * render TUI toasts — the plugin host process runs as the user, so we can
 * post a system notification directly. Best-effort on every platform.
 */
async function osNotify(title: string, message: string): Promise<boolean> {
  if (process.platform === "darwin") {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    return spawnQuiet("osascript", [
      "-e",
      `display notification "${esc(message)}" with title "${esc(title)}"`,
    ])
  }
  if (process.platform === "win32") {
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/'/g, "''")
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
      "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
      `$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(message)}</text></binding></visual></toast>')`,
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('opencode').Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
    ].join("; ")
    return spawnQuiet("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      script,
    ])
  }
  return spawnQuiet("notify-send", [title, message])
}

/**
 * Last-resort update path when no opencode CLI binary is available (e.g. a
 * desktop-only install): rewrite the plugin spec in the opencode config to
 * the new version. opencode installs config-pinned versions at startup, so
 * the update lands on the next restart.
 */
function rewriteConfigSpec(pkgName: string, latest: string): boolean {
  const candidates: string[] = []
  if (process.env.OPENCODE_CONFIG) candidates.push(process.env.OPENCODE_CONFIG)
  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  candidates.push(path.join(configHome, "opencode", "opencode.jsonc"))
  candidates.push(path.join(configHome, "opencode", "opencode.json"))

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue
      const text = fs.readFileSync(p, "utf8")
      const next = rewritePluginArraySpecs(text, pkgName, latest)
      if (next === text) continue
      fs.writeFileSync(p, next)
      return true
    } catch {}
  }
  return false
}

function skipSpaceAndComments(text: string, index: number): number {
  let i = index
  while (i < text.length) {
    if (/\s/.test(text[i]!)) {
      i++
      continue
    }
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    break
  }
  return i
}

function readQuotedString(
  text: string,
  index: number,
): { end: number; quote: string; value: string } | null {
  const quote = text[index]
  if (quote !== '"' && quote !== "'") return null

  let raw = ""
  let i = index + 1
  while (i < text.length) {
    const ch = text[i]!
    if (ch === "\\") {
      raw += ch
      if (i + 1 < text.length) raw += text[i + 1]!
      i += 2
      continue
    }
    if (ch === quote) {
      let value = raw
      try {
        value = JSON.parse(`"${raw.replace(/"/g, '\\"')}"`)
      } catch {}
      return { end: i + 1, quote, value }
    }
    raw += ch
    i++
  }
  return null
}

function findMatchingBracket(text: string, openIndex: number): number {
  let depth = 0
  let i = openIndex
  while (i < text.length) {
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    const quoted = readQuotedString(text, i)
    if (quoted) {
      i = quoted.end
      continue
    }
    const ch = text[i]
    if (ch === "[") depth++
    if (ch === "]") {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

function quoteString(value: string, quote: string): string {
  const quoted = JSON.stringify(value)
  if (quote === '"') return quoted
  return `'${quoted.slice(1, -1).replace(/'/g, "\\'")}'`
}

function rewritePluginEntries(
  text: string,
  pkgName: string,
  latest: string,
): string {
  let out = ""
  let cursor = 0
  let i = 0
  let depth = 0
  const elementIndex: number[] = []
  const specifier = `${pkgName}@${latest}`

  while (i < text.length) {
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }

    const quoted = readQuotedString(text, i)
    if (quoted) {
      const isPluginSpec =
        quoted.value === pkgName || quoted.value.startsWith(`${pkgName}@`)
      const isDirectPluginEntry = depth === 1
      const isTupleSpecifier = depth === 2 && elementIndex[depth] === 0
      if (isPluginSpec && (isDirectPluginEntry || isTupleSpecifier)) {
        out += text.slice(cursor, i)
        out += quoteString(specifier, quoted.quote)
        cursor = quoted.end
      }
      i = quoted.end
      continue
    }

    const ch = text[i]
    if (ch === "[") {
      depth++
      elementIndex[depth] = 0
    } else if (ch === "]") {
      elementIndex[depth] = 0
      depth--
    } else if (ch === "," && depth > 0) {
      elementIndex[depth] = (elementIndex[depth] ?? 0) + 1
    }
    i++
  }

  return out + text.slice(cursor)
}

function rewritePluginArraySpecs(
  text: string,
  pkgName: string,
  latest: string,
): string {
  let out = ""
  let cursor = 0
  let i = 0

  while (i < text.length) {
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }

    const quoted = readQuotedString(text, i)
    if (!quoted) {
      i++
      continue
    }

    if (quoted.value !== "plugin") {
      i = quoted.end
      continue
    }

    const colon = skipSpaceAndComments(text, quoted.end)
    if (text[colon] !== ":") {
      i = quoted.end
      continue
    }
    const valueStart = skipSpaceAndComments(text, colon + 1)
    if (text[valueStart] !== "[") {
      i = quoted.end
      continue
    }
    const valueEnd = findMatchingBracket(text, valueStart)
    if (valueEnd === -1) {
      i = quoted.end
      continue
    }

    out += text.slice(cursor, valueStart)
    out += rewritePluginEntries(
      text.slice(valueStart, valueEnd + 1),
      pkgName,
      latest,
    )
    cursor = valueEnd + 1
    i = valueEnd + 1
  }

  return out + text.slice(cursor)
}

// ── Default logger ─────────────────────────────────────────────────

function createLogger(
  client: any,
  pkgName: string,
): (message: string, level?: string) => void {
  return (message, level = "info") => {
    try {
      client?.app?.log?.({
        body: { service: pkgName, level, message },
      })
    } catch {
      if (process.env.NODE_ENV !== "production") {
        console.log(`[${pkgName}] ${level}: ${message}`)
      }
    }
  }
}

// ── Main entry ─────────────────────────────────────────────────────

/**
 * Check for a newer version on npm and auto-update if available.
 *
 * Safe to call from multiple plugins — updates are queued sequentially
 * so they never race on the config file or npm cache.
 *
 * @example
 * ```ts
 * import { autoUpdate } from "opencode-plugin-update-kit"
 *
 * export default async function MyPlugin(ctx) {
 *   const { client, $ } = ctx
 *   autoUpdate({ pkgName: "my-plugin", client, $, importMeta: import.meta })
 *   // ... rest of plugin
 * }
 * ```
 */
export async function autoUpdate(
  opts: AutoUpdateOptions,
): Promise<void> {
  const {
    pkgName,
    client,
    $,
    importMeta,
    registryUrl,
    skipToast = false,
    toastDuration = 86_400_000,
    checkIntervalMs = 5_000,
  } = opts

  const log = opts.log ?? createLogger(client, pkgName)

  // Chain onto the previous update so all plugins run sequentially
  const task = async () => {
    const current = currentVersion(pkgName, importMeta)
    if (!current) {
      log(`could not determine current version for "${pkgName}"`, "warn")
      return
    }

    const state = readState(pkgName)

    // Throttle: skip the registry round-trip if we checked recently (e.g.
    // several restarts in quick succession).
    if (
      checkIntervalMs > 0 &&
      state.lastCheck &&
      Date.now() - state.lastCheck < checkIntervalMs
    ) {
      return
    }

    const registry =
      registryUrl ?? `https://registry.npmjs.org/${pkgName}/latest`

    let latest: string
    try {
      const res = await fetch(registry, {
        headers: { accept: "application/json" },
      })
      if (!res.ok) return
      const data: any = await res.json()
      latest = data?.version
      if (!latest) return
    } catch {
      return
    }

    // Record the check regardless of outcome so the throttle holds.
    writeState(pkgName, { ...state, lastCheck: Date.now() })

    if (!semverGt(latest, current)) return

    // Already installed this version on a prior startup; it just needs a
    // restart to take effect. Don't re-run `opencode plugin --force` (and
    // re-toast) on every launch until then.
    if (state.installed === latest) return

    log(`update available: ${current} -> ${latest}`, "info")

    const specifier = `${pkgName}@${latest}`
    const bin =
      opts.opencodeBin ??
      process.env.OPENCODE_BIN ??
      path.join(os.homedir(), ".opencode/bin/opencode")

    const install = async (cmd: string) => {
      if ($) {
        await $`${cmd} plugin ${specifier} --force --global`.quiet()
        return
      }
      const ok = await spawnQuiet(cmd, [
        "plugin",
        specifier,
        "--force",
        "--global",
      ])
      if (!ok) throw new Error(`${cmd} plugin install failed`)
    }

    try {
      await install(bin)
    } catch {
      try {
        await install("opencode")
      } catch (e2: any) {
        // No usable CLI (desktop-only installs don't ship one). Point the
        // config at the new version instead; opencode installs it on the
        // next startup.
        if (!rewriteConfigSpec(pkgName, latest)) {
          log(`update failed: ${e2?.message ?? e2}`, "warn")
          return
        }
      }
    }

    // Stamp the installed version so we don't reinstall it on the next
    // startup (the running code stays on the old version until restart).
    writeState(pkgName, { ...state, lastCheck: Date.now(), installed: latest })

    log(
      `update applied: ${current} -> ${latest}; restart opencode to load`,
      "info",
    )

    const notice = `${pkgName} updated to ${latest}, restart opencode to apply`

    if (!skipToast) {
      try {
        await client?.tui?.showToast?.({
          body: {
            message: notice,
            variant: "success",
            duration: toastDuration,
          },
        })
      } catch {
        // toast is best-effort
      }
    }

    // The desktop app's UI ignores TUI toasts; its host process sets
    // OPENCODE_CLIENT=desktop, so surface the update as a system
    // notification there instead.
    if (
      !opts.skipOsNotification &&
      process.env.OPENCODE_CLIENT === "desktop"
    ) {
      await osNotify("opencode", notice)
    }
  }

  const result = queue.then(() => task())
  queue = result.catch(() => {})
  return result
}
