#!/usr/bin/env python3
"""ArUco camera tracker -> local /pose API. Requires pip install opencv-contrib-python numpy.
Anchors are fixed ArUco marker CENTERS measured in meters in the arena coordinate frame.
If anchors are invisible no pose updates are sent; dispatcher must stop on staleness.
"""
import json
import math
import sys
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np


def main():
    if len(sys.argv) < 2:
        raise SystemExit('Usage: python local/aruco-tracker.py tracker-private.json')
    settings = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    anchors = {int(k): np.array(v, dtype=np.float32) for k, v in settings['anchors'].items()}
    if len(anchors) < 4 or any(a.shape != (2,) for a in anchors.values()):
        raise ValueError('Need at least 4 fixed marker centers with measured (x,y) meters')
    robots = {int(r['marker_id']): r for r in settings['robots']}
    dictionary_name = settings.get('dictionary', 'DICT_4X4_50')
    dictionary = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, dictionary_name))
    params = cv2.aruco.DetectorParameters()
    detector = cv2.aruco.ArucoDetector(dictionary, params)
    cam = cv2.VideoCapture(settings.get('camera', 0))
    if not cam.isOpened():
        raise RuntimeError('Camera unavailable')
    url = settings.get('server', 'http://127.0.0.1:8766').rstrip('/')
    token = settings['trackerToken']
    last_log = 0
    try:
        while True:
            ok, frame = cam.read()
            if not ok:
                time.sleep(.1)
                continue
            corners, ids, _ = detector.detectMarkers(frame)
            if ids is None:
                continue
            detections = {}
            for marker_id, quad in zip(ids.flatten(), corners):
                detections[int(marker_id)] = np.asarray(quad, dtype=np.float32).reshape(4, 2)
            src, dst = [], []
            for marker_id, position in anchors.items():
                if marker_id in detections:
                    src.append(detections[marker_id].mean(axis=0))
                    dst.append(position)
            if len(src) < 4:
                if time.monotonic() - last_log > 3:
                    print('Less than 4 calibration markers visible; no pose updates', flush=True)
                    last_log = time.monotonic()
                continue
            homography, inliers = cv2.findHomography(np.asarray(src), np.asarray(dst), cv2.RANSAC, 0.05)
            if homography is None or inliers is None or int(inliers.sum()) < 4:
                continue
            for marker_id, robot in robots.items():
                if marker_id not in detections:
                    continue
                quad = detections[marker_id]
                # Top edge determines the heading; physically align marker with chassis or set yaw_offset_deg.
                points = np.array([quad.mean(axis=0), quad[0], quad[1]], dtype=np.float32).reshape(1, 3, 2)
                xy = cv2.perspectiveTransform(points, homography)[0]
                center, left, right = xy
                heading = math.atan2(float(right[1]-left[1]), float(right[0]-left[0]))
                heading += math.radians(float(robot.get('yaw_offset_deg', 0)))
                heading = math.atan2(math.sin(heading), math.cos(heading))
                payload = dict(x=float(center[0]), y=float(center[1]), heading=heading,
                               marker_id=marker_id, polygon_id=robot.get('polygon_id'))
                data = json.dumps(payload).encode('utf-8')
                req = urllib.request.Request(url + '/api/robots/' + robot['id'] + '/pose', data=data,
                    headers={'Authorization':'Bearer ' + token,'Content-Type':'application/json'},method='POST')
                try:
                    with urllib.request.urlopen(req,timeout=.4) as response:
                        if response.status!=200:print('Pose rejected',response.status,flush=True)
                except Exception as error:
                    if time.monotonic()-last_log>2:
                        print('Tracker upload:',str(error)[:180],flush=True)
                        last_log=time.monotonic()
    finally:
        cam.release()

if __name__ == '__main__':
    main()
