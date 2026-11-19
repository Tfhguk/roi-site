"""Cross-check the shipped JavaScript/SVG/PNG against OpenCV, without writing files."""
import json
from pathlib import Path
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET

import cv2
import numpy as np

sys.dont_write_bytecode = True
from generate_dict import build_javascript, get_dictionary

ROOT = Path(__file__).resolve().parent


class MarkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
for (const name of ['aruco_dict_4x4_50.js', 'aruco.js']) {
  vm.runInThisContext(fs.readFileSync(name, 'utf8'), {filename: name});
}
for (const value of ['', ' ', null, undefined, true, [], {}, -1, 50, 1.2, Infinity, NaN]) {
  assert.equal(ArucoMarker.normalizeId(value), null);
}
assert.equal(ArucoMarker.normalizeId('0'), 0);
assert.equal(ArucoMarker.normalizeId('49'), 49);
assert.equal(ArucoMarker.normalizeId(1023, 'ARUCO_ORIGINAL'), 1023);
assert.equal(ArucoMarker.normalizeId(1024, 'ARUCO_ORIGINAL'), null);
assert.throws(() => ArucoMarker.matrix(50));
assert.throws(() => ArucoMarker.matrix(0, 'unknown'));
for (const file of ['login.html', 'welcome.html', 'markers.html', 'polygon.html']) {
  const html = fs.readFileSync(file, 'utf8');
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    new vm.Script(script[1], {filename: file});
  }
  for (const script of html.matchAll(/<script src="([^"]+)"/g)) {
    assert(!script[1].startsWith('http'));
    assert(fs.existsSync(script[1]), script[1]);
  }
}
const store = new Map();
const context = vm.createContext({localStorage: {getItem: key => store.get(key) || null}});
vm.runInContext(fs.readFileSync('auth.js', 'utf8'), context);
for (const invalid of ['null', '[]', 'true', '{}', 'broken']) {
  store.set('app_users_v1', invalid);
  assert.equal(Object.keys(context.AppAuth.loadUsers()).length, 0);
  assert.equal(context.AppAuth.loadSession(), null);
}
store.set('app_users_v1', JSON.stringify({constructor: {name: null, role: 'operator', passHash: 'a'.repeat(64)}}));
store.set('app_session_v1', JSON.stringify({login: 'constructor', role: 'admin'}));
assert.equal(context.AppAuth.loadSession().name, 'constructor');
assert.equal(context.AppAuth.loadSession().role, 'operator');
store.set('app_session_v1', JSON.stringify({login: 'toString'}));
assert.equal(context.AppAuth.loadSession(), null);
console.log(JSON.stringify({
  small: Array.from({length:50}, (_, id) => ({cells: ArucoMarker.matrix(id), svg: ArucoMarker.toSVG(id)})),
  original: Array.from({length:1024}, (_, id) => ArucoMarker.matrix(id, 'ARUCO_ORIGINAL'))
}));
"""
        result = subprocess.run(['node', '-e', source], cwd=ROOT, check=True,
                                text=True, encoding='utf-8', capture_output=True)
        cls.markers = json.loads(result.stdout)

    def test_dictionary_is_current(self):
        self.assertEqual((ROOT / 'aruco_dict_4x4_50.js').read_text(encoding='utf-8'), build_javascript())

    def test_all_50_javascript_markers_match_opencv(self):
        for marker_id, marker in enumerate(self.markers['small']):
            actual = np.array(marker['cells'], dtype=np.uint8) * 255
            expected = cv2.aruco.generateImageMarker(get_dictionary(), marker_id, 6)
            np.testing.assert_array_equal(actual[1:-1, 1:-1], expected, err_msg=f'ID {marker_id}')
            self.assertTrue(np.all(actual[[0, -1]] == 255))
            self.assertTrue(np.all(actual[:, [0, -1]] == 255))

    def test_actual_svg_cells_match_opencv(self):
        ns = {'s': 'http://www.w3.org/2000/svg'}
        for marker in self.markers['small']:
            svg = ET.fromstring(marker['svg'])
            self.assertEqual(svg.attrib['viewBox'], '0 0 8 8')
            cells = np.ones((8, 8), dtype=np.uint8)
            for rect in svg.findall('s:rect', ns):
                if rect.attrib['fill'] == 'black':
                    x, y = int(rect.attrib['x']), int(rect.attrib['y'])
                    cells[y, x] = 0
            np.testing.assert_array_equal(cells, marker['cells'])

    def test_all_50_detected_at_all_four_rotations(self):
        detector = cv2.aruco.ArucoDetector(get_dictionary(), cv2.aruco.DetectorParameters())
        for marker_id, marker in enumerate(self.markers['small']):
            image = np.repeat(np.repeat(np.array(marker['cells'], dtype=np.uint8) * 255,
                                       40, axis=0), 40, axis=1)
            for rotation in range(4):
                _, ids, _ = detector.detectMarkers(np.rot90(image, rotation).copy())
                self.assertIsNotNone(ids, f'ID {marker_id}, rotation {rotation}')
                self.assertEqual(ids.flatten().tolist(), [marker_id])

    def test_all_1024_legacy_markers_preserved(self):
        dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_ARUCO_ORIGINAL)
        for marker_id, cells in enumerate(self.markers['original']):
            expected = cv2.aruco.generateImageMarker(dictionary, marker_id, 7)
            np.testing.assert_array_equal(np.array(cells, dtype=np.uint8)[1:-1, 1:-1] * 255,
                                          expected, err_msg=f'Legacy ID {marker_id}')

    def test_saved_python_previews_are_detectable(self):
        detector = cv2.aruco.ArucoDetector(get_dictionary(), cv2.aruco.DetectorParameters())
        for marker_id in [0, 1, 2, 3, 4, 5, 10, 49]:
            path = ROOT / 'preview' / f'id_{marker_id}.png'
            image = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
            self.assertIsNotNone(image)
            expected = cv2.aruco.generateImageMarker(get_dictionary(), marker_id, 360)
            np.testing.assert_array_equal(image[60:-60, 60:-60], expected)
            _, ids, _ = detector.detectMarkers(image)
            self.assertIsNotNone(ids)
            self.assertEqual(ids.flatten().tolist(), [marker_id])


if __name__ == '__main__':
    unittest.main(verbosity=2)
