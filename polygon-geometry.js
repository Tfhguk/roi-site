(function (global) {
  "use strict";
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  function markerCenter(corners) {
    // The diagonal intersection is the projected centre even under perspective.
    const [a, b, c, d] = corners;
    const denominator = (c.x - a.x) * (d.y - b.y) - (c.y - a.y) * (d.x - b.x);
    if (Math.abs(denominator) < 1e-8) throw new Error("Вырожденный арукомаркер");
    const t = ((b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x)) / denominator;
    return { x: a.x + t * (c.x - a.x), y: a.y + t * (c.y - a.y) };
  }
  function onSegment(a, b, p) {
    return Math.abs(cross(a, b, p)) < 1e-6 &&
      p.x >= Math.min(a.x, b.x) - 1e-6 && p.x <= Math.max(a.x, b.x) + 1e-6 &&
      p.y >= Math.min(a.y, b.y) - 1e-6 && p.y <= Math.max(a.y, b.y) + 1e-6;
  }
  function intersects(a, b, c, d) {
    return (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
      onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
  }
  function area(points) {
    return Math.abs(points.reduce((sum, p, i) => {
      const q = points[(i + 1) % points.length];
      return sum + p.x * q.y - q.x * p.y;
    }, 0)) / 2;
  }
  function isSimple(points, closed = true) {
    const n = points.length;
    const edges = closed ? n : n - 1;
    for (let i = 0; i < edges; i++) {
      for (let j = i + 1; j < edges; j++) {
        if (j === i + 1 || (closed && i === 0 && j === edges - 1)) continue;
        if (intersects(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return false;
      }
    }
    // Reject an edge that folds back over the previous edge.
    for (let i = 0; i < (closed ? n : n - 2); i++) {
      const a = points[i], b = points[(i + 1) % n], c = points[(i + 2) % n];
      if (Math.abs(cross(a, b, c)) < 1e-6 &&
          ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) <= 0) return false;
    }
    return !closed || (n >= 3 && area(points) > 1);
  }
  function repairOrder(points) {
    if (points.length < 3 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) < 1e-6) return null;
      }
    }
    const ordered = points.slice();
    if (isSimple(ordered)) return ordered;
    const n = ordered.length;
    // Uncross intersecting edges by reversing the path between them. Preserve
    // every marker (including concave vertices) and keep the first vertex fixed.
    for (let pass = 0; pass < n * n; pass++) {
      let changed = false;
      for (let i = 0; i < n && !changed; i++) {
        for (let j = i + 2; j < n; j++) {
          if (i === 0 && j === n - 1) continue;
          const a = ordered[i], b = ordered[i + 1], c = ordered[j], d = ordered[(j + 1) % n];
          if (!intersects(a, b, c, d)) continue;
          const before = Math.hypot(a.x - b.x, a.y - b.y) + Math.hypot(c.x - d.x, c.y - d.y);
          const after = Math.hypot(a.x - c.x, a.y - c.y) + Math.hypot(b.x - d.x, b.y - d.y);
          if (before - after <= 1e-6) continue;
          ordered.splice(i + 1, j - i, ...ordered.slice(i + 1, j + 1).reverse());
          changed = true;
          break;
        }
      }
      if (!changed) break;
    }
    if (isSimple(ordered)) return ordered;
    // Handle collinear overlaps that cannot be shortened by reversing edges.
    const centre = points.reduce((sum, p) => ({ x: sum.x + p.x / n, y: sum.y + p.y / n }), { x: 0, y: 0 });
    ordered.sort((a, b) => Math.atan2(a.y - centre.y, a.x - centre.x) - Math.atan2(b.y - centre.y, b.x - centre.x) ||
      Math.hypot(a.x - centre.x, a.y - centre.y) - Math.hypot(b.x - centre.x, b.y - centre.y));
    const first = ordered.indexOf(points[0]);
    const result = [...ordered.slice(first), ...ordered.slice(0, first)];
    return isSimple(result) ? result : null;
  }
  global.PolygonGeometry = Object.freeze({ markerCenter, isSimple, area, repairOrder });
})(globalThis);
