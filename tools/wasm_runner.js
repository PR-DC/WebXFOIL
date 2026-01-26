"use strict";

function isNode() {
  return (
    typeof process !== "undefined" &&
    process.versions &&
    process.versions.node
  );
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/");
}

function joinPath(base, rel) {
  const b = toPosixPath(base || "");
  const r = toPosixPath(rel || "");
  if (!b) return r;
  if (!r) return b;
  if (r.startsWith("/")) return r;
  return `${b.replace(/\/$/, "")}/${r}`;
}

function dirname(pathValue) {
  const normalized = toPosixPath(pathValue || "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "/";
  return normalized.slice(0, idx);
}

function ensureDir(fs, dirPath) {
  const normalized = toPosixPath(dirPath || "");
  if (!normalized || normalized === "/") return;
  const parts = normalized.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    if (!fs.analyzePath(current).exists) {
      fs.mkdir(current);
    }
  }
}

function toBytes(data) {
  if (data == null) return new Uint8Array(0);
  if (typeof data === "string") {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(data);
    }
    if (typeof Buffer !== "undefined") {
      return Uint8Array.from(Buffer.from(data, "utf8"));
    }
  }
  if (data instanceof Uint8Array) return data;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  throw new Error("Unsupported input type for bytes.");
}

function fromBytes(data, encoding) {
  if (!encoding) return data;
  const enc = encoding === "utf8" ? "utf-8" : encoding;
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder(enc).decode(data);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data).toString(encoding);
  }
  throw new Error("TextDecoder not available.");
}

