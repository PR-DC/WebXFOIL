import { getSurfaceCoords, surfaceAtX } from "./airfoil_geometry.js";

class XfoilInput {
  constructor(lines = []) {
    this._lines = [];
    this._files = [];
    this._airfoilPoints = null;
    this._airfoilName = null;
    this._airfoilPath = null;
    this.addLines(lines);
  }

  add(line) {
    if (Array.isArray(line)) {
      return this.addLines(line);
    }
    if (line == null) return this;
    this._lines.push(String(line));
    return this;
  }

  addLines(lines) {
    if (!lines) return this;
    for (const line of lines) {
      this.add(line);
    }
    return this;
  }

  blank(count = 1) {
    const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 1;
    for (let i = 0; i < n; i += 1) {
      this._lines.push("");
    }
    return this;
  }

  load(path) {
    return this.add(`LOAD ${path}`);
  }

  _setFile(path, data) {
    if (!path) {
      throw new TypeError("addFile expects a file path.");
    }
    const normalized = String(path);
    const existing = this._files.findIndex((file) => file.path === normalized);
    if (existing >= 0) {
      this._files[existing] = { path: normalized, data };
    } else {
      this._files.push({ path: normalized, data });
    }
    return this;
  }

  addFile(path, data) {
    this._setFile(path, data);
    return this;
  }

  get files() {
    return this._files.slice();
  }

  loadAirfoilText(text, options = {}) {
    const parsed = parseAirfoilFile(text == null ? "" : String(text));
    if (!parsed.points.length) {
      throw new Error("No airfoil points found in the file.");
    }
    if (typeof options.onPoints === "function") {
      try {
        options.onPoints(parsed.points.slice());
      } catch (err) {
        console.warn("Failed to report airfoil points.", err);
      }
    }
    const path = options.path != null ? String(options.path) : "airfoil_input.dat";
    const name = parsed.name || options.name || "Uploaded Airfoil";
    const serialized = serializeAirfoil(name, parsed.points);
    this._airfoilPoints = parsed.points.slice();
    this._airfoilName = name;
    this._airfoilPath = path;
    this._setFile(path, serialized);
    this.load(path);
    return { name, format: parsed.format, path };
  }

  scaleAirfoil(options = {}) {
    if (!this._airfoilPoints || !this._airfoilPoints.length) {
      throw new Error("No airfoil loaded. Call loadAirfoilText first.");
    }
    const scaled = scaleAirfoil(this._airfoilPoints, options);
    const name = options.name || this._airfoilName || "Scaled Airfoil";
    const path = this._airfoilPath || options.path || "airfoil_input.dat";
    const serialized = serializeAirfoil(name, scaled.points);
    this._airfoilPoints = scaled.points.slice();
    this._airfoilName = name;
    this._airfoilPath = path;
    this._setFile(path, serialized);
    return {
      name,
      path,
      baseTc: scaled.baseTc,
      scale: scaled.scale,
      points: scaled.points.slice(),
    };
  }

  getAirfoilPoints() {
    return this._airfoilPoints ? this._airfoilPoints.slice() : [];
  }

  getAirfoilName() {
    return this._airfoilName;
  }

  getAirfoilPath() {
    return this._airfoilPath;
  }

  naca(code) {
    return this.add(`NACA ${code}`);
  }

  setDelimiter(kind) {
    if (kind == null) return this;
    if (typeof kind === "number" && Number.isFinite(kind)) {
      return this.add(`DELI ${Math.trunc(kind)}`);
    }
    const value = String(kind).toLowerCase();
    if (value === "blank" || value === "space" || value === "0") {
      return this.add("DELI 0");
    }
    if (value === "comma" || value === "csv" || value === "1") {
      return this.add("DELI 1");
    }
    if (value === "tab" || value === "tsv" || value === "2") {
      return this.add("DELI 2");
    }
    throw new TypeError("setDelimiter expects 0/1/2 or blank/comma/tab.");
  }

  oper() {
    return this.add("OPER");
  }

  setAlpha(value) {
    return this.addAlpha(value);
  }

  setAlphas(values) {
    if (!Array.isArray(values)) {
      throw new TypeError("setAlphas expects an array.");
    }
    for (const value of values) {
      this.addAlpha(value);
    }
    return this;
  }

  addAlpha(value) {
    return this.add(`A ${value}`);
  }

  // Pressure diagram commands (OPER menu)
  cpx() {
    return this.add("CPX");
  }

  cpv() {
    return this.add("CPV");
  }

  cpio() {
    return this.add("CPIO");
  }

  cref() {
    return this.add("CREF");
  }

  grid() {
    return this.add("GRID");
  }

  cpmi(value) {
    if (value == null) return this.add("CPMI");
    return this.add(`CPMI ${value}`);
  }

