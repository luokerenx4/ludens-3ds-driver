# Ludens 3DS driver

Optional Nintendo 3DS driver for Ludens/Baseware, using a patched Azahar emulator. The package exports the `azahar` driver registration and includes its provider, native bridge, patch, build recipe, and independent tests. Installing the driver package does **not** install or compile the emulator.

The bridge targets Azahar **2126.2**, upstream commit **`219d743a1e698101fe1ab8bef43e6563126c3c27`**. The driver version is `2126.2-rsa.3` and bridge protocol is `azahar-rsa-3`. Source provenance is recorded in [upstream.json](upstream.json). This repository contains bridge code and a patch; it does not vendor the complete emulator source or any games.

## Prepare the emulator

The build recipe targets **Apple Silicon macOS**. Install **Git**, **CMake**, and **Xcode Command Line Tools**. Upstream CMake downloads its Qt and MoltenVK dependencies; the initial build needs network access and can take a while. Bun is needed for package installation and tests, but the build script itself only needs Bash and the native build tools.

```sh
git clone https://github.com/luokerenx4/ludens-3ds-driver.git
cd ludens-3ds-driver
# Check out the same reviewed commit used for driverPackage below.
DRIVER_REV='<reviewed-driver-commit>'
git checkout "$DRIVER_REV"
bun install --frozen-lockfile
bun run emulator:build
```

The script fetches the fixed upstream tag, verifies its exact commit, fetches submodules, applies [native/azahar.patch](native/azahar.patch), and injects [native/rsa_bridge.cpp](native/rsa_bridge.cpp). It refuses a different source revision and accepts its own already-applied patch without resetting local source edits.

All downloaded sources and generated binaries default to a user cache **outside this checkout**:

| Setting | Default / purpose |
| --- | --- |
| `RSA_AZAHAR_CACHE` | `${XDG_CACHE_HOME:-$HOME/.cache}/ludens/azahar/2126.2-rsa.3` |
| `RSA_AZAHAR_SOURCE` | `$RSA_AZAHAR_CACHE/source`; source checkout at the fixed upstream commit |
| `RSA_AZAHAR_BUILD` | `$RSA_AZAHAR_CACHE/build`; CMake build directory |
| `RSA_BUILD_JOBS` | `4`; parallel build jobs |
| `RSA_AZAHAR_APP` | `$RSA_AZAHAR_BUILD/bundle/azahar.app`; **launch selection only** |
| `RSA_BRIDGE_PORT` | `47673` for the manual launcher; RSA supplies the workspace port |

Use absolute override paths. The build always leaves its result in `$RSA_AZAHAR_BUILD/bundle/azahar.app`. It does not install into `/Applications` or replace an app selected by `RSA_AZAHAR_APP`. The default build output can be launched directly. To install a copy elsewhere, first quit that application, copy the built bundle yourself, and set `RSA_AZAHAR_APP` to its absolute `.app` path before discovery or `rsa up`.

## Install the optional driver

Use a Ludens/Baseware version with external driver package support. Choose a reviewed commit from this repository and replace the placeholder below with its full SHA; no npm publication is assumed.

```sh
DRIVER_REV='<reviewed-driver-commit>'
DRIVER_PACKAGE="github:luokerenx4/ludens-3ds-driver#$DRIVER_REV"
baseware driver discover --package "$DRIVER_PACKAGE"

mkdir -p /absolute/path/to/workspace
cd /absolute/path/to/workspace
rsa init --driver azahar --driver-package "$DRIVER_PACKAGE" \
  --game /absolute/path/to/game.3ds
rsa up --dry-run
rsa up
rsa controller list
```

The package is imported during discovery; use a trusted, pinned revision. `rsa init` records `driverPackage` in the workspace configuration. `rsa up --dry-run` prints the launch plan; it does not build or start Azahar. The manifest points to the resolved **actual Azahar executable**, so RSA can check its existence and detect an already running application. The app selection is captured in `launchCommand` and `launchEnv` because launchd does not inherit arbitrary shell environment variables. Set any custom cache/build/app overrides consistently for discovery and later `rsa up` invocations.

