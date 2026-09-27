# opencode-plugin-update-kit

Auto-update kit for [opencode](https://opencode.ai) plugins. Drop it in and your plugin auto-updates on startup — no boilerplate.

## Install

```bash
bun add opencode-plugin-update-kit
```

## Usage

```ts
import { autoUpdate } from "opencode-plugin-update-kit"

export default async function MyPlugin(ctx) {
  autoUpdate({
    pkgName: "my-plugin",
    client: ctx.client,
    $: ctx.$,
    importMeta: import.meta,
  })

  // ... rest of your plugin
}
```

That's it. On every startup it checks npm for a newer version and runs `opencode plugin my-plugin@X.Y.Z --force --global` if found.

### opencode v2

v2 plugins export `{ id, setup }` and get no `client`. Pass `runtime: "v2"`:

```ts
export default {
  id: "my-plugin",
  setup: async (ctx) => {
    autoUpdate({ pkgName: "my-plugin", importMeta: import.meta, runtime: "v2" })
    // ...
  },
}
```

v2 treats exact version pins (`my-plugin@1.2.3`) as immutable and has no `opencode plugin <pkg> --global`, so the kit moves the pin in the global config instead (both the v1 `plugin` and v2 `plugins` keys, including `{ "package": … }` entries). v2 re-reads the config and reloads the plugin without a restart. An unpinned entry is left to v2 and applied with `opencode plugin update my-plugin`, run through the v2 binary itself (or `opencode2`, never a bare `opencode`, which may be v1). v2 server plugins can't show TUI toasts, so the notice is an OS notification.

## API

### `autoUpdate(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pkgName` | `string` | — | Your npm package name |
| `client` | `OpencodeClient` | — | From plugin context (v1 only) |
| `$` | `BunShell` | — | From plugin context |
| `importMeta` | `ImportMeta` | — | Pass `import.meta` so the kit can find your `package.json` |
| `log` | `(msg, level?) => void` | `client.app.log` with `console.log` fallback | Custom logger |
| `registryUrl` | `string` | `https://registry.npmjs.org/{pkgName}/latest` | Custom npm registry |
| `opencodeBin` | `string` | `OPENCODE_BIN` env or `~/.opencode/bin/opencode` | Custom opencode binary path |
| `toastDuration` | `number` | `86_400_000` (24h) | Toast duration in ms. `0` for app default. |
| `skipToast` | `boolean` | `false` | Disable toast notifications |
| `skipInstallNotice` | `boolean` | `false` | Disable the "installing in background…" notice shown when an update is found, before the install starts |
| `skipOsNotification` | `boolean` | `false` | Disable the OS-native notification used under the desktop app (which doesn't render TUI toasts) |
| `runtime` | `"v1" \| "v2"` | `"v1"` | Which opencode runtime loaded the plugin. See [opencode v2](#opencode-v2). |
| `checkIntervalMs` | `number` | `5_000` (5s) | Minimum time between npm registry checks. Skips the network request if called again within the window. `0` to check on every startup. |

### `currentVersion(pkgName, importMeta)`

Returns the running plugin version as a string, or `null` if it can't be determined.

```ts
const version = currentVersion("my-plugin", import.meta)
```

### `semverGt(a, b)`

Semver greater-than comparison (x.y.z only).

```ts
if (semverGt("2.0.0", version)) {
  // critical update
}
```

## How it works

1. **Version detection** — walks up from the caller's file to find `package.json` with a matching `name`
2. **Throttle** — skips the registry round-trip if it checked within `checkIntervalMs` (default 5s); the last-check time is persisted to `~/.cache/opencode/{pkgName}.update-kit.json`
3. **Registry check** — fetches `https://registry.npmjs.org/{pkgName}/latest`
4. **Semver compare** — if latest > current, proceeds
5. **Install stamp** — records the installed version so it doesn't reinstall the same version on every startup while you wait to restart (the running code stays on the old version until then)
6. **Sequential install** — all updates queue through a single promise chain, so multiple plugins never race on the config file or npm cache
7. **Notification** — a toast when the install starts (the install can briefly stall the opencode UI, so the user knows why), and a persistent toast asking the user to restart once it's done

## Concurrency

When multiple plugins use this kit, updates execute one at a time. If plugin A and plugin B both detect new versions during the same startup, the `opencode plugin` CLI commands run sequentially — no config corruption, no cache contention.

## License

MIT
