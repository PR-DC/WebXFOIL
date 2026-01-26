# WebXFOIL (WebAssembly)

Builds XFOIL into WebAssembly using the flang-wasm container. The repo includes
a cached source archive in sources/ downloaded by scripts/fetch_deps.ps1.

## Requirements
- Docker
- Node.js 18+
- PowerShell (Windows) for the helper scripts

## Quick start (Windows)
1) powershell -File scripts/fetch_deps.ps1
2) powershell -File scripts/build.ps1
3) powershell -File scripts/smoke_test.ps1

## npm scripts
- npm run fetch-deps
- npm run build
- npm run smoke

## Outputs
- dist/xfoil.js
- dist/xfoil.wasm

## API (index.js exports)

### WebXFOIL
- `static load(options?) -> Promise<WebXFOIL>`
  - `moduleUrl`: URL/string to the JS module (default: `dist/xfoil.js` beside the package).
  - `wasmUrl`: URL/string to the wasm binary (default: `dist/xfoil.wasm` beside the module).
  - `moduleFactory`: Emscripten module factory function (overrides `moduleUrl`).
  - `exportName`: ESM export name when using `moduleUrl` (default: `XfoilModule`).
  - `wasmBinary`: Uint8Array/ArrayBuffer/Buffer to use instead of fetching.
  - `workDir`: FS working directory (default: `/work`).
  - `onStdout` / `onStderr`: callbacks invoked per output line (carriage returns treated as line breaks).
  - `moduleOptions` / `locateFile`: forwarded to Emscripten module config.
- `static input(lines?) -> XfoilInput`
- `static Input` (alias for `XfoilInput`)
- `input(lines?) -> XfoilInput` (instance helper)
- `run(sessionText, options?) -> { raw, output }`
  - `sessionText`: newline-separated XFOIL commands.
  - `options.workDir`: FS directory to run in.
  - `options.files`: array of `{ path, data }` written before running (path relative to workDir unless absolute).
  - `options.args`: argv array passed to `callMain` (rarely needed).
  - `options.scalarKeys`: list of labels to extract from output (e.g., `CL`, `CD`, `Cm`).
  - `raw`: `{ stdout, stderr, exitCode }`
  - `output`: parsed result from `parseXfoilOutput(raw, { scalarKeys })`
- `writeFile(path, data)`: write to Emscripten FS.
- `readFile(path, encoding?)`: read from Emscripten FS.
- `FS`: Emscripten virtual FS instance.
- `reset()`: destroy and reload the wasm module using the original load options.
- `destroy()`: best-effort cleanup and release of the wasm runtime.

### XfoilInput
Builder for session text.
- `add(line | lines[])`, `addLines(lines)`: append raw commands.
- `blank(count?)`: add blank lines.
- `load(path)`, `naca(code)`
- `addFile(path, data)`: stage a file to be written before running XFOIL.
- `files`: array of staged `{ path, data }` entries to pass as `run(..., { files })`.
- `loadAirfoilText(text, options?)`: parse an airfoil file payload, stage it, and add `LOAD`.
  - `options.path`: staged file path (default: `airfoil_input.dat`)
  - `options.name`: fallback name if the airfoil file has no header
  - returns `{ name, format, path }`
- `scaleAirfoil(options?)`: scale the currently loaded airfoil in-place (no additional LOAD needed).
  - Requires a prior `loadAirfoilText(...)`
  - `options.targetTc`: desired thickness ratio (t/c)
  - `options.scale`: alternative direct scale factor (used if `targetTc` not provided)
  - `options.sampleCount`: resampling points along x/c (default: 201)
  - `options.name`: override airfoil name in the staged file
  - returns `{ name, path, baseTc, scale, points }`
- `setDelimiter(kind)`: 0/1/2 or `blank`/`comma`/`tab` (affects file outputs like `CPWR`).
- `oper()`
- `setAlpha(value)`, `addAlpha(value)`, `setAlphas(values[])`
- Pressure diagram commands:
  - `cpx()`: plot Cp vs x.
  - `cpv()`: plot airfoil with pressure vectors.
  - `cpio()`: toggle inviscid Cp overlay.
  - `cref()`: toggle reference Cp overlay.
  - `grid()`: toggle Cp plot grid.
  - `cpmi(value?)`: set minimum Cp axis annotation.
  - `cpmin()`: report minimum Cp.
  - `cpwr(path?)`: write Cp vs x to file.
- `quit()`
- `toArray()`, `toString()`

