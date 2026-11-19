/* Adapter shared by the worker and detection tests. Codes match our generator. */
(function (global) {
  "use strict";
  const detectors = new Map();
  function getDetector(dictionary) {
    if (detectors.has(dictionary)) return detectors.get(dictionary);
    const maximum = ArucoMarker.maxId(dictionary);
    const size = dictionary === ArucoMarker.DEFAULT_DICTIONARY ? 4 : 5;
    const codeList = Array.from({ length: maximum + 1 }, (_, id) => {
      const cells = ArucoMarker.matrix(id, dictionary);
      let code = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) code = code * 2 + cells[y + 2][x + 2];
      }
      return code;
    });
    AR.DICTIONARIES[dictionary] = { nBits: size * size, tau: 1, codeList };
    // Exact decoding: do not turn an unrelated nearby pattern into a vertex.
    const detector = new AR.Detector({ dictionaryName: dictionary, maxHammingDistance: 1 });
    const findMarkers = detector.findMarkers;
    detector.findMarkers = function (image, candidates) {
      return findMarkers.call(this, image, candidates, (size + 2) * 12);
    };
    detectors.set(dictionary, detector);
    return detector;
  }
  global.MarkerDetection = Object.freeze({ getDetector });
})(globalThis);
