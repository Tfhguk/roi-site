#!/usr/bin/env python3
"""ArUco camera tracker -> local /pose API.
Автоматически берёт координаты угловых ArUco-маркеров полигона с robot-server.cjs (/api/arena/<polygon_id>),
либо использует статические anchors из tracker-private.json.
"""
import json
import math
import sys
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np


def fetch_arena_anchors(server_url: str, token: str, polygon_id: str) -> dict:
    req = urllib.request.Request(
        f"{server_url}/api/arena/{urllib.request.quote(polygon_id)}",
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=2.0) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    raw = data.get("anchors") or {}
    return {int(k): np.array(v, dtype=np.float32) for k, v in raw.items()}


def main():
    if len(sys.argv) < 2:
        raise SystemExit('Usage: python local/aruco-tracker.py tracker-private.json')
    settings = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    url = settings.get('server', 'http://127.0.0.1:8766').rstrip('/')
    token = settings['trackerToken']
    robots = {int(r['marker_id']): r for r in settings['robots']}
    polygon_id = next((r.get('polygon_id') for r in settings['robots'] if r.get('polygon_id')), None)

    static_anchors = {int(k): np.array(v, dtype=np.float32) for k, v in (settings.get('anchors') or {}).items()}
    anchors = dict(static_anchors)

    dictionary_name = settings.get('dictionary', 'DICT_4X4_50')
    dictionary = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, dictionary_name))
    params = cv2.aruco.DetectorParameters()
    detector = cv2.aruco.ArucoDetector(dictionary, params)

    cam = cv2.VideoCapture(settings.get('camera', 0))
    if not cam.isOpened():
        raise RuntimeError('Camera unavailable')

    last_log = 0.0
    last_arena_sync = 0.0
    try:
        while True:
            if not static_anchors and polygon_id and (len(anchors) < 4 or time.monotonic() - last_arena_sync > 5.0):
                try:
                    fetched = fetch_arena_anchors(url, token, polygon_id)
                    if len(fetched) >= 4:
                        if set(fetched.keys()) != set(anchors.keys()):
                            print(f"Loaded {len(fetched)} polygon anchors from server: IDs {sorted(fetched.keys())}", flush=True)
                        anchors = fetched
                    elif time.monotonic() - last_log > 3.0:
                        print(f"Waiting for >=4 polygon corner ArUco markers on server (got {len(fetched)})...", flush=True)
                        last_log = time.monotonic()
                except Exception as err:
                    if time.monotonic() - last_log > 3.0:
                        print("Waiting for arena config from server:", str(err)[:160], flush=True)
                        last_log = time.monotonic()
                last_arena_sync = time.monotonic()

            ok, frame = cam.read()
            if not ok:
                time.sleep(0.05)
                continue

            if len(anchors) < 4:
                time.sleep(0.2)
                continue

            corners, ids, _ = detector.detectMarkers(frame)
            if ids is None:
                continue

            detections = {
                int(marker_id): np.asarray(quad, dtype=np.float32).reshape(4, 2)
                for marker_id, quad in zip(ids.flatten(), corners)
            }

            src, dst = [], []
            for marker_id, position in anchors.items():
                if marker_id in detections:
                    src.append(detections[marker_id].mean(axis=0))
                    dst.append(position)

            if len(src) < 4:
                if time.monotonic() - last_log > 3.0:
                    visible = sorted(set(detections.keys()) & set(anchors.keys()))
                    print(f"Less than 4 polygon markers visible (visible: {visible}, need: {sorted(anchors.keys())})", flush=True)
                    last_log = time.monotonic()
                continue

            homography, inliers = cv2.findHomography(np.asarray(src), np.asarray(dst), cv2.RANSAC, 0.05)
            if homography is None or inliers is None or int(inliers.sum()) < 4:
                continue

            for marker_id, robot in robots.items():
                if marker_id not in detections:
                    continue
                quad = detections[marker_id]
                points = np.array([quad.mean(axis=0), quad[0], quad[1]], dtype=np.float32).reshape(1, 3, 2)
                xy = cv2.perspectiveTransform(points, homography)[0]
                center, left, right = xy
                heading = math.atan2(float(right[1] - left[1]), float(right[0] - left[0]))
                heading += math.radians(float(robot.get('yaw_offset_deg', 0)))
                heading = math.atan2(math.sin(heading), math.cos(heading))

                payload = dict(
                    x=float(center[0]),
                    y=float(center[1]),
                    heading=heading,
                    marker_id=marker_id,
                    polygon_id=robot.get('polygon_id'),
                )
                data = json.dumps(payload).encode('utf-8')
                req = urllib.request.Request(
                    url + '/api/robots/' + robot['id'] + '/pose',
                    data=data,
                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
                    method='POST',
                )
                try:
                    with urllib.request.urlopen(req, timeout=0.4) as response:
                        if response.status != 200:
                            print('Pose rejected', response.status, flush=True)
                except Exception as error:
                    if time.monotonic() - last_log > 2.0:
                        print('Tracker upload:', str(error)[:180], flush=True)
                        last_log = time.monotonic()
    finally:
        cam.release()


if __name__ == '__main__':
    main()
