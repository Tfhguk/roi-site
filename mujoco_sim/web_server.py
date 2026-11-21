"""Serve the existing truck interface with a local MuJoCo renderer/solver."""
import argparse
import base64
from concurrent.futures import Future
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
from queue import Queue
import threading
import socket
import webbrowser

import mujoco
import numpy as np
from PIL import Image

from simulate import Planner, Simulation, ROOT


class Engine:
    # All physics and OpenGL operations belong to one worker thread.
    def __init__(self):
        self.jobs = Queue()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def call(self, message):
        future = Future()
        self.jobs.put((message, future))
        return future.result(timeout=90)

    def run(self):
        self.planner = self.sim = self.renderer = None
        self.session = None
        self.distance = 0.
        self.follow = False
        self.azimuth, self.elevation, self.zoom = 90., -55., 1.
        self.depth = True
        try:
            while True:
                message, future = self.jobs.get()
                try:
                    if message["op"] == "shutdown":
                        future.set_result({})
                        break
                    future.set_result(self.command(message))
                except Exception as exc:
                    future.set_exception(exc)
        finally:
            if self.renderer:
                self.renderer.close()
            if self.planner:
                self.planner.close()

    def command(self, m):
        op = m["op"]
        if op == "configure":
            planner = Planner(config=m["config"], source=m["source"], route=m["route"])
            try:
                sim = Simulation(planner)
                sim.reset(autostart=False)
            except Exception:
                planner.close()
                raise
            if self.renderer:
                self.renderer.close()
                self.renderer = None
            # Close the old GL resources before creating a new context. Freeing
            # the old renderer while the new context is current can erase its
            # resources and leave a black image after reset/settings changes.
            renderer = mujoco.Renderer(sim.model, height=600, width=960)
            if self.planner:
                self.planner.close()
            self.sim, self.planner, self.renderer = sim, planner, renderer
            self.session, self.distance = m["session"], 0.
        elif not self.sim or m.get("session") != self.session:
            raise ValueError("Simulation session changed; retry after reset")
        elif op == "start":
            if self.sim.stage == "idle":
                self.sim.transition("loading" if self.sim.scene["route"].get("fromKind", "mining") == "mining" else "driving")
        elif op == "stop":
            self.sim.transition("stopping")
        elif op == "advance":
            seconds = float(m.get("seconds", 0))
            if not np.isfinite(seconds) or not 0 <= seconds <= 1:
                raise ValueError("Invalid simulation timestep")
            for _ in range(round(seconds/self.sim.model.opt.timestep)):
                before = self.sim.xy.copy()
                self.sim.step()
                self.distance += float(np.linalg.norm(self.sim.xy-before))
                if self.sim.stage in {"error", "idle", "stopped"}:
                    break
        elif op == "camera":
            self.follow = bool(m.get("follow", self.follow))
            self.azimuth = float(m.get("azimuth", self.azimuth)) % 360
            self.elevation = float(np.clip(m.get("elevation", self.elevation), -89, -10))
            self.zoom = float(np.clip(m.get("zoom", self.zoom), .2, 4))
        elif op == "depth":
            self.depth = bool(m["visible"])
        elif op != "state":
            raise ValueError("Unknown command")
        return self.snapshot()

    def snapshot(self):
        s = self.sim
        points = np.array([[p["x"], p["y"]] for p in s.scene["source"]["boundary"]])*s.config["metresPerUnit"]
        cam = mujoco.MjvCamera()
        cam.lookat[:] = [*s.xy, .08] if self.follow else [*points.mean(axis=0), 0]
        cam.distance = (.9 if self.follow else max(np.ptp(points, axis=0))*1.2)*self.zoom
        cam.azimuth, cam.elevation = self.azimuth, self.elevation
        for i, value in enumerate(s.scene["source"]["depth"]["cells"]):
            if value is not None:
                s.model.geom(f"cell_{i}").rgba[3] = 1 if self.depth else 0
        self.renderer.update_scene(s.data, camera=cam)
        s.draw_path(self.renderer.scene)
        output = BytesIO()
        Image.fromarray(self.renderer.render()).save(output, format="JPEG", quality=85)
        yaw = float(s.data.qpos[s.q["yaw"]])
        velocity = np.array([s.data.qvel[s.d["x"]], s.data.qvel[s.d["y"]]])
        v = float(velocity @ [np.cos(yaw), np.sin(yaw)])
        omega = float(s.data.qvel[s.d["yaw"]])
        station_stage = {"docking": "align", "connecting": "dock", "charging": "charge", "disconnecting": "undock"}.get(s.stage)
        stage = "station" if station_stage else {"unloading": "raising", "driving": "driving"}.get(s.stage, s.stage)
        return dict(image=base64.b64encode(output.getvalue()).decode("ascii"),
            state=dict(engine="MuJoCo", synthetic=True, stage=stage, active=s.stage not in {"idle", "stopped", "error"},
                time=float(s.data.time), x=float(s.xy[0]), y=float(s.xy[1]), psi=yaw, v=v,
                distance=self.distance, soc=s.soc, payload=s.payload, theta=float(s.data.qpos[s.model.joint("tip").qposadr[0]]),
                current=s.current, voltage=s.voltage, deliveries=s.deliveries, error=s.error, pathRole=s.path_role,
                workGoal={"kind":s.goal}, wL=(v-omega*s.config["trackWidth"]/2)/s.config["k"],
                wR=(v+omega*s.config["trackWidth"]/2)/s.config["k"],
                points=[dict(x=float(p[0]), y=float(p[1])) for p in s.path],
                physicalPosition=s.data.xpos[s.model.body("truck").id].tolist(),
                history=s.history, station={"stage":station_stage} if station_stage else None))


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/api/mujoco":
            self.send_error(404)
            return
        # A remote web page must not be able to operate this local simulator.
        if self.headers.get("Origin") not in {None, f"http://{self.headers.get('Host')}"}:
            self.send_error(403)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > 2_000_000:
                raise ValueError("Request too large")
            message = json.loads(self.rfile.read(length))
            result = self.server.engine.call(message)
            data = json.dumps(result).encode()
            self.send_response(200)
        except Exception as exc:
            data = json.dumps({"error": str(exc)}).encode()
            self.send_response(400)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in {"/", "/truck.html"}:
            self.send_response(302)
            self.send_header("Location", "/truck.html?mujoco=1")
            self.end_headers()
            return
        name = self.path.split("?", 1)[0].lstrip("/") or "truck.html"
        # Serve only public build artifacts; never .lan-tls, source or credentials.
        file = (ROOT/"dist"/name).resolve()
        if not file.is_relative_to((ROOT/"dist").resolve()) or not file.is_file():
            self.send_error(404)
            return
        mime = {".js":"text/javascript", ".css":"text/css", ".html":"text/html", ".png":"image/png"}
        data = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime.get(file.suffix, "application/octet-stream")+"; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


class LocalServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    server = LocalServer(("127.0.0.1", args.port), Handler)
    server.engine = Engine()
    url = f"http://127.0.0.1:{server.server_port}/truck.html?mujoco=1"
    print("MuJoCo interface: "+url, flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.engine.call({"op":"shutdown"})


if __name__ == "__main__":
    main()