### Parsers
- `parseXfoilOutput(raw, options?)`: parse stdout/stderr text into a structured object.
- `parseCsvPairs(text)`: parse `#x,y` style CSV into `{ x, y }` rows.
- `parseAirfoil(text)`: parse airfoil coordinate files into `{ x, y }` rows.
- `parseBlDump(text)`: parse `DUMP` output into boundary-layer rows.
- `parsePolarLastRow(text)`: parse the last row of an XFOIL polar table into a single object.
- `parsePolarRows(text)`: parse a full XFOIL polar table into an array of row objects.
- `normalizeNumberToken(token)`, `parseFloatToken(token)`: helpers for Fortran-style numbers.

### Airfoil geometry helpers
From `src/airfoil_geometry.js`:
- `splitAtMinX(points)`: split a closed airfoil point list into upper/lower halves at the minimum x.
- `ensureAscending(points)`: return points ordered with ascending x.
- `cleanAirfoil(points, tol?)`: remove near-duplicate points and close tiny TE gaps.
- `signedArea(points)`: signed polygon area (orientation helper).
- `getSurfaceCoords(airfoil)`: return `{ upper, lower, orientation, cleaned }`.
- `findSegmentAtX(points, x)`: find the segment that spans x (or closest segment).
- `surfaceAtX(points, x)`: interpolate surface point + tangent at x.
- `outwardNormal(tx, ty, orientation)`: normal from tangent + orientation.
- `normalAtSurface(upper, lower, x, side, orientation)`: outward normal at x on a side.
- `normalizeVector(x, y)`: normalize a 2D vector.
- `estimateTeProjection(surfaces)`: estimate TE offset/projection and TE points.
- `computeWakeNormals(wake, lowerRefPoint)`: compute wake normals with consistent side.

### parseXfoilOutput(raw, options?)
Parse stdout/stderr text into a structured object.
- `options.scalarKeys`: list of labels to extract; last match wins.
Returns:
- `text`: combined stdout/stderr.
- `lines`: `text` split into lines.
- `scalars`: `{ [key]: { raw, value } }` where `value` is numeric (Fortran `D` exponents supported).
- `hasNaN`, `hasFortranError`, `hasConvergenceFail`

Notes:
- WASM loads automatically from dist/ beside the module.
- For custom hosting, pass moduleUrl/wasmUrl to override auto-loading.

## Example
See the smoke test in `tools/smoke_test.js` for a full working session. Minimal usage:

```js
import { WebXFOIL } from "webxfoil-wasm";

const xfoil = await WebXFOIL.load();
const input = WebXFOIL.input()
  .naca("0012")
  .add("PANE")
  .oper()
  .add("MACH 0")
  .add("VISC 1e6")
  .add("ITER 200")
  .setAlpha(2)
  .toString();

const { raw, output } = xfoil.run(input, {
  workDir: "/work",
  scalarKeys: ["CL", "Cm", "CD", "a"],
});
```

## Sources
- scripts/fetch_deps.ps1 stores the XFOIL tarball in sources/.
- Upstream XFOIL version: 6.996 (xfoil6.996.tgz).
- Keep sources/ with your distribution to satisfy GPL source availability.
- Use -Force to re-download the upstream archive.

## Environment variables
- CONTAINER_RUNTIME: docker or podman
- FLANG_WASM_IMAGE: ghcr.io/r-wasm/flang-wasm:v20.1.4
- WASM_TARGET: wasm32-unknown-emscripten
- FLANG_FLAGS: extra flang compile flags
- EMCC_FLAGS: extra emcc link flags
- FLANG_ROOT: /opt/flang
- FC or FLANG_BIN: override flang path inside the container
- HOST_MOUNT_ROOT: override host path for the container volume mount
- XFOIL_URL: override the primary source tarball URL (fetch_deps)
- XFOIL_URL_FALLBACK: override the fallback source tarball URL (fetch_deps)

## Notes
- The build produces a headless XFOIL module by stubbing missing graphics
  symbols at link time.
- Command-line GETARG/IARGC handling is disabled for wasm ABI compatibility.
- An extra object file is generated to turn COMMON blocks into strong globals
  for wasm linking.
- The output module is built with MODULARIZE=1, EXPORT_ES6=1, and EXPORT_NAME=XfoilModule.

## License
- This package is GPL-2.0-or-later.
- XFOIL is distributed under the GNU GPL (see the MIT XFOIL download page).
  If you distribute the produced WebAssembly build, comply with the GPL.
- See SOURCES.md for source provenance details.
- See COPYING for the full license text.
- See THIRD_PARTY_NOTICES.md for toolchain/runtime notices.
