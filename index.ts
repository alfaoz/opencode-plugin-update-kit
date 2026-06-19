import path from "path"
import os from "os"
import fs from "fs"

export interface AutoUpdateOptions {
  /** npm package name (e.g. "my-plugin") */
  pkgName: string
  /** opencode client from plugin context */
  client: any
  /** Bun shell ($) from plugin context */
  $: any
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

  // Fallback: check opencode cache
  try {
    const cacheDir = path.join(os.homedir(), ".cache/opencode/packages")
    if (fs.existsSync(cacheDir)) {
      for (const sub of fs.readdirSync(cacheDir)) {
        if (sub.startsWith(pkgName)) {
          const pkgPath = path.join(
            cacheDir,
            sub,
            "node_modules",
            pkgName,
            "package.json",
          )
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
            if (pkg.version) return pkg.version
          } catch {}
        }
      }
    }
  } catch {}

  return null
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
  } = opts

  const log = opts.log ?? createLogger(client, pkgName)

  // Chain onto the previous update so all plugins run sequentially
  const task = async () => {
    const current = currentVersion(pkgName, importMeta)
    if (!current) {
      log(`could not determine current version for "${pkgName}"`, "warn")
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

    if (!semverGt(latest, current)) return

    log(`update available: ${current} -> ${latest}`, "info")

    const specifier = `${pkgName}@${latest}`
    const bin =
      opts.opencodeBin ??
      process.env.OPENCODE_BIN ??
      path.join(os.homedir(), ".opencode/bin/opencode")

    try {
      await $`${bin} plugin ${specifier} --force --global`.quiet()
    } catch {
      try {
        await $`opencode plugin ${specifier} --force --global`.quiet()
      } catch (e2: any) {
        log(`update failed: ${e2?.message ?? e2}`, "warn")
        return
      }
    }

    log(
      `update applied: ${current} -> ${latest}; restart opencode to load`,
      "info",
    )

    if (!skipToast) {
      try {
        await client?.tui?.showToast?.({
          body: {
            message: `${pkgName} updated to ${latest}, restart opencode to apply`,
            variant: "success",
            duration: toastDuration,
          },
        })
      } catch {
        // toast is best-effort
      }
    }
  }

  const result = queue.then(() => task())
  queue = result.catch(() => {})
  return result
}
