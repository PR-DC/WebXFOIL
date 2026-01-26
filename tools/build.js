import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(runtime, args, options = {}) {
  const result = spawnSync(runtime, args, {
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? "inherit",
    ...options,
  });
  if (result.error) {
    fail(`Failed to run ${runtime}: ${result.error.message}`);
  }
  return result;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const buildDir = path.join(root, "build");
const distDir = path.join(root, "dist");
const sourcesDir = path.join(root, "sources");

fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(sourcesDir, { recursive: true });

const runtime = process.env.CONTAINER_RUNTIME || "docker";
const image =
  process.env.FLANG_WASM_IMAGE || "ghcr.io/r-wasm/flang-wasm:v20.1.4";
const wasmTarget = process.env.WASM_TARGET || "wasm32-unknown-emscripten";
const flangRoot = process.env.FLANG_ROOT || "/opt/flang";
const flangOverride = process.env.FC || process.env.FLANG_BIN || "";
const extraFlags = (process.env.FLANG_FLAGS || "").trim();
const extraLinkFlags = (process.env.EMCC_FLAGS || "").trim();

const hostRoot = process.env.HOST_MOUNT_ROOT || root;
const containerRoot = "/work";

function toContainerPath(hostPath) {
  const rel = path.relative(root, hostPath).split(path.sep).join("/");
  return `${containerRoot}/${rel}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

const version = run(runtime, ["--version"], { stdio: "ignore" });
if (version.status !== 0) {
  fail(
    `Container runtime '${runtime}' not found or not working. Set CONTAINER_RUNTIME to docker or podman.`
  );
}

const pull = run(runtime, ["pull", image], { stdio: "inherit" });
if (pull.status !== 0) {
  process.exit(pull.status || 1);
}

function runContainer(args, options = {}) {
  return run(runtime, args, options);
}

function runInContainer(args, options = {}) {
  return runContainer(
    [
      "run",
      "--rm",
      "-v",
      `${hostRoot}:${containerRoot}`,
      "-w",
      containerRoot,
      image,
      ...args,
    ],
    options
  );
}

function runContainerShell(command, options = {}) {
  return runContainer(["run", "--rm", image, "sh", "-lc", command], options);
}

function runContainerShellMounted(command, options = {}) {
  return runInContainer(["sh", "-lc", command], options);
}

let flangCmd = flangOverride.trim();
if (!flangCmd) {
  const detect = runContainerShell(
    [
      `command -v flang-new || command -v flang || { test -x ${flangRoot}/host/bin/flang && echo ${flangRoot}/host/bin/flang; } || { test -x ${flangRoot}/host/bin/flang-new && echo ${flangRoot}/host/bin/flang-new; }`,
    ].join(" "),
    { encoding: "utf8", stdio: "pipe" }
  );
  if (detect.status !== 0) {
    if (detect.stdout) {
      console.error(detect.stdout.trim());
    }
    if (detect.stderr) {
      console.error(detect.stderr.trim());
    }
    fail("Unable to find flang inside container image " + image);
  }
  flangCmd = detect.stdout.trim().split(/\s+/).pop();
  if (!flangCmd) {
    fail("No flang binary detected inside container image " + image);
  }
}

let emccCmd = "";
const emccCheck = runContainerShell(
  [
    "command -v emcc || { test -x /opt/emsdk/upstream/emscripten/emcc && echo /opt/emsdk/upstream/emscripten/emcc; }",
  ].join(" "),
  { encoding: "utf8", stdio: "pipe" }
);
if (emccCheck.status !== 0) {
  fail("Unable to find emcc inside container image " + image);
}
emccCmd = emccCheck.stdout.trim().split(/\s+/).pop();
if (!emccCmd) {
  fail("Unable to resolve emcc path inside container image " + image);
}

console.log("Fortran compiler:", flangCmd);
console.log("Emscripten:", emccCmd);
console.log("Target:", wasmTarget);

const tarball = path.join(sourcesDir, "xfoil.tgz");
const unpackDir = path.join(buildDir, "xfoil_unpack");
const tarballContainer = toContainerPath(tarball);
const unpackContainer = toContainerPath(unpackDir);
const tarballQ = shellQuote(tarballContainer);
const unpackQ = shellQuote(unpackContainer);
let tarFlags = "-xf";
try {
  const fd = fs.openSync(tarball, "r");
  const magic = Buffer.alloc(2);
  fs.readSync(fd, magic, 0, 2, 0);
  fs.closeSync(fd);
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    tarFlags = "-xzf";
  }
} catch {
  // Default to plain tar extraction if magic bytes cannot be read.
}

if (!fs.existsSync(tarball)) {
  fail("Missing sources/xfoil.tgz. Run scripts/fetch_deps.ps1 first.");
}

const unpackCmd = [
  `rm -rf ${unpackQ}`,
  `mkdir -p ${unpackQ}`,
  `tar ${tarFlags} ${tarballQ} -C ${unpackQ}`,
].join(" && ");
const unpackResult = runContainerShellMounted(unpackCmd, { stdio: "inherit" });
if (unpackResult.status !== 0) {
  process.exit(unpackResult.status || 1);
}

function findSrcRoot(baseDir, maxDepth) {
  if (fs.existsSync(path.join(baseDir, "src"))) {
    return baseDir;
  }
  let found = "";
  function walk(dir, depth) {
    if (found || depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === "src") {
          found = path.dirname(full);
          return;
        }
        walk(full, depth + 1);
        if (found) return;
      }
    }
  }
  walk(baseDir, 0);
  return found;
}

const xfoilRoot = findSrcRoot(unpackDir, 3);
if (!xfoilRoot || !fs.existsSync(path.join(xfoilRoot, "src"))) {
  fail("Could not locate XFOIL src/ directory inside the tarball.");
}

const srcDir = path.join(xfoilRoot, "src");
console.log("XFOIL root:", xfoilRoot);
console.log("XFOIL src :", srcDir);

function patchXfoilDisableGetarg() {
  const filePath = path.join(srcDir, "xfoil.f");
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const output = [];
  let doneNarg = false;
  for (const line of lines) {
    if (!doneNarg && line.includes("NARG = IARGC()")) {
      output.push(`C     ${line}`);
      output.push("      NARG = 0");
      doneNarg = true;
      continue;
    }
    if (line.includes("CALL GETARG") && line.includes("NARG") && line.includes("FNAME")) {
      output.push(`C     ${line}`);
      continue;
    }
    output.push(line);
  }
  fs.writeFileSync(filePath, output.join("\n"));
}

function patchUserioGetarg0() {
  const filePath = path.join(srcDir, "userio.f");
  if (!fs.existsSync(filePath)) {
    return;
  }
  let text = fs.readFileSync(filePath, "utf8");
  text = text.replace(
    /^[ \t]*CALL GETARG\(IARG,ARG\)/m,
    "       ARG = ' '"
  );
  fs.writeFileSync(filePath, text);
}

function patchUserioAskc() {
  const filePath = path.join(srcDir, "userio.f");
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const output = [];
  let inAskc = false;
  let addedLoopLabel = false;
  let addedCommentSkip = false;
  let addedEofLabel = false;

  for (const line of lines) {
    if (line.includes("SUBROUTINE ASKC")) {
      inAskc = true;
      addedLoopLabel = false;
      addedCommentSkip = false;
      addedEofLabel = false;
      output.push(line);
      continue;
    }

    if (inAskc) {
      if (!addedLoopLabel && line.includes("WRITE(*,1000)") && line.includes("PROMPT")) {
        output.push("    1 CONTINUE");
        addedLoopLabel = true;
      }

      if (line.includes("READ (*,1020) LINE") && !line.includes("END=")) {
        output.push(line.replace("READ (*,1020) LINE", "READ (*,1020,END=900,ERR=900) LINE"));
        continue;
      }

      if (!addedCommentSkip && line.trimStart().startsWith("5") && line.includes("CONTINUE")) {
        output.push(line);
        output.push("C---- ignore comment lines starting with '#'.");
        output.push("      IF(LINE(1:1) .EQ. '#') GO TO 1");
        addedCommentSkip = true;
        continue;
      }

      if (!addedEofLabel && line.trimStart().startsWith("1000") && line.includes("FORMAT")) {
        output.push(" 900  CONTINUE");
        output.push("      STOP");
        addedEofLabel = true;
      }

      if (line.includes("END ! ASKC")) {
        inAskc = false;
      }
    }

    output.push(line);
  }
  fs.writeFileSync(filePath, output.join("\n"));
}

function patchXoperCpWake() {
  const filePath = path.join(srcDir, "xoper.f");
  if (!fs.existsSync(filePath)) {
    return;
  }
  let text = fs.readFileSync(filePath, "utf8");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";

  const helpRe = /^(\s*&\s*\/'\s*CPWR f\s+Output x vs Cp to file'\s*)$/m;
  if (!text.includes("CPWK f   Output inviscid wake Cp")) {
    text = text.replace(
      helpRe,
      (match) => `${match}${newline}     & /'   CPWK f   Output inviscid wake Cp'`
    );
  }
  if (!text.includes("UEWK f   Output inviscid wake Ue")) {
    text = text.replace(
      helpRe,
      (match) => `${match}${newline}     & /'   UEWK f   Output inviscid wake Ue'`
    );
  }
  if (!text.includes("CPVW f   Output viscous wake Cp")) {
    text = text.replace(
      helpRe,
      (match) => `${match}${newline}     & /'   CPVW f   Output viscous wake Cp'`
    );
  }

  const cmdRe =
    /^(\s*ELSEIF\(COMAND\.EQ\.'CPWR'\)\s*THEN\s*\r?\n\s*CALL CPDUMP\(COMARG\)\s*\r?\n)(\s*C\s*\r?\n\s*C-+\s*\r?\n)/m;
  if (!text.includes("COMAND.EQ.'CPWK'")) {
    text = text.replace(
      cmdRe,
      (match, head, sep) =>
        `${head}      ELSEIF(COMAND.EQ.'CPWK') THEN${newline}` +
        `         CALL CPDUMPW(COMARG)${newline}` +
        `${sep}`
    );
  }
  const cmdAfterCpwkRe =
    /^(\s*ELSEIF\(COMAND\.EQ\.'CPWK'\)\s*THEN\s*\r?\n\s*CALL CPDUMPW\(COMARG\)\s*\r?\n)(\s*C\s*\r?\n\s*C-+\s*\r?\n)/m;
  if (!text.includes("COMAND.EQ.'UEWK'")) {
    if (text.includes("COMAND.EQ.'CPWK'")) {
      text = text.replace(
        cmdAfterCpwkRe,
        (match, head, sep) =>
          `${head}      ELSEIF(COMAND.EQ.'UEWK') THEN${newline}` +
          `         CALL UEDUMPW(COMARG)${newline}` +
          `${sep}`
      );
    } else {
      text = text.replace(
        cmdRe,
        (match, head, sep) =>
          `${head}      ELSEIF(COMAND.EQ.'UEWK') THEN${newline}` +
          `         CALL UEDUMPW(COMARG)${newline}` +
          `${sep}`
      );
    }
  }
  const cmdAfterUewkRe =
    /^(\s*ELSEIF\(COMAND\.EQ\.'UEWK'\)\s*THEN\s*\r?\n\s*CALL UEDUMPW\(COMARG\)\s*\r?\n)(\s*C\s*\r?\n\s*C-+\s*\r?\n)/m;
  if (!text.includes("COMAND.EQ.'CPVW'")) {
    if (text.includes("COMAND.EQ.'UEWK'")) {
      text = text.replace(
        cmdAfterUewkRe,
        (match, head, sep) =>
          `${head}      ELSEIF(COMAND.EQ.'CPVW') THEN${newline}` +
          `         CALL CPDUMPV(COMARG)${newline}` +
          `${sep}`
      );
    } else if (text.includes("COMAND.EQ.'CPWK'")) {
      text = text.replace(
        cmdAfterCpwkRe,
        (match, head, sep) =>
          `${head}      ELSEIF(COMAND.EQ.'CPVW') THEN${newline}` +
          `         CALL CPDUMPV(COMARG)${newline}` +
          `${sep}`
      );
    } else {
      text = text.replace(
        cmdRe,
        (match, head, sep) =>
          `${head}      ELSEIF(COMAND.EQ.'CPVW') THEN${newline}` +
          `         CALL CPDUMPV(COMARG)${newline}` +
          `${sep}`
      );
    }
  }

  const anchorRe = /^\s*END\s*!\s*CPDUMP\s*$/m;
  const snippet =
    `${newline}${newline}` +
    `      SUBROUTINE CPDUMPW(FNAME1)${newline}` +
    `      INCLUDE 'XFOIL.INC'${newline}` +
    `      CHARACTER*(*) FNAME1${newline}` +
    `C${newline}` +
    `      CHARACTER*80 FILDEF${newline}` +
    `C${newline}` +
    `      CHARACTER*1 DELIM${newline}` +
    `      CHARACTER*128 LINE${newline}` +
    `C${newline}` +
    `      IF    (KDELIM.EQ.0) THEN${newline}` +
    `       DELIM = ' ' ${newline}` +
    `      ELSEIF(KDELIM.EQ.1) THEN${newline}` +
    `       DELIM = ','${newline}` +
    `      ELSEIF(KDELIM.EQ.2) THEN${newline}` +
    `       DELIM = CHAR(9)${newline}` +
    `      ELSE${newline}` +
    `       WRITE(*,*) '? Illegal delimiter.  Using blank.'${newline}` +
    `       DELIM = ' '${newline}` +
    `      ENDIF${newline}` +
    `C${newline}` +
    ` 1000 FORMAT(8A)${newline}` +
    `C${newline}` +
    `      IF(FNAME1(1:1).NE.' ') THEN${newline}` +
    `       FNAME = FNAME1${newline}` +
    `      ELSE${newline}` +
    `       IF(NPREFIX.GT.0) THEN${newline}` +
    `        FILDEF = PREFIX(1:NPREFIX) // '.cp'${newline}` +
    `        WRITE(*,1100) FILDEF${newline}` +
    ` 1100   FORMAT(/' Enter filename:  ', A)${newline}` +
    `        READ(*,1000) FNAME${newline}` +
    `        CALL STRIP(FNAME,NFN)${newline}` +
    `        IF(NFN.EQ.0) FNAME = FILDEF${newline}` +
    `       ELSE${newline}` +
    `        CALL ASKS('Enter filename^',FNAME)${newline}` +
    `       ENDIF${newline}` +
    `      ENDIF${newline}` +
    `C${newline}` +
    `      LU = 19${newline}` +
    `      OPEN(LU,FILE=FNAME,STATUS='UNKNOWN')${newline}` +
    `      REWIND(LU)${newline}` +
    `C${newline}` +
    `      IF(KDELIM.EQ.0) THEN${newline}` +
    `       WRITE(LU,1000)${newline}` +
    `     &  '#      x          Cp  '${newline}` +
    `      ELSE${newline}` +
    `       WRITE(LU,1000)${newline}` +
    `     &  '#x', DELIM,${newline}` +
    `     &  'Cp'${newline}` +
    `      ENDIF${newline}` +
    `C${newline}` +
    `      CALL CPCALC(N+NW,QINV,QINF,MINF,CPI)${newline}` +
    `C${newline}` +
    `      DO 10 I=1, N+NW${newline}` +
    `        IF(KDELIM.EQ.0) THEN${newline}` +
    `         WRITE(LU,8500) X(I), CPI(I)${newline}` +
    ` 8500    FORMAT(1X,2F11.5)${newline}` +
    `        ELSE${newline}` +
    `         WRITE(LINE,8510)${newline}` +
    `     &    X(I) , DELIM,${newline}` +
    `     &    CPI(I)${newline}` +
    ` 8510    FORMAT(1X,2(F11.5,A))${newline}` +
    `         CALL BSTRIP(LINE,NLINE)${newline}` +
    `         WRITE(LU,1000) LINE(1:NLINE)${newline}` +
    `        ENDIF${newline}` +
    `   10 CONTINUE${newline}` +
    `C${newline}` +
    `      CLOSE(LU)${newline}` +
    `      RETURN${newline}` +
    `      END ! CPDUMPW${newline}`;

  if (!text.includes("SUBROUTINE CPDUMPW")) {
    if (!anchorRe.test(text)) {
      throw new Error("CPDUMP anchor not found in xoper.f");
    }
    text = text.replace(anchorRe, (match) => `${match}${snippet}`);
  }

  if (!text.includes("SUBROUTINE UEDUMPW")) {
    const ueSnippet =
      `${newline}${newline}` +
      `      SUBROUTINE UEDUMPW(FNAME1)${newline}` +
      `      INCLUDE 'XFOIL.INC'${newline}` +
      `      CHARACTER*(*) FNAME1${newline}` +
      `C${newline}` +
      `      CHARACTER*80 FILDEF${newline}` +
      `C${newline}` +
      `      CHARACTER*1 DELIM${newline}` +
      `      CHARACTER*128 LINE${newline}` +
      `C${newline}` +
      `      IF    (KDELIM.EQ.0) THEN${newline}` +
      `       DELIM = ' ' ${newline}` +
      `      ELSEIF(KDELIM.EQ.1) THEN${newline}` +
      `       DELIM = ','${newline}` +
      `      ELSEIF(KDELIM.EQ.2) THEN${newline}` +
      `       DELIM = CHAR(9)${newline}` +
      `      ELSE${newline}` +
      `       WRITE(*,*) '? Illegal delimiter.  Using blank.'${newline}` +
      `       DELIM = ' '${newline}` +
      `      ENDIF${newline}` +
      `C${newline}` +
      ` 1000 FORMAT(8A)${newline}` +
      `C${newline}` +
      `      IF(FNAME1(1:1).NE.' ') THEN${newline}` +
      `       FNAME = FNAME1${newline}` +
      `      ELSE${newline}` +
      `       IF(NPREFIX.GT.0) THEN${newline}` +
      `        FILDEF = PREFIX(1:NPREFIX) // '.ue'${newline}` +
      `        WRITE(*,1100) FILDEF${newline}` +
      ` 1100   FORMAT(/' Enter filename:  ', A)${newline}` +
      `        READ(*,1000) FNAME${newline}` +
      `        CALL STRIP(FNAME,NFN)${newline}` +
      `        IF(NFN.EQ.0) FNAME = FILDEF${newline}` +
      `       ELSE${newline}` +
      `        CALL ASKS('Enter filename^',FNAME)${newline}` +
      `       ENDIF${newline}` +
      `      ENDIF${newline}` +
      `C${newline}` +
      `      LU = 19${newline}` +
      `      OPEN(LU,FILE=FNAME,STATUS='UNKNOWN')${newline}` +
      `      REWIND(LU)${newline}` +
      `C${newline}` +
      `      IF(KDELIM.EQ.0) THEN${newline}` +
      `       WRITE(LU,1000)${newline}` +
      `     &  '#      x        Ue  '${newline}` +
      `      ELSE${newline}` +
      `       WRITE(LU,1000)${newline}` +
      `     &  '#x', DELIM,${newline}` +
      `     &  'Ue'${newline}` +
      `      ENDIF${newline}` +
      `C${newline}` +
      `      DO 10 I=1, N+NW${newline}` +
      `        IF(KDELIM.EQ.0) THEN${newline}` +
      `         WRITE(LU,8500) X(I), QINV(I)${newline}` +
      ` 8500    FORMAT(1X,2F11.5)${newline}` +
      `        ELSE${newline}` +
      `         WRITE(LINE,8510)${newline}` +
      `     &    X(I) , DELIM,${newline}` +
      `     &    QINV(I)${newline}` +
      ` 8510    FORMAT(1X,2(F11.5,A))${newline}` +
      `         CALL BSTRIP(LINE,NLINE)${newline}` +
      `         WRITE(LU,1000) LINE(1:NLINE)${newline}` +
      `        ENDIF${newline}` +
      `   10 CONTINUE${newline}` +
      `C${newline}` +
      `      CLOSE(LU)${newline}` +
      `      RETURN${newline}` +
      `      END ! UEDUMPW${newline}`;

    const cpDumpwEndRe = /^\s*END\s*!\s*CPDUMPW\s*$/m;
    if (cpDumpwEndRe.test(text)) {
      text = text.replace(cpDumpwEndRe, (match) => `${match}${ueSnippet}`);
    } else if (anchorRe.test(text)) {
      text = text.replace(anchorRe, (match) => `${match}${ueSnippet}`);
    } else {
      throw new Error("Unable to insert UEDUMPW in xoper.f");
    }
  }

  if (!text.includes("SUBROUTINE CPDUMPV")) {
    const cpvSnippet =
      `${newline}${newline}` +
      `      SUBROUTINE CPDUMPV(FNAME1)${newline}` +
      `      INCLUDE 'XFOIL.INC'${newline}` +
      `      CHARACTER*(*) FNAME1${newline}` +
      `C${newline}` +
      `      CHARACTER*80 FILDEF${newline}` +
      `C${newline}` +
      `      CHARACTER*1 DELIM${newline}` +
      `      CHARACTER*128 LINE${newline}` +
      `C${newline}` +
      `      IF    (KDELIM.EQ.0) THEN${newline}` +
      `       DELIM = ' ' ${newline}` +
      `      ELSEIF(KDELIM.EQ.1) THEN${newline}` +
      `       DELIM = ','${newline}` +
      `      ELSEIF(KDELIM.EQ.2) THEN${newline}` +
      `       DELIM = CHAR(9)${newline}` +
      `      ELSE${newline}` +
      `       WRITE(*,*) '? Illegal delimiter.  Using blank.'${newline}` +
      `       DELIM = ' '${newline}` +
      `      ENDIF${newline}` +
      `C${newline}` +
      ` 1000 FORMAT(8A)${newline}` +
      `C${newline}` +
      `      IF(FNAME1(1:1).NE.' ') THEN${newline}` +
      `       FNAME = FNAME1${newline}` +
      `      ELSE${newline}` +
      `       IF(NPREFIX.GT.0) THEN${newline}` +
      `        FILDEF = PREFIX(1:NPREFIX) // '.cp'${newline}` +
      `        WRITE(*,1100) FILDEF${newline}` +
      ` 1100   FORMAT(/' Enter filename:  ', A)${newline}` +
      `        READ(*,1000) FNAME${newline}` +
      `        CALL STRIP(FNAME,NFN)${newline}` +
      `        IF(NFN.EQ.0) FNAME = FILDEF${newline}` +
      `       ELSE${newline}` +
      `        CALL ASKS('Enter filename^',FNAME)${newline}` +
      `       ENDIF${newline}` +
      `      ENDIF${newline}` +
      `C${newline}` +
      `      LU = 19${newline}` +
      `      OPEN(LU,FILE=FNAME,STATUS='UNKNOWN')${newline}` +
      `      REWIND(LU)${newline}` +
      `C${newline}` +
      `      IF(KDELIM.EQ.0) THEN${newline}` +
      `       WRITE(LU,1000)${newline}` +
      `     &  '#      x          Cp  '${newline}` +
      `      ELSE${newline}` +
      `       WRITE(LU,1000)${newline}` +
      `     &  '#x', DELIM,${newline}` +
      `     &  'Cp'${newline}` +
      `      ENDIF${newline}` +
      `C${newline}` +
      `      CALL CPCALC(N+NW,QVIS,QINF,MINF,CPV)${newline}` +
      `C${newline}` +
      `      DO 10 I=1, N+NW${newline}` +
      `        IF(KDELIM.EQ.0) THEN${newline}` +
      `         WRITE(LU,8500) X(I), CPV(I)${newline}` +
      ` 8500    FORMAT(1X,2F11.5)${newline}` +
      `        ELSE${newline}` +
      `         WRITE(LINE,8510)${newline}` +
      `     &    X(I) , DELIM,${newline}` +
      `     &    CPV(I)${newline}` +
      ` 8510    FORMAT(1X,2(F11.5,A))${newline}` +
      `         CALL BSTRIP(LINE,NLINE)${newline}` +
      `         WRITE(LU,1000) LINE(1:NLINE)${newline}` +
      `        ENDIF${newline}` +
      `   10 CONTINUE${newline}` +
      `C${newline}` +
      `      CLOSE(LU)${newline}` +
      `      RETURN${newline}` +
      `      END ! CPDUMPV${newline}`;

    const ueDumpwEndRe = /^\s*END\s*!\s*UEDUMPW\s*$/m;
    const cpDumpwEndRe = /^\s*END\s*!\s*CPDUMPW\s*$/m;
    if (ueDumpwEndRe.test(text)) {
      text = text.replace(ueDumpwEndRe, (match) => `${match}${cpvSnippet}`);
    } else if (cpDumpwEndRe.test(text)) {
      text = text.replace(cpDumpwEndRe, (match) => `${match}${cpvSnippet}`);
    } else if (anchorRe.test(text)) {
      text = text.replace(anchorRe, (match) => `${match}${cpvSnippet}`);
    } else {
      throw new Error("Unable to insert CPDUMPV in xoper.f");
    }
  }

  if (!text.includes("CPWK") || !text.includes("SUBROUTINE CPDUMPW")) {
    throw new Error("Failed to patch xoper.f with CPWK support.");
  }
  if (!text.includes("UEWK") || !text.includes("SUBROUTINE UEDUMPW")) {
    throw new Error("Failed to patch xoper.f with UEWK support.");
  }
  if (!text.includes("CPVW") || !text.includes("SUBROUTINE CPDUMPV")) {
    throw new Error("Failed to patch xoper.f with CPVW support.");
  }

  fs.writeFileSync(filePath, text);
}

patchXfoilDisableGetarg();
patchUserioGetarg0();
patchUserioAskc();
patchXoperCpWake();

const objDir = path.join(buildDir, "obj");
fs.rmSync(objDir, { recursive: true, force: true });
fs.mkdirSync(objDir, { recursive: true });

const containerSrcDir = toContainerPath(srcDir);
const containerObjDir = toContainerPath(objDir);

const fflags = ["-O3", `--target=${wasmTarget}`, `-I${containerSrcDir}`];
if (extraFlags.length > 0) {
  fflags.push(...extraFlags.split(/\s+/));
}

const srcFiles = [
  "xfoil.f",
  "xpanel.f",
  "xoper.f",
  "xtcam.f",
  "xgdes.f",
  "xqdes.f",
  "xmdes.f",
  "xsolve.f",
  "xbl.f",
  "xblsys.f",
  "xpol.f",
  "xplots.f",
  "pntops.f",
  "xgeom.f",
  "xutils.f",
  "modify.f",
  "blplot.f",
  "polplt.f",
  "aread.f",
  "naca.f",
  "spline.f",
  "plutil.f",
  "iopol.f",
  "gui.f",
  "sort.f",
  "dplot.f",
  "profil.f",
  "userio.f",
  "frplot0.f",
];

console.log("Compiling selected XFOIL sources (Makefile-style list):");
for (const name of srcFiles) {
  const srcPath = path.join(srcDir, name);
  if (!fs.existsSync(srcPath)) {
    fail(`Expected source not found: ${srcPath}`);
  }
  const objPath = path.join(objDir, `${path.basename(name, path.extname(name))}.o`);
  console.log("  " + name);
  const result = runInContainer(
    [
      flangCmd,
      "-c",
      ...fflags,
      "-o",
      toContainerPath(objPath),
      toContainerPath(srcPath),
    ],
    { stdio: "inherit" }
  );
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const commonAnchorF = path.join(buildDir, "xfoil_common_anchor.f");
const commonAnchorLl = path.join(buildDir, "xfoil_common_anchor.ll");
const commonDefsLl = path.join(buildDir, "xfoil_common_defs.ll");
const commonDefsO = path.join(objDir, "xfoil_common_defs.o");

fs.writeFileSync(
  commonAnchorF,
  [
    "      SUBROUTINE XFOIL_WASM_COMMON_ANCHOR()",
    "C     NOTE: We intentionally avoid BLOCK DATA here.",
    "C",
    "C     In some XFOIL/plotlib variants, included headers (e.g. PINDEX.INC)",
    "C     declare variables with DATA initializers that are not in COMMON blocks.",
    "C     Flang enforces the Fortran rule that BLOCK DATA can only initialize COMMON,",
    "C     so using BLOCK DATA for anchoring can fail. A harmless subroutine include",
    "C     keeps the COMMON blocks 'owned'/defined without triggering BLOCK DATA rules.",
    "      INCLUDE 'XFOIL.INC'",
    "      INCLUDE 'XBL.INC'",
    "      RETURN",
    "      END",
    "",
  ].join("\n")
);

runInContainer(
  [
    flangCmd,
    "-S",
    "-emit-llvm",
    ...fflags,
    "-o",
    toContainerPath(commonAnchorLl),
    toContainerPath(commonAnchorF),
  ],
  { stdio: "inherit" }
);

function rewriteCommonGlobals(inputPath, outputPath) {
  const original = fs.readFileSync(inputPath, "utf8");
  let updated = original.replace(/^(\s*@[^=]+=\s*)common\s+/gm, "$1");
  updated = updated.replace(
    /^(\s*@[^=]+=\s*)external\s+((dso_local\s+)?global\s+)(.*),\s*align/gm,
    "$1$3global $4 zeroinitializer, align"
  );
  updated = updated.replace(
    /^(\s*@[^=]+=\s*)external\s+((dso_local\s+)?global\s+)(.*)$/gm,
    "$1$3global $4 zeroinitializer"
  );
  fs.writeFileSync(outputPath, updated);
}

rewriteCommonGlobals(commonAnchorLl, commonDefsLl);

runInContainer(
  [
    emccCmd,
    "-c",
    "-O3",
    "-o",
    toContainerPath(commonDefsO),
    toContainerPath(commonDefsLl),
  ],
  { stdio: "inherit" }
);

const runtimeFind = runContainerShell(
  `find ${flangRoot} -path '*wasm*' -name libFortranRuntime.a -print -quit`,
  { encoding: "utf8", stdio: "pipe" }
);
let runtimeLib = runtimeFind.stdout.trim();
if (runtimeFind.status !== 0 || !runtimeLib) {
  const fallback = runContainerShell(
    `find ${flangRoot} -name libFortranRuntime.a -print -quit`,
    { encoding: "utf8", stdio: "pipe" }
  );
  runtimeLib = fallback.stdout.trim();
}
if (!runtimeLib) {
  fail(`Could not find libFortranRuntime.a under ${flangRoot}`);
}

const runtimeDir = path.posix.dirname(runtimeLib);
const runtimeList = runContainerShell(`ls -1 ${runtimeDir}/*.a`, {
  encoding: "utf8",
  stdio: "pipe",
});
if (runtimeList.status !== 0) {
  fail("Failed to list Fortran runtime libraries in " + runtimeDir);
}
const runtimeLibs = runtimeList.stdout.split(/\s+/).filter(Boolean);
if (runtimeLibs.length === 0) {
  fail("No Fortran runtime libraries found in " + runtimeDir);
}

const outJs = path.join(distDir, "xfoil.js");
const outWasm = path.join(distDir, "xfoil.wasm");
const tmpJs = path.join(buildDir, "link_test.js");
const linkLog = path.join(buildDir, "link_test.log");
const stubJs = path.join(buildDir, "wasm_stubs.js");

for (const p of [outJs, outWasm, tmpJs, linkLog, stubJs]) {
  fs.rmSync(p, { force: true });
}

const objects = fs
  .readdirSync(objDir)
  .filter((name) => name.endsWith(".o"))
  .map((name) => toContainerPath(path.join(objDir, name)))
  .sort();

const linkFlags = [
  "-O3",
  "-s",
  "MODULARIZE=1",
  "-s",
  "EXPORT_NAME=XfoilModule",
  "-s",
  "EXPORT_ES6=1",
  "-s",
  "FORCE_FILESYSTEM=1",
  "-s",
  "ALLOW_MEMORY_GROWTH=1",
  "-s",
  "EXPORTED_RUNTIME_METHODS=[\"FS\",\"callMain\"]",
  "-s",
  "ENVIRONMENT=web,worker,node",
  "-s",
  "INVOKE_RUN=0",
  "-s",
  "NO_EXIT_RUNTIME=1",
  "-Wl,--error-limit=0",
];
if (extraLinkFlags.length > 0) {
  linkFlags.push(...extraLinkFlags.split(/\s+/));
}

const linkTest = runInContainer(
  [
    emccCmd,
    ...objects,
    ...runtimeLibs,
    ...linkFlags,
    "-s",
    "ERROR_ON_UNDEFINED_SYMBOLS=1",
    "-o",
    toContainerPath(tmpJs),
  ],
  { encoding: "utf8", stdio: "pipe" }
);

const linkStderr = linkTest.stderr || "";
fs.writeFileSync(linkLog, linkStderr);

const undefSyms = new Set();
const re = /undefined symbol:\s*([^\s,\)]+)/g;
let match = re.exec(linkStderr);
while (match) {
  undefSyms.add(match[1]);
  match = re.exec(linkStderr);
}

if (undefSyms.size > 0) {
  console.log("Unresolved symbols detected (will stub for headless build):");
  console.log("  " + Array.from(undefSyms).sort().join(" "));
  const lines = ["mergeInto(LibraryManager.library, {"];
  for (const sym of Array.from(undefSyms).sort()) {
    lines.push(`  '${sym}': function() { return 0; },`);
  }
  lines.push("});");
  fs.writeFileSync(stubJs, lines.join("\n") + "\n");
} else {
  fs.writeFileSync(stubJs, "mergeInto(LibraryManager.library, {});\n");
}

console.log("Linking ->", outJs);
const linkFinal = runInContainer(
  [
    emccCmd,
    ...objects,
    ...runtimeLibs,
    ...linkFlags,
    "-s",
    "ERROR_ON_UNDEFINED_SYMBOLS=0",
    "--js-library",
    toContainerPath(stubJs),
    "-o",
    toContainerPath(outJs),
  ],
  { stdio: "inherit" }
);
if (linkFinal.status !== 0) {
  process.exit(linkFinal.status || 1);
}

if (!fs.existsSync(outJs) || !fs.existsSync(outWasm)) {
  fail("Build completed but output files were not found in dist/.");
}

console.log("Done.");
console.log("Artifacts:");
for (const entry of fs.readdirSync(distDir)) {
  const full = path.join(distDir, entry);
  const stat = fs.statSync(full);
  console.log(`  ${entry} (${stat.size} bytes)`);
}
