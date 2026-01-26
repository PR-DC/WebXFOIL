# Corresponding Source Information (XFOIL)

This package builds XFOIL into WebAssembly.

If you distribute the .wasm output, the GPL requires you to provide the
Corresponding Source. That means:
- The exact upstream XFOIL source used (or a mirror) and its license.
- This repository, which contains the build scripts and patches.

Upstream source:
- Name: XFOIL
- License: GPL (see upstream site)
- Primary URL: https://web.mit.edu/drela/Public/web/xfoil/xfoil6.996.tgz
- Fallback URL: https://web.mit.edu/drela/Public/web/xfoil/xfoil6.99.tgz
- Downloaded by: scripts/fetch_deps.ps1
- The download script records the URL and SHA256 in this file.
- Local archive path: sources/

Build modifications (applied by tools/build.js):
- Disable IARGC/GETARG handling for wasm ABI compatibility.
- Patch userio.f to handle EOF and skip lines starting with '#'.
- Add a COMMON block anchor object to turn COMMON globals into strong globals.
- Auto-stub unresolved symbols at link time for headless builds.

If you distribute binaries, record the exact source you used:
- XFOIL source URL: https://web.mit.edu/drela/Public/web/xfoil/xfoil6.996.tgz
- XFOIL source SHA256: 5b6363ce4f32062838f5fe910ab924883c05dd7f408454655af6b9a844611120

