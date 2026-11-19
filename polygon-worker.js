"use strict";
importScripts("node_modules/js-aruco2/src/cv.js", "node_modules/js-aruco2/src/aruco.js",
  "aruco_dict_4x4_50.js", "aruco.js", "marker-detection.js");
self.onmessage = function (event) {
  const { requestId, dictionary, width, height, buffer } = event.data;
  try {
    const markers = MarkerDetection.getDetector(dictionary).detect({
      width, height, data: new Uint8ClampedArray(buffer)
    });
    self.postMessage({ requestId, markers: markers.map(marker => ({
      id: marker.id, corners: marker.corners
    })) });
  } catch (error) {
    self.postMessage({ requestId, error: String(error.message || error) });
  }
};
