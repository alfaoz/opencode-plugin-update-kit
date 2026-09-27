import path from "path"
import os from "os"
import fs from "fs"
import { spawn } from "child_process"

export interface AutoUpdateOptions {
  /** npm package name (e.g. "my-plugin") */
  pkgName: string
  /** opencode client from plugin context (v1). v2 plugins have none. */
  client?: any
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
   * Skip the notice shown when an update is found and the background install
   * starts. The install can briefly stall the opencode UI, so by default the
   * kit surfaces a toast (or a system notification under the desktop app)
   * before spawning it. Default: false.
   */
  skipInstallNotice?: boolean
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
  /**
   * Which opencode runtime loaded the plugin. Default: "v1".
   *
   * "v1" installs through `opencode plugin <pkg>@<ver> --force --global`.
   * "v2" has no such command and treats exact version pins as immutable, so
   * the kit moves the pin in the global config instead (v2 re-reads it and
   * reloads the plugin without a restart); an unpinned entry is handed to
   * v2's own `opencode plugin update`. v2 server plugins get no client, so
   * notices go out as OS notifications.
   */
  runtime?: "v1" | "v2"
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

// ── opencode CLI resolution (Windows-aware) ─────────────────────────

export interface SpawnSpec {
  cmd: string
  args: string[]
  options: { windowsVerbatimArguments?: boolean }
}

/**
 * Resolve how to spawn the opencode CLI portably.
 *
 * On POSIX this is a passthrough. On Windows the CLI may be a native
 * `opencode.exe` or an npm `opencode.cmd` shim: extension-less paths do not
 * spawn at all, and Node refuses to spawn `.cmd`/`.bat` files directly
 * (CVE-2024-27980), so those are routed through `cmd.exe` with batch-style
 * argument quoting.
 */
export function opencodeSpawnSpec(bin: string, args: string[]): SpawnSpec {
  if (process.platform !== "win32") return { cmd: bin, args, options: {} }

  let target = bin
  if (!/\.(exe|cmd|bat)$/i.test(target)) {
    if (target.includes("/") || target.includes("\\")) {
      for (const ext of [".exe", ".cmd", ".bat"]) {
        if (fs.existsSync(target + ext)) {
          target += ext
          break
        }
      }
    } else {
      target = findOnPath(target) ?? target
    }
  }

  if (/\.(cmd|bat)$/i.test(target)) {
    // cmd.exe does not follow CreateProcess quoting rules, so build the
    // command line ourselves: quote anything with spaces/metachars, double
    // inner quotes (batch style), and disable Node's own escaping.
    const quote = (s: string) =>
      /[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    const line = [target, ...args].map(quote).join(" ")
    return {
      cmd: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      options: { windowsVerbatimArguments: true },
    }
  }
  return { cmd: target, args, options: {} }
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const p = path.join(dir, name + ext)
      try {
        if (fs.existsSync(p)) return p
      } catch {}
    }
  }
  return null
}

// ── Process + notification helpers ─────────────────────────────────

function spawnQuiet(
  cmd: string,
  args: string[],
  extra?: { windowsVerbatimArguments?: boolean },
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: "ignore", ...extra })
      p.on("error", () => resolve(false))
      p.on("close", (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

function spawnOutput(
  cmd: string,
  args: string[],
  extra?: { windowsVerbatimArguments?: boolean },
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    try {
      let stdout = ""
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], ...extra })
      p.stdout?.on("data", (chunk) => (stdout += chunk))
      p.on("error", () => resolve({ ok: false, stdout }))
      p.on("close", (code) => resolve({ ok: code === 0, stdout }))
    } catch {
      resolve({ ok: false, stdout: "" })
    }
  })
}

/**
 * The v2 CLI to run `plugin update` with. v2's server runs plugins
 * in-process, so the running binary is the v2 CLI itself; otherwise use
 * `opencode2`, which only v2 installs. Never a bare `opencode`: that may be
 * v1, where `opencode plugin update` would install a package named "update".
 */
