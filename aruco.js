/* Shared renderer: SVG previews and PDF use exactly the same cells. */
(function (global) {
  "use strict";
  const DEFAULT_DICTIONARY = "DICT_4X4_50";
  const LEGACY_DICTIONARY = "ARUCO_ORIGINAL";

  function maxId(dictionary) {
    if (dictionary === DEFAULT_DICTIONARY) return 49;
    if (dictionary === LEGACY_DICTIONARY) return 1023;
    throw new RangeError("Неизвестный словарь ArUco: " + dictionary);
  }

  function normalizeId(value, dictionary = DEFAULT_DICTIONARY) {
    if ((typeof value !== "string" && typeof value !== "number") ||
        String(value).trim() === "") return null;
    const id = Number(value);
    return Number.isInteger(id) && id >= 0 && id <= maxId(dictionary) ? id : null;
  }

  function matrix(value, dictionary = DEFAULT_DICTIONARY) {
    const id = normalizeId(value, dictionary);
    if (id === null) throw new RangeError("Недопустимый ID маркера");
    const dataSize = dictionary === DEFAULT_DICTIONARY ? 4 : 5;
    const size = dataSize + 4; // one black border + one white margin per side
    const cells = Array.from({ length: size }, () => Array(size).fill(1));
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) cells[y][x] = 0;
    }
    if (dictionary === DEFAULT_DICTIONARY) {
      if (typeof ARUCO_4X4_50_BYTES === "undefined" || ARUCO_4X4_50_BYTES.length !== 100) {
        throw new Error("Словарь не загружен. Запустите python generate_dict.py.");
      }
      const code = (ARUCO_4X4_50_BYTES[id * 2] << 8) | ARUCO_4X4_50_BYTES[id * 2 + 1];
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) cells[y + 2][x + 2] = (code >> (15 - y * 4 - x)) & 1;
      }
    } else {
      // Preserve the orientation and bits produced by aruco-marker@3.0.1.
      const words = [16, 23, 9, 14];
      for (let y = 0; y < 5; y++) {
        const word = words[(id >> (2 * (4 - y))) & 3];
        for (let x = 0; x < 5; x++) cells[y + 2][x + 2] = (word >> (4 - x)) & 1;
      }
    }
    return cells;
  }

  function toSVG(value, size = 320, dictionary = DEFAULT_DICTIONARY) {
    const cells = matrix(value, dictionary);
    if (!Number.isFinite(size) || size <= 0) throw new RangeError("Недопустимый размер");
    const parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + size +
      '" height="' + size + '" viewBox="0 0 ' + cells.length + ' ' + cells.length +
      '" shape-rendering="crispEdges" role="img" aria-label="ArUco ID ' + Number(value) + '">',
      '<rect width="100%" height="100%" fill="white"/>'];
    cells.forEach((row, y) => row.forEach((bit, x) => {
      if (!bit) parts.push('<rect x="' + x + '" y="' + y + '" width="1" height="1" fill="black"/>');
    }));
    parts.push('</svg>');
    return parts.join('');
  }

  global.ArucoMarker = Object.freeze({ DEFAULT_DICTIONARY, LEGACY_DICTIONARY, maxId, normalizeId, matrix, toSVG });
})(globalThis);
