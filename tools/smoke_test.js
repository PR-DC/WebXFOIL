#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebXFOIL } from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function tailLines(text, n) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const distJs = path.join(repoRoot, "dist", "xfoil.js");
  const distWasm = path.join(repoRoot, "dist", "xfoil.wasm");

  if (!fileExists(distJs)) {
    console.error("[smoke] Missing dist/xfoil.js. Build first:");
    console.error("        scripts\\build.ps1");
    process.exit(2);
  }
  if (!fileExists(distWasm)) {
    console.error("[smoke] Missing dist/xfoil.wasm. Build first:");
    console.error("        scripts\\build.ps1");
    process.exit(2);
  }

  const input = WebXFOIL.input()
    .naca("0012")
    .add("PANE")
    .add("SAVE /work/airfoil.dat")
    .setDelimiter("comma")
    .oper()
    .add("MACH 0")
    .add("ALFA 2")
    .cpwr("/work/cp_inv.csv")
    .add("VISC 1e6")
    .add("ITER 200")
    .add("ALFA 2")
    .cpwr("/work/cp_visc.csv")
    .toString();
  const xfoil = await WebXFOIL.load();
  const result = xfoil.run(input, {
    workDir: "/work",
    scalarKeys: ["CL", "Cm", "CD", "a"],
  });

  const { raw, output } = result;
  const combined = output.text;
  const hasNaN = output.hasNaN;
  const hasConvergenceFail = output.hasConvergenceFail;
  const hasFortranFatal = output.hasFortranError;

  const clData = output.scalars.CL || { raw: null, value: NaN };
  const cmData = output.scalars.Cm || { raw: null, value: NaN };
  const cdData = output.scalars.CD || { raw: null, value: NaN };
  const aData = output.scalars.a || { raw: null, value: NaN };

  const clStr = clData.raw;
  const cmStr = cmData.raw;
  const cdStr = cdData.raw;
  const aStr = aData.raw;

  const cl = clData.value;
  const cm = cmData.value;
  const cd = cdData.value;
  const a = aData.value;

  const problems = [];
  if (hasNaN) problems.push("output contains NaN");
  if (hasConvergenceFail) problems.push("VISCAL convergence failed");
  if (hasFortranFatal) problems.push("runtime error detected");
  if (raw.exitCode !== 0) problems.push(`exit code ${raw.exitCode}`);
  if (!Number.isFinite(cl)) problems.push("CL missing or not finite");

  // Optional sanity ranges (keep broad):
  if (Number.isFinite(a) && Math.abs(a - 2.0) > 0.5) {
    problems.push(`unexpected alpha a=${aStr}`);
  }
  if (Number.isFinite(cl) && (cl < -0.5 || cl > 1.5)) {
    problems.push(`implausible CL=${clStr}`);
  }
  if (Number.isFinite(cd) && (cd < 0 || cd > 1.0)) {
    problems.push(`implausible CD=${cdStr}`);
  }

  try {
    const cpInvText = xfoil.readFile("/work/cp_inv.csv", "utf8");
    const cpViscText = xfoil.readFile("/work/cp_visc.csv", "utf8");
    const foilText = xfoil.readFile("/work/airfoil.dat", "utf8");
    const cpInvLines = cpInvText.trim().split(/\r?\n/).filter(Boolean);
    const cpViscLines = cpViscText.trim().split(/\r?\n/).filter(Boolean);
    const foilLines = foilText.trim().split(/\r?\n/).filter(Boolean);
    if (cpInvLines.length < 3) {
      problems.push("cp_inv.csv missing or too short");
    } else if (!/cp/i.test(cpInvLines[0])) {
      problems.push("cp_inv.csv missing header");
    }
    if (cpViscLines.length < 3) {
      problems.push("cp_visc.csv missing or too short");
    } else if (!/cp/i.test(cpViscLines[0])) {
      problems.push("cp_visc.csv missing header");
    }
    if (foilLines.length < 3) {
      problems.push("airfoil.dat missing or too short");
    }
  } catch (err) {
    problems.push("cp files or airfoil.dat not readable");
  }

  const ok = problems.length === 0;

  if (ok) {
    console.log("[smoke] PASS");
    console.log(`  alpha: ${aStr ?? "(not found)"} deg`);
    console.log(`  CL:    ${clStr ?? "(not found)"}`);
    console.log(`  CM:    ${cmStr ?? "(not found)"}`);
    console.log(`  CD:    ${cdStr ?? "(not found)"}`);
    process.exit(0);
  }

  console.error("[smoke] FAIL");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("");
  console.error("--- last 120 lines of output ---");
  console.error(tailLines(combined, 120));
  console.error("--------------------------------");
  process.exit(1);
}

main().catch((err) => {
  console.error("[smoke] FAIL");
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
