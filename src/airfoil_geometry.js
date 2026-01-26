function splitAtMinX(points) {
  if (!points.length) return { upper: [], lower: [] };
  let minIndex = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].x < points[minIndex].x) minIndex = i;
  }
  return {
    upper: points.slice(0, minIndex + 1),
    lower: points.slice(minIndex),
  };
}

function ensureAscending(points) {
  if (points.length < 2) return points.slice();
  return points[0].x <= points[points.length - 1].x
    ? points.slice()
    : points.slice().reverse();
}

function cleanAirfoil(points, tol = 1e-6) {
  const cleaned = [];
  for (const p of points) {
    if (!cleaned.length) {
      cleaned.push(p);
      continue;
    }
    const last = cleaned[cleaned.length - 1];
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    if (Math.hypot(dx, dy) > tol) {
      cleaned.push(p);
    }
  }
  if (cleaned.length > 2) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    const dx = first.x - last.x;
    const dy = first.y - last.y;
    if (Math.hypot(dx, dy) < tol) {
      cleaned.pop();
    }
  }
  return cleaned;
}

function signedArea(points) {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    area += points[i].x * points[i + 1].y - points[i + 1].x * points[i].y;
  }
  return area * 0.5;
}

function getSurfaceCoords(airfoil) {
  const cleaned = cleanAirfoil(airfoil);
  const split = splitAtMinX(cleaned);
  const upper = ensureAscending(split.upper);
  const lower = ensureAscending(split.lower);
  const orientation = Math.sign(signedArea(cleaned)) || 1;
  return { upper, lower, orientation, cleaned };
}

function findSegmentAtX(points, x) {
  if (points.length < 2) return null;
  let best = { a: points[0], b: points[1], t: 0 };
  let bestDist = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const denom = b.x - a.x || 1e-9;
    if (x >= minX && x <= maxX) {
      const t = (x - a.x) / denom;
      return { a, b, t: Math.max(0, Math.min(1, t)) };
    }
    const mid = 0.5 * (a.x + b.x);
    const dist = Math.abs(x - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = { a, b, t: 0.5 };
    }
  }
  return best;
}

function surfaceAtX(points, x) {
  const seg = findSegmentAtX(points, x);
  if (!seg) return null;
  const { a, b, t } = seg;
  const y = a.y + t * (b.y - a.y);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x: a.x + t * (b.x - a.x),
    y,
    tx: dx / len,
    ty: dy / len,
  };
}

function outwardNormal(tx, ty, orientation) {
  if (orientation >= 0) {
    return { nx: ty, ny: -tx };
  }
  return { nx: -ty, ny: tx };
}

function normalAtSurface(upper, lower, x, side, orientation) {
  const points = side === "upper" ? upper : lower;
  const surf = surfaceAtX(points, x);
  if (!surf) return null;
  const normal = outwardNormal(surf.tx, surf.ty, orientation);
  let nx = normal.nx;
  let ny = normal.ny;
  if (side === "upper" && ny < 0) {
    nx *= -1;
    ny *= -1;
  }
  if (side === "lower" && ny > 0) {
    nx *= -1;
    ny *= -1;
  }
  return { x: surf.x, y: surf.y, nx, ny };
}

function normalizeVector(x, y) {
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

function estimateTeProjection(surfaces) {
  const upper = surfaces.upper;
  const lower = surfaces.lower;
  if (upper.length < 2 || lower.length < 2) {
    return { ante: 0, upperTe: null, lowerTe: null };
  }
  const upperTe = upper[upper.length - 1];
  const upperPrev = upper[upper.length - 2];
  const lowerTe = lower[lower.length - 1];
  const lowerPrev = lower[lower.length - 2];
  const upperTan = normalizeVector(upperTe.x - upperPrev.x, upperTe.y - upperPrev.y);
  const lowerTan = normalizeVector(lowerTe.x - lowerPrev.x, lowerTe.y - lowerPrev.y);
  const dxs = 0.5 * (upperTan.x + lowerTan.x);
  const dys = 0.5 * (upperTan.y + lowerTan.y);
  const dxte = upperTe.x - lowerTe.x;
  const dyte = upperTe.y - lowerTe.y;
  const ante = dxs * dyte - dys * dxte;
  return { ante, upperTe, lowerTe };
}

function computeWakeNormals(wake, lowerRefPoint) {
  const normals = [];
  if (!wake.length) return normals;
  const ref =
    lowerRefPoint && wake[0]
      ? { x: lowerRefPoint.x - wake[0].x, y: lowerRefPoint.y - wake[0].y }
      : null;
  for (let i = 0; i < wake.length; i += 1) {
    const prev = wake[Math.max(0, i - 1)];
    const next = wake[Math.min(wake.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    if (ref) {
      if (nx * ref.x + ny * ref.y < 0) {
        nx *= -1;
        ny *= -1;
      }
    } else if (ny > 0) {
      nx *= -1;
      ny *= -1;
    }
    normals.push({ nx, ny });
  }
  return normals;
}

export {
  splitAtMinX,
  ensureAscending,
  cleanAirfoil,
  signedArea,
  getSurfaceCoords,
  findSegmentAtX,
  surfaceAtX,
  outwardNormal,
  normalAtSurface,
  normalizeVector,
  estimateTeProjection,
  computeWakeNormals,
};
