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

## API

### `autoUpdate(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pkgName` | `string` | — | Your npm package name |
| `client` | `OpencodeClient` | — | From plugin context |
| `$` | `BunShell` | — | From plugin context |
| `importMeta` | `ImportMeta` | — | Pass `import.meta` so the kit can find your `package.json` |
| `log` | `(msg, level?) => void` | `client.app.log` with `console.log` fallback | Custom logger |
| `registryUrl` | `string` | `https://registry.npmjs.org/{pkgName}/latest` | Custom npm registry |
| `opencodeBin` | `string` | `OPENCODE_BIN` env or `~/.opencode/bin/opencode` | Custom opencode binary path |
| `toastDuration` | `number` | `86_400_000` (24h) | Toast duration in ms. `0` for app default. |
| `skipToast` | `boolean` | `false` | Disable toast notification |

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
2. **Registry check** — fetches `https://registry.npmjs.org/{pkgName}/latest` 
3. **Semver compare** — if latest > current, proceeds
4. **Sequential install** — all updates queue through a single promise chain, so multiple plugins never race on the config file or npm cache
5. **Notification** — logs the result and shows a persistent toast asking the user to restart

## Concurrency

When multiple plugins use this kit, updates execute one at a time. If plugin A and plugin B both detect new versions during the same startup, the `opencode plugin` CLI commands run sequentially — no config corruption, no cache contention.

## License

MIT