function v2Bin(explicit?: string): string {
  if (explicit) return explicit
  if (/^opencode/i.test(path.basename(process.execPath))) return process.execPath
  return "opencode2"
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
function rewriteConfigSpec(
  pkgName: string,
  latest: string,
  pinnedOnly = false,
): boolean {
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
      const next = rewritePluginArraySpecs(text, pkgName, latest, pinnedOnly)
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

// Rewrites the plugin's specs inside one plugin array. Handles every entry
// shape both runtimes accept: "pkg@x" (both), ["pkg@x", {options}] (v1
// `plugin`), and { "package": "pkg@x", "options": {...} } (v2 `plugins`).
// With pinnedOnly, only exact x.y.z pins move: bare names, ranges and dist
// tags are left for v2's own updater, which only touches those.
function rewritePluginEntries(
  text: string,
  pkgName: string,
  latest: string,
  pinnedOnly = false,
): string {
  let out = ""
  let cursor = 0
  let i = 0
  const stack: string[] = []
  const elementIndex: number[] = []
  let key: string | null = null
  const specifier = `${pkgName}@${latest}`
  const escaped = pkgName.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&")
  const pinned = new RegExp(`^${escaped}@\\d+\\.\\d+\\.\\d+$`)

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
      const depth = stack.length
      if (stack[depth - 1] === "{" && text[skipSpaceAndComments(text, quoted.end)] === ":") {
        key = quoted.value
        i = quoted.end
        continue
      }
      const isPluginSpec = pinnedOnly
        ? pinned.test(quoted.value)
        : quoted.value === pkgName || quoted.value.startsWith(`${pkgName}@`)
      const isDirectPluginEntry = depth === 1
      const isTupleSpecifier =
        depth === 2 && stack[1] === "[" && elementIndex[depth] === 0
      const isPackageField = depth === 2 && stack[1] === "{" && key === "package"
      if (isPluginSpec && (isDirectPluginEntry || isTupleSpecifier || isPackageField)) {
        out += text.slice(cursor, i)
        out += quoteString(specifier, quoted.quote)
        cursor = quoted.end
      }
      key = null
      i = quoted.end
      continue
    }

    const ch = text[i]
    if (ch === "[" || ch === "{") {
      stack.push(ch)
      elementIndex[stack.length] = 0
      key = null
    } else if (ch === "]" || ch === "}") {
      elementIndex[stack.length] = 0
      stack.pop()
      key = null
    } else if (ch === "," && stack.length > 0) {
      elementIndex[stack.length] = (elementIndex[stack.length] ?? 0) + 1
      key = null
    }
    i++
  }

  return out + text.slice(cursor)
}

function rewritePluginArraySpecs(
  text: string,
  pkgName: string,
  latest: string,
  pinnedOnly = false,
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

    // v1 reads "plugin"; v2 reads both "plugin" and "plugins".
    if (quoted.value !== "plugin" && quoted.value !== "plugins") {
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
      pinnedOnly,
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
      if (typeof client?.app?.log !== "function") throw new Error("no client log")
      client.app.log({
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
    skipInstallNotice = false,
    toastDuration = 86_400_000,
    checkIntervalMs = 5_000,
    runtime = "v1",
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

    if (runtime === "v2") {
      // Exact pins are immutable to v2's own updater, so move the pin. v2
      // re-reads the config and reloads the plugin; v1, which shares the
      // file, installs the new pin at its next start.
      let applied = rewriteConfigSpec(pkgName, latest, true)
      if (!applied) {
        // Unpinned: v2 owns the update, ask it to apply it now.
        const spec = opencodeSpawnSpec(v2Bin(opts.opencodeBin), [
          "plugin",
          "update",
          pkgName,
        ])
        const result = await spawnOutput(spec.cmd, spec.args, spec.options)
        applied = result.ok && /Updated/.test(result.stdout)
      }
      if (!applied) {
        log(`update failed: no pinned config entry and \`plugin update\` did not apply`, "warn")
        return
      }
      writeState(pkgName, { ...state, lastCheck: Date.now(), installed: latest })
      log(`update applied: ${current} -> ${latest}`, "info")
      if (!opts.skipOsNotification) {
        await osNotify("opencode", `${pkgName} updated to ${latest}`)
      }
      return
    }

    const specifier = `${pkgName}@${latest}`
    const bin =
      opts.opencodeBin ??
      process.env.OPENCODE_BIN ??
      path.join(os.homedir(), ".opencode/bin/opencode")

    const install = async (cmd: string) => {
      // Bun shell resolves commands itself, but does not handle Windows
      // .exe/.cmd shims reliably — route Windows through the spawn spec.
      if ($ && process.platform !== "win32") {
        await $`${cmd} plugin ${specifier} --force --global`.quiet()
        return
      }
      const spec = opencodeSpawnSpec(cmd, [
        "plugin",
        specifier,
        "--force",
        "--global",
      ])
      const ok = await spawnQuiet(spec.cmd, spec.args, spec.options)
      if (!ok) throw new Error(`${cmd} plugin install failed`)
    }

    // Announce the install before it starts: `opencode plugin` can stall the
    // UI for a while, and without this the user has no idea why. Awaited so
    // the toast is delivered before the spawn can cause any stall.
    if (!skipInstallNotice) {
      const installingNotice = `${pkgName} update found (${current} -> ${latest}), installing in background…`
      if (!skipToast) {
        try {
          await client?.tui?.showToast?.({
            body: {
              message: installingNotice,
              variant: "info",
              duration: 30_000,
            },
          })
        } catch {
          // toast is best-effort
        }
      }
      if (
        !opts.skipOsNotification &&
        process.env.OPENCODE_CLIENT === "desktop"
      ) {
        await osNotify("opencode", installingNotice)
      }
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