For local development, use `baseware driver discover --package file:/absolute/path/to/ludens-3ds-driver`, then `rsa init --driver azahar --driver-package file:/absolute/path/to/ludens-3ds-driver`. The provider and all copied contracts are self-contained; their imports do not refer to the Ludens source checkout.

## Launch and connection

For RSA-managed startup, set `game` as above. RSA injects the configured bridge port and launches the emulator. To connect to an already running patched emulator, omit `--game` when initializing and start it manually first:

```sh
# Run from this driver checkout. The default app is the build output in the cache.
bun run emulator:launch /absolute/path/to/game.3ds

# Or select an independently installed patched app and a distinct bridge port.
RSA_AZAHAR_APP=/Applications/Azahar.app RSA_BRIDGE_PORT=47674 \
  bun run emulator:launch /absolute/path/to/game.3ds
```

Use the same port in the workspace's `rsa.json` when overriding it. The bridge listens on **127.0.0.1**, defaults to **47673**, and starts when a game is loaded. A stock unpatched Azahar application will not expose this bridge. Starting from Finder does not supply `RSA_BRIDGE_PORT`; use RSA or the manual launcher. One Baseware connection owns a bridge at a time. An existing emulator process should be connected to without a managed `game` launch, or quit before asking RSA to start another instance.

`rsa auto off` releases controller ownership while preserving the game. `rsa down --keep-emulator` stops the workspace services and keeps the emulator; `rsa down` also stops a workspace-managed emulator, so save progress first. These lifecycle actions are implemented by the host; this package resets native input on release or bridge disconnect.

## Device capabilities

- `pad.play`, `pad.state`, `pad.status`, `pad.wait`, `pad.cancel`, `pad.release`: native controller timelines. Buttons are `A`, `B`, `X`, `Y`, `L`, `R`, `START`, `SELECT`, `LEFT`, `UP`, `RIGHT`, `DOWN`, `ZL`, and `ZR`. `LX/LY` are the Circle Pad; `RX/RY` are the C Stick. Axes use `[-1, 1]`, positive X right, positive Y up.
- `screen.top.capture`: the independent **400 × 240** upper screen, left-eye image.
- `screen.bottom.capture`: the independent **320 × 240** lower screen. The screens share a native capture slot and are sampled serially, not simultaneously; `captureSequence` counts captures, not displayed frames.
- `touch.down`, `touch.move`, `touch.up`: a single lower-screen contact at native coordinates **x = 0..319**, **y = 0..239**, with a top-left origin and inclusive endpoints. Taps, drags, and window-to-screen coordinate conversion belong in workspace code.

RSA exposes these device tools in its `controller/` namespace. These are native game input and framebuffer capabilities and do not depend on desktop Cua.

## Develop and verify

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run native:test
bun run scripts:check
RSA_AZAHAR_SOURCE=/absolute/path/to/azahar-source bun run emulator:patch-check
```

The tests cover provider registration, launch path and environment propagation, an isolated build-recipe fixture, pad timelines and cancellation, ownership release, touch, capture-file cleanup, both screen sources, and tool contracts. The native test compiles the real C++ bridge with a small simulated HID consumer using `clang++`; it checks asynchronous input timing, release/disconnect reset, and stale ownership without starting an emulator or loading a game. It is skipped when `clang++` is unavailable or on Windows. The build-recipe test stubs Git/CMake and does not download or build Azahar.

`emulator:patch-check` requires an existing source checkout at the fixed upstream SHA, reads pristine blobs into a temporary directory, and verifies the patch there. It also works when the source checkout already has the bridge patch applied, without modifying it. These checks and fixture tests do not replace a full emulator build and real-game smoke test.