  cpmin() {
    return this.add("CPMN");
  }

  cpwr(path) {
    if (path == null || path === "") return this.add("CPWR");
    return this.add(`CPWR ${path}`);
  }

  quit() {
    return this.add("QUIT");
  }

  toArray() {
    return [...this._lines];
  }

  toString() {
    return this._lines.join("\n") + "\n";
  }
}

function stripComments(line) {
  if (line == null) return "";
  let cleaned = String(line);
  const hashIndex = cleaned.indexOf("#");
  if (hashIndex >= 0) cleaned = cleaned.slice(0, hashIndex);
  const slashIndex = cleaned.indexOf("//");
  if (slashIndex >= 0) cleaned = cleaned.slice(0, slashIndex);
  return cleaned;
}

function normalizeNumberToken(token) {
  if (!token) return token;
  let cleaned = token.replace(/[dD]/g, "e");
  if (cleaned.startsWith("(") && cleaned.endsWith(")")) {
    const inner = cleaned.slice(1, -1);
    cleaned = inner.startsWith("-") || inner.startsWith("+") ? inner : `-${inner}`;
  }
  return cleaned;
}

function parseNumbersFromLine(line) {
  const cleaned = stripComments(line).trim();
  if (!cleaned) return [];
  const parts = cleaned.split(/[,\s]+/);
  const values = [];
  for (const part of parts) {
    if (!part) continue;
    const normalized = normalizeNumberToken(part);
    const value = Number(normalized);
    if (Number.isFinite(value)) {
      values.push(value);
    } else if (values.length) {
      break;
    }
  }
  return values;
}

function ensureDirection(points, ascending) {
  if (points.length < 2) return points.slice();
  const isAscending = points[0].x <= points[points.length - 1].x;
  if (isAscending === ascending) return points.slice();
  return points.slice().reverse();
}

function dedupeConsecutivePoints(points, tol = 1e-9) {
  if (!points.length) return [];
  const cleaned = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const prev = cleaned[cleaned.length - 1];
    const next = points[i];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    if (Math.hypot(dx, dy) > tol) {
      cleaned.push(next);
    }
  }
  return cleaned;
}

function parseAirfoilFile(text) {
  const lines = text.split(/\r?\n/);
  let index = 0;
  const blocks = [];
  let current = [];
  let name = null;
  let counts = null;

  const nextNonEmpty = () => {
    while (index < lines.length) {
      const cleaned = stripComments(lines[index]).trim();
      index += 1;
      if (cleaned) return cleaned;
    }
    return null;
  };

  const firstLine = nextNonEmpty();
  if (firstLine == null) return { name: null, points: [], format: "unknown" };

  const firstNums = parseNumbersFromLine(firstLine);
  const firstHasLetters = /[a-z]/i.test(firstLine);
  if (firstHasLetters || firstNums.length < 2) {
    name = firstLine;
  } else {
    index -= 1;
  }

  const maybeCounts = nextNonEmpty();
  if (maybeCounts != null) {
    const countNums = parseNumbersFromLine(maybeCounts);
    const isCountsLine =
      countNums.length >= 2 &&
      Number.isInteger(countNums[0]) &&
      Number.isInteger(countNums[1]) &&
      countNums[0] >= 5 &&
      countNums[1] >= 5;
    if (isCountsLine) {
      counts = {
        upper: Math.abs(countNums[0]),
        lower: Math.abs(countNums[1]),
      };
    } else {
      index -= 1;
    }
  }

  if (counts) {
    const upper = [];
    const lower = [];
    const target = counts.upper + counts.lower;

    for (; index < lines.length && upper.length + lower.length < target; index += 1) {
      const nums = parseNumbersFromLine(lines[index]);
      if (nums.length < 2) continue;
      const point = { x: nums[0], y: nums[1] };
      if (upper.length < counts.upper) {
        upper.push(point);
      } else if (lower.length < counts.lower) {
        lower.push(point);
      }
    }

    const upperOut = ensureDirection(upper, false);
    const lowerOut = ensureDirection(lower, true);
    const points = dedupeConsecutivePoints([...upperOut, ...lowerOut]);
    return { name, points, format: "lednicer" };
  }

  for (; index < lines.length; index += 1) {
    const cleaned = stripComments(lines[index]);
    if (!cleaned || cleaned.trim() === "") {
      if (current.length) {
        blocks.push(current);
        current = [];
      }
      continue;
    }
    const nums = parseNumbersFromLine(cleaned);
    if (nums.length >= 2) {
      current.push({ x: nums[0], y: nums[1] });
    } else if (current.length) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);

  let format = "selig";
  let points = [];

  if (counts) {
    format = "lednicer";
    if (blocks.length >= 2) {
      const upper = blocks[0];
      const lower = blocks[1];
      points = [...upper.slice().reverse(), ...lower];
    } else if (blocks.length === 1) {
      const all = blocks[0];
      const upper = all.slice(0, counts.upper);
      const lower = all.slice(counts.upper, counts.upper + counts.lower);
      points = [...upper.slice().reverse(), ...lower];
    }
  } else if (blocks.length >= 2) {
    const upper = blocks[0];
    const lower = blocks[1];
    const upperInc = upper.length > 1 && upper[0].x <= upper[upper.length - 1].x;
    const lowerInc = lower.length > 1 && lower[0].x <= lower[lower.length - 1].x;
    if (upperInc && lowerInc) {
      format = "lednicer";
      points = [...upper.slice().reverse(), ...lower];
    } else {
      format = "selig";
      points = [...upper, ...lower];
    }
  } else if (blocks.length === 1) {
    points = blocks[0];
    format = "selig";
  }

  return { name, points: dedupeConsecutivePoints(points), format };
}

