"""Verify actual browser screenshots and the vector marker layer of exported PDFs.

This intentionally handles the grayscale rectangles emitted by our exporter;
it is not a general PDF renderer. No optional PDF packages are required.
"""
from pathlib import Path
import re

import cv2
import numpy as np

OUTPUT = Path(__file__).resolve().parent / "test-output"
SMALL = cv2.aruco.ArucoDetector(
    cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50), cv2.aruco.DetectorParameters())
ORIGINAL = cv2.aruco.ArucoDetector(
    cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_ARUCO_ORIGINAL), cv2.aruco.DetectorParameters())


def detect(detector, image):
    _, ids, _ = detector.detectMarkers(image)
    return sorted(ids.flatten().tolist()) if ids is not None else []


def rasterize_marker_layer(pdf):
    source = pdf.read_bytes().decode("latin1")
    media = re.search(r"/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]", source)
    assert media, "Missing PDF page dimensions"
    width, height = map(float, media.groups())
    number = r"-?(?:\d+(?:\.\d*)?|\.\d+)"
    operations = re.compile(
        rf"(?P<gray>{number}) g|(?P<rect>{number} {number} {number} {number}) re\s+f\b")
    for stream in re.findall(r"stream\r?\n(.*?)\r?\nendstream", source, re.S):
        scale = 2
        image = np.full((round(height * scale), round(width * scale)), 255, dtype=np.uint8)
        gray = 0
        for operation in operations.finditer(stream):
            if operation['gray'] is not None:
                gray = round(float(operation['gray']) * 255)
                continue
            x, y, w, h = map(float, operation['rect'].split())
            assert 0 <= x <= x + w <= width + 0.01, "PDF rectangle overflows horizontally"
            assert 0 <= y + h <= y <= height, "PDF rectangle overflows vertically"
            x0, x1 = round(x * scale), round((x + w) * scale)
            y0, y1 = round((height - y) * scale), round((height - y - h) * scale)
            image[y0:y1, x0:x1] = gray
        yield image


def main():
    for name, marker_id in [("browser-marker-0.png", 0), ("browser-marker-49.png", 49),
                            ("browser-mobile-marker-7.png", 7)]:
        image = cv2.imdecode(np.fromfile(OUTPUT / name, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
        assert detect(SMALL, image) == [marker_id], f"Invalid browser screenshot {name}"
    pages = list(rasterize_marker_layer(OUTPUT / "all-50-markers.pdf"))
    assert len(pages) == 9
    found = []
    for page_number, image in enumerate(pages):
        expected = list(range(page_number * 6, min(page_number * 6 + 6, 50)))
        ids = detect(SMALL, image)
        assert ids == expected, f"PDF page {page_number + 1}: {ids}, expected {expected}"
        corners, _, _ = SMALL.detectMarkers(image)
        centers = [box[0].mean(axis=0) for box in corners]
        assert len({round(float(center[0]) / 10) for center in centers}) == 2, "Expected two columns"
        assert len({round(float(center[1]) / 10) for center in centers}) == min(3, (len(ids) + 1) // 2), "Unexpected PDF rows"
        for box in corners:
            assert np.linalg.norm(box[0][1] - box[0][0]) > 370, "PDF markers were not enlarged"
        found.extend(ids)
    assert found == list(range(50))
    mixed = list(rasterize_marker_layer(OUTPUT / "mixed-markers.pdf"))
    assert len(mixed) == 1
    assert detect(SMALL, mixed[0]) == [49]
    assert detect(ORIGINAL, mixed[0]) == [1023]
    print("PASS: OpenCV detects browser previews (desktop/mobile) and all 50 exported PDF markers on the correct pages; mixed 4x4/5x5 PDF also matches.")


if __name__ == "__main__":
    main()