function normalizeLineBreaks(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function createLineBuffer(state, key, onLine) {
  const bufferKey = `${key}Buffer`;
  state[bufferKey] = "";

  const pushLine = (line) => {
    state[key].push(line);
    if (onLine) onLine(line);
  };

  return {
    write(text) {
      const normalized = normalizeLineBreaks(text);
      if (!normalized && !state[bufferKey]) return;
      if (!state[bufferKey] && !normalized.includes("\n")) {
        pushLine(normalized);
        return;
      }
      const combined = `${state[bufferKey]}${normalized}`;
      const parts = combined.split("\n");
      const endsWithNewline = combined.endsWith("\n");
      const lineCount = endsWithNewline ? parts.length : Math.max(0, parts.length - 1);
      for (let i = 0; i < lineCount; i += 1) {
        pushLine(parts[i]);
      }
      state[bufferKey] = endsWithNewline ? "" : parts[parts.length - 1];
    },
    flush() {
      if (!state[bufferKey]) return;
      pushLine(state[bufferKey]);
      state[bufferKey] = "";
    },
    reset() {
      state[bufferKey] = "";
    },
  };
}

function callMain(module, args) {
  let exitCode = 0;
  try {
    module.callMain(args);
  } catch (err) {
    if (err && err.name === "ExitStatus") {
      exitCode = err.status || 0;
    } else {
      throw err;
    }
  }
  return exitCode;
}

function linesToText(lines) {
  if (!lines.length) return "";
  return lines.join("\n");
}

function toUrl(value, baseUrl) {
  if (!value) return null;
  if (value instanceof URL) return value;
  try {
    return new URL(value);
  } catch {
    return new URL(value, baseUrl);
  }
}

async function resolveModuleFactory(artifactBase, options) {
  const moduleUrl =
    toUrl(options.moduleUrl, import.meta.url) ||
    new URL(`../dist/${artifactBase}.js`, import.meta.url);
  let moduleFactory = options.moduleFactory;

  if (!moduleFactory) {
    const mod = await import(moduleUrl.href);
    moduleFactory = mod.default || (options.exportName ? mod[options.exportName] : undefined);
  }

  if (typeof moduleFactory !== "function") {
    throw new Error(`Module factory not available for ${artifactBase}.`);
  }

  return { moduleFactory, moduleUrl };
}

class WasmRunner {
  constructor(module, state, options = {}) {
    this._module = module;
    this._state = state;
    this._workDir = options.workDir || "/work";
  }

  static async load(artifactBase, options = {}) {
    const { moduleFactory, moduleUrl } = await resolveModuleFactory(
      artifactBase,
      options
    );

  const state = {
    stdout: [],
    stderr: [],
    stdin: null,
    stdinOffset: 0,
  };

  const onStdout =
    typeof options.onStdout === "function" ? options.onStdout : null;
  const onStderr =
    typeof options.onStderr === "function" ? options.onStderr : null;
  const stdoutLines = createLineBuffer(state, "stdout", onStdout);
  const stderrLines = createLineBuffer(state, "stderr", onStderr);
  state._stdoutLines = stdoutLines;
  state._stderrLines = stderrLines;

  const moduleOptions = {
    noInitialRun: true,
    noExitRuntime: true,
    print(text) {
      stdoutLines.write(text);
    },
    printErr(text) {
      stderrLines.write(text);
    },
    stdin() {
      if (!state.stdin) return null;
      if (state.stdinOffset >= state.stdin.length) return null;
      return state.stdin[state.stdinOffset++];
      },
    };

    if (options.wasmBinary) {
      moduleOptions.wasmBinary = toBytes(options.wasmBinary);
    }

    if (options.moduleOptions && typeof options.moduleOptions === "object") {
      const { print, printErr, stdin, locateFile, ...rest } = options.moduleOptions;
      Object.assign(moduleOptions, rest);
      if (!options.locateFile && !options.wasmUrl && locateFile) {
        moduleOptions.locateFile = locateFile;
      }
    }

    if (options.locateFile) {
      moduleOptions.locateFile = options.locateFile;
    } else if (options.wasmUrl) {
      const wasmUrl = toUrl(options.wasmUrl, moduleUrl);
      moduleOptions.locateFile = (file) => {
        if (file.endsWith(".wasm")) {
          return wasmUrl.href;
        }
        return file;
      };
    }

    const module = await moduleFactory(moduleOptions);
    return new WasmRunner(module, state, { workDir: options.workDir });
  }

  get FS() {
    return this._module.FS;
  }

  exists(pathValue) {
    const path = toPosixPath(pathValue);
    return this._module.FS.analyzePath(path).exists;
  }

  writeFile(pathValue, data) {
    const path = toPosixPath(pathValue);
    ensureDir(this._module.FS, dirname(path));
    this._module.FS.writeFile(path, toBytes(data));
  }

  readFile(pathValue, encoding = "utf8") {
    const path = toPosixPath(pathValue);
    const data = this._module.FS.readFile(path);
    return fromBytes(data, encoding);
  }

  runWithStdin(stdinText, options = {}) {
    this._state.stdout.length = 0;
    this._state.stderr.length = 0;
    if (this._state._stdoutLines) this._state._stdoutLines.reset();
    if (this._state._stderrLines) this._state._stderrLines.reset();
    if (stdinText == null) {
      this._state.stdin = null;
      this._state.stdinOffset = 0;
    } else {
      this._state.stdin = toBytes(stdinText);
      this._state.stdinOffset = 0;
    }

    const workDir = toPosixPath(options.workDir || this._workDir || "");
    if (workDir) {
      ensureDir(this._module.FS, workDir);
      this._module.FS.chdir(workDir);
    }

    const files = options.files || [];
    for (const file of files) {
      if (!file || !file.path) continue;
      const dest = toPosixPath(file.path);
      const target = dest.startsWith("/") ? dest : joinPath(workDir, dest);
      ensureDir(this._module.FS, dirname(target));
      this._module.FS.writeFile(target, toBytes(file.data));
    }

    let exitCode = 0;
    try {
      exitCode = callMain(this._module, options.args || []);
    } finally {
      if (this._state._stdoutLines) this._state._stdoutLines.flush();
      if (this._state._stderrLines) this._state._stderrLines.flush();
    }
    return {
      stdout: linesToText(this._state.stdout),
      stderr: linesToText(this._state.stderr),
      exitCode,
    };
  }

  destroy() {
    const module = this._module;
    if (!module) return;
    try {
      const fs = module.FS;
      if (fs && typeof fs.analyzePath === "function") {
        const workDir = this._workDir || "/work";
        if (fs.analyzePath(workDir).exists) {
          const entries = fs.readdir(workDir);
          for (const name of entries) {
            if (name === "." || name === "..") continue;
            const target = `${workDir}/${name}`;
            try {
              fs.unlink(target);
            } catch {
              // ignore cleanup errors
            }
          }
        }
      }
    } catch {
      // ignore cleanup errors
    }

    try {
      if (typeof module._exit === "function") {
        module._exit(0);
      }
    } catch {
      // ignore exit errors
    }

    if (this._state) {
      this._state.stdout = [];
      this._state.stderr = [];
      this._state.stdin = null;
      this._state.stdoutBuffer = "";
      this._state.stderrBuffer = "";
    }

    this._module = null;
    this._state = null;
  }
}

export { WasmRunner, isNode, joinPath, toPosixPath };