function sanitizeName(name) {
  if (!name) return "Uploaded Airfoil";
  const trimmed = String(name).trim();
  if (!trimmed) return "Uploaded Airfoil";
  if (/^[tf]/i.test(trimmed)) return `_${trimmed}`;
  return trimmed;
}

function serializeAirfoil(name, points) {
  const safeName = sanitizeName(name);
  const lines = [safeName];
  for (const p of points) {
    lines.push(`${p.x} ${p.y}`);
  }
  return `${lines.join("\n")}\n`;
}

function cosineSpacing(count) {
  const n = Math.max(2, Number.isFinite(count) ? Math.floor(count) : 201);
  const xs = [];
  for (let i = 0; i < n; i += 1) {
    const theta = (i * Math.PI) / (n - 1);
    xs.push(0.5 * (1 - Math.cos(theta)));
  }
  return xs;
}

function resampleSurfaces(points, sampleCount = 201) {
  const surfaces = getSurfaceCoords(points);
  const xs = cosineSpacing(sampleCount);
  const upper = [];
  const lower = [];
  for (const x of xs) {
    const u = surfaceAtX(surfaces.upper, x);
    const l = surfaceAtX(surfaces.lower, x);
    upper.push({ x, y: u ? u.y : NaN });
    lower.push({ x, y: l ? l.y : NaN });
  }
  return { upper, lower, xs };
}

function airfoilThicknessRatio(points, sampleCount = 201) {
  const { upper, lower } = resampleSurfaces(points, sampleCount);
  let maxT = 0;
  let hasValid = false;
  for (let i = 0; i < upper.length; i += 1) {
    const yu = upper[i].y;
    const yl = lower[i].y;
    if (!Number.isFinite(yu) || !Number.isFinite(yl)) continue;
    hasValid = true;
    maxT = Math.max(maxT, yu - yl);
  }
  return hasValid ? maxT : NaN;
}

function buildSeligPoints(upper, lower) {
  const upperRev = upper.slice().reverse();
  const lowerTrim = lower.slice();
  if (
    upperRev.length &&
    lowerTrim.length &&
    Math.abs(upperRev[0].x - lowerTrim[0].x) < 1e-6 &&
    Math.abs(upperRev[0].y - lowerTrim[0].y) < 1e-6
  ) {
    lowerTrim.shift();
  }
  return [...upperRev, ...lowerTrim];
}

function scaleAirfoil(points, options = {}) {
  if (!Array.isArray(points) || points.length < 5) {
    throw new Error("scaleAirfoil expects an array of points.");
  }
  const sampleCount = options.sampleCount ?? 201;
  const { upper, lower } = resampleSurfaces(points, sampleCount);
  const baseTc = airfoilThicknessRatio(points, sampleCount);
  let scale = Number.isFinite(options.scale) ? options.scale : 1;
  if (Number.isFinite(options.targetTc) && Number.isFinite(baseTc) && baseTc > 0) {
    scale = options.targetTc / baseTc;
  }

  const upperOut = [];
  const lowerOut = [];
  for (let i = 0; i < upper.length; i += 1) {
    const yu = upper[i].y;
    const yl = lower[i].y;
    if (!Number.isFinite(yu) || !Number.isFinite(yl)) continue;
    const yc = 0.5 * (yu + yl);
    const t = (yu - yl) * scale;
    upperOut.push({ x: upper[i].x, y: yc + 0.5 * t });
    lowerOut.push({ x: lower[i].x, y: yc - 0.5 * t });
  }

  if (upperOut.length < 5 || lowerOut.length < 5) {
    return { points: points.slice(), upper: upper.slice(), lower: lower.slice(), baseTc, scale };
  }

  return {
    points: buildSeligPoints(upperOut, lowerOut),
    upper: upperOut,
    lower: lowerOut,
    baseTc,
    scale,
  };
}

export { XfoilInput };
