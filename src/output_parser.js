function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toNumberOrNaN(s) {
  const norm = String(s).trim().replace(/[dD]/g, "e");
  const n = Number(norm);
  return Number.isFinite(n) ? n : NaN;
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

function parseFloatToken(token) {
  const value = Number(normalizeNumberToken(token));
  return Number.isFinite(value) ? value : null;
}

function extractLastScalar(text, key) {
  const safeKey = escapeRegExp(key);
  const re = new RegExp(
    `${safeKey}\\s*=\\s*(NaN|[+\\-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eEdD][+\\-]?\\d+)?)`,
    "gi"
  );
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) {
    last = m[1];
  }
  return last;
}

function parseCsvPairs(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/[,\s]+/);
    if (parts.length < 2) continue;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    rows.push({ x, y });
  }
  return rows;
}

function parseAirfoil(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/[,\s]+/);
    if (parts.length < 2) continue;
    const x = parseFloatToken(parts[0]);
    const y = parseFloatToken(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    rows.push({ x, y });
  }
  return rows;
}

function parseBlDump(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/[,\s]+/);
    if (parts.length < 6) continue;
    const s = parseFloatToken(parts[0]);
    const x = parseFloatToken(parts[1]);
    const y = parseFloatToken(parts[2]);
    const ue = parseFloatToken(parts[3]);
    const dstar = parseFloatToken(parts[4]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(ue)) continue;
    rows.push({
      s: Number.isFinite(s) ? s : null,
      x,
      y,
      ue,
      dstar: Number.isFinite(dstar) ? dstar : 0,
    });
  }
  return rows;
}

function parsePolarLastRow(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  let columns = null;
  let lastRow = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const normalized = tokens.map((token) => token.toLowerCase());
    if (normalized.includes("alpha") && normalized.includes("cl")) {
      columns = normalized;
      lastRow = null;
      continue;
    }
    if (!columns || tokens.length < columns.length) continue;

    const values = [];
    let numeric = true;
    for (let i = 0; i < columns.length; i += 1) {
      const value = parseFloatToken(tokens[i]);
      if (!Number.isFinite(value)) {
        numeric = false;
        break;
      }
      values.push(value);
    }
    if (numeric) {
      lastRow = values;
    }
  }

  if (!columns || !lastRow) return null;
  const result = {};
  for (let i = 0; i < columns.length; i += 1) {
    result[columns[i]] = lastRow[i];
  }
  return result;
}

function parsePolarRows(text) {
  const rows = [];
  if (!text) return rows;
  const lines = text.split(/\r?\n/);
  let columns = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const normalized = tokens.map((token) => token.toLowerCase());
    if (normalized.includes("alpha") && normalized.includes("cl")) {
      columns = normalized;
      continue;
    }
    if (!columns || tokens.length < columns.length) continue;

    const values = [];
    let numeric = true;
    for (let i = 0; i < columns.length; i += 1) {
      const value = parseFloatToken(tokens[i]);
      if (!Number.isFinite(value)) {
        numeric = false;
        break;
      }
      values.push(value);
    }
    if (!numeric) continue;

    const row = {};
    for (let i = 0; i < columns.length; i += 1) {
      row[columns[i]] = values[i];
    }
    rows.push(row);
  }
  return rows;
}

function mapScalarKeyToPolar(key) {
  if (!key) return null;
  const norm = String(key).trim().toLowerCase();
  if (!norm) return null;
  if (norm === "a" || norm === "alfa") return "alpha";
  if (norm === "alpha") return "alpha";
  if (norm === "cl") return "cl";
  if (norm === "cd") return "cd";
  if (norm === "cdp") return "cdp";
  if (norm === "cm") return "cm";
  return norm;
}

function parseXfoilOutput(rawResult, options = {}) {
  const stdout = rawResult && rawResult.stdout ? String(rawResult.stdout) : "";
  const stderr = rawResult && rawResult.stderr ? String(rawResult.stderr) : "";
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  const text = combined
    ? combined.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd()
    : "";
  const lines = text ? text.split("\n") : [];

  const hasNaN = /\bnan\b/i.test(text);
  const hasFortranError = /(fatal Fortran runtime error|Aborted\(\)|RuntimeError:)/i.test(
    text
  );
  const hasConvergenceFail = /VISCAL:\s*Convergence failed/i.test(text);

  const scalarKeys = Array.isArray(options.scalarKeys)
    ? options.scalarKeys
    : [];
  const scalars = {};
  for (const key of scalarKeys) {
    const raw = extractLastScalar(text, key);
    scalars[key] = {
      raw,
      value: raw == null ? NaN : toNumberOrNaN(raw),
    };
  }

  if (scalarKeys.length) {
    const needsFallback = scalarKeys.some((key) => !Number.isFinite(scalars[key]?.value));
    if (needsFallback) {
      const polarLast = parsePolarLastRow(text);
      if (polarLast) {
        for (const key of scalarKeys) {
          if (Number.isFinite(scalars[key]?.value)) continue;
          const polarKey = mapScalarKeyToPolar(key);
          if (!polarKey) continue;
          const polarValue = polarLast[polarKey];
          if (Number.isFinite(polarValue)) {
            scalars[key] = {
              raw: String(polarValue),
              value: polarValue,
            };
          }
        }
      }
    }
  }

  return {
    text,
    lines,
    scalars,
    hasNaN,
    hasFortranError,
    hasConvergenceFail,
  };
}

export {
  parseXfoilOutput,
  parseCsvPairs,
  parsePolarLastRow,
  parsePolarRows,
  normalizeNumberToken,
  parseFloatToken,
  parseAirfoil,
  parseBlDump,
};
