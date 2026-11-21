"""MuJoCo test stand. Metric terrain and simplified track supports, not a CAD twin."""
from __future__ import annotations

import argparse
from contextlib import nullcontext
import json
import math
from pathlib import Path
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET

import mujoco
import numpy as np
from terrain import Terrain

ROOT = Path(__file__).resolve().parents[1]


class Planner:
    def __init__(self, workspace=None, config=None, source=None, route=None):
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Install Node.js to use the existing polygon/depth planner")
        self.process = subprocess.Popen(
            [node, str(Path(__file__).with_name("navigation.cjs"))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8",
            cwd=ROOT,
        )
        try:
            self.scene = self.ask(op="init", workspace=str(Path(workspace).resolve()) if workspace else None, config=config or {}, source=source, route=route)
        except Exception:
            self.close()
            raise

    def ask(self, **message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()
        answer = self.process.stdout.readline()
        if not answer:
            raise RuntimeError("Navigation process stopped")
        reply = json.loads(answer)
        if not reply["ok"]:
            raise RuntimeError(reply["error"])
        return reply["result"]

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        self.process.wait(timeout=5)


def add(parent, tag, **attrs):
    return ET.SubElement(parent, tag, {k: str(v) for k, v in attrs.items()})


def scene_xml(scene):
    c = scene["config"]
    scale = c["metresPerUnit"]
    terrain=Terrain(scene)
    root = ET.Element("mujoco", model="ROI truck and charging station test stand")
    add(root, "compiler", angle="radian", autolimits="true")
    add(root, "option", timestep="0.002", integrator="implicitfast", gravity="0 0 -9.81")
    visual = add(root, "visual")
    add(visual, "global", offwidth="1280", offheight="800")
    default = add(root, "default")
    add(default, "geom", friction="0.7 0.005 0.0001", solref="0.01 1")
    assets=add(root,'asset')
    # XML elevation rows run from +Y to -Y; the workspace map runs from -Y to +Y.
    add(assets,'hfield',name='elevation',nrow=terrain.map['rows'],ncol=terrain.map['cols'],size=f'{terrain.width/2} {terrain.length/2} {max(.001,terrain.maximum-terrain.minimum)} .1',elevation=' '.join(str(v) for v in np.flipud(terrain.values).ravel()))
    add(assets,'texture',name='height_color',type='2d',file='elevation.png')
    add(assets,'material',name='height_material',texture='height_color',texuniform='false')
    world = add(root, "worldbody")
    add(world, "light", pos="3 2 8", dir="0 0 -1", diffuse="0.9 0.9 0.9")
    add(world, "geom", name="floor", type="plane", size="12 12 .1", rgba=".12 .16 .21 1",contype='0',conaffinity='0')
    add(world,'geom',name='terrain',type='hfield',hfield='elevation',pos=f'{terrain.width/2} {terrain.length/2} {terrain.minimum}',material='height_material',rgba='1 1 1 1',friction='.002 .001 .0001')
    depth = scene["source"]["depth"]
    cw, ch = 1000 * scale / depth["cols"], 700 * scale / depth["rows"]
    for i, value in enumerate(depth["cells"]):
        x, y = (i % depth["cols"] + .5) * cw, (i // depth["cols"] + .5) * ch
        blocked = value is None
        if not blocked:
            continue
        color = ".7 .12 .15 1" if blocked else f"{.12 + min(value/5, 1)*.48} {.55-min(value/5, 1)*.18} .3 1"
        add(world, "geom", name=f"cell_{i}", type="box", pos=f"{x} {y} {terrain.height(x,y)+.002}",
            size=f"{cw/2} {ch/2} .001", rgba=color,
            contype="0", conaffinity="0")

    def line(a, b, color, radius=.012, z=.015):
        start,end=np.array([a['x'],a['y']])*scale,np.array([b['x'],b['y']])*scale
        segments=max(1,math.ceil(np.linalg.norm(end-start)/.1))
        for j in range(segments):
            p=start+(end-start)*j/segments;q=start+(end-start)*(j+1)/segments
            add(world, "geom", type="capsule", fromto=f"{p[0]} {p[1]} {terrain.height(*p)+z} {q[0]} {q[1]} {terrain.height(*q)+z}",size=str(radius),rgba=color,contype='0',conaffinity='0')

    colors = {"transport": ".25 .65 1 1", "mining": "1 .5 .1 1", "warehouse": ".8 .6 1 1", "charging": ".3 1 .5 1"}
    for zone in scene["source"]["zones"]:
        pts = zone["points"]
        for a, b in zip(pts, pts[1:] + pts[:1]):
            line(a, b, colors.get(zone["kind"], "1 1 1 1"))
    p = scene["route"]["points"][0]
    # Slide joints are offsets from a body placed at the route spawn. MuJoCo's
    # qpos0 is also a joint reference: changing it to world coordinates shifts
    # the reference frame and must not be used to store a global spawn.
    truck = add(world, "body", name="truck", pos=f"{p['x']*scale} {p['y']*scale} {terrain.height(p['x']*scale,p['y']*scale)+.045}")
    add(truck, "joint", name="x", type="slide", axis="1 0 0", damping="0")
    add(truck, "joint", name="y", type="slide", axis="0 1 0", damping="0")
    add(truck, 'joint',name='z',type='slide',axis='0 0 1',damping='.1')
    add(truck, "joint", name="yaw", type="hinge", axis="0 0 1", damping=".002")
    add(truck, 'joint',name='pitch',type='hinge',axis='0 1 0',damping='.02')
    add(truck, 'joint',name='roll',type='hinge',axis='1 0 0',damping='.02')
    add(truck, "geom", name="chassis", type="box", size=".085 .043 .019", mass=str(c["massKg"]*.65), rgba=".95 .65 .07 1")
    add(truck, "geom", type="box", pos=".056 0 .034", size=".027 .037 .023", mass=".08", rgba=".12 .3 .45 1")
    add(truck, "geom", type="box", pos=".08 0 .026", size=".003 .03 .013", mass=".01", rgba=".55 .85 1 1")
    for side in [-1, 1]:
        for x in [-.058, 0, .058]:
            add(truck,'geom',type='sphere',pos=f'{x} {side*c["trackWidth"]/2} -.022',size='.02',mass='.001',rgba='0 0 0 0',friction='.002 .001 .0001')
            wheel = add(truck, "body", pos=f"{x} {side*c['trackWidth']/2} -.022")
            add(wheel, "joint", name=f"wheel_{side}_{x}", type="hinge", axis="0 1 0", damping=".001")
            add(wheel, "geom", type="cylinder", size=".02 .009", quat=".70710678 .70710678 0 0", mass=".01", rgba=".08 .09 .11 1", contype="0", conaffinity="0")
    bed = add(truck, "body", name="bed", pos="-.068 0 .027")
    add(bed, "joint", name="tip", type="hinge", axis="0 -1 0", range="0 1.05", damping=".05")
    add(bed, "geom", type="box", pos=".043 0 .003", size=".06 .04 .004", mass=".12", rgba=".95 .48 .06 1")
    for side in [-1, 1]:
        add(bed, "geom", type="box", pos=f".043 {side*.041} .018", size=".06 .003 .018", mass=".015", rgba="1 .65 .08 1")
    add(bed, "geom", name="cargo", type="ellipsoid", pos=".04 0 .022", size=".048 .032 .015", mass=".001", rgba=".38 .25 .12 0", contype="0", conaffinity="0")
    for i, station in enumerate(scene["stations"]):
        centre = station["centre"]
        base = add(world, "body", name=f"station_{i}", pos=f"{centre['x']*scale} {centre['y']*scale} {terrain.height(centre['x']*scale,centre['y']*scale)}", euler=f"0 0 {station['heading']}")
        add(base, "geom", type="box", pos="0 0 .035", size=f"{c['stationLengthM']/2} {c['stationWidthM']/2} .035", rgba=".18 .3 .42 1")
        add(base, "geom", type="box", pos="-.08 0 .12", size=".03 .06 .08", rgba=".2 .75 .45 1")
        slider = add(base, "body", pos=f"{c['stationLengthM']/2} 0 0")
        add(slider, "joint", name=f"arm_x_{i}", type="slide", axis="1 0 0", range="0 .24", damping="2")
        add(slider, "geom", type="box", pos="0 0 .11", size=".012 .016 .11", mass=".15", rgba=".6 .65 .7 1", contype="0", conaffinity="0")
        lift = add(slider, "body", gravcomp="1")
        add(lift, "joint", name=f"arm_z_{i}", type="slide", axis="0 0 1", range=".02 .16", damping="2")
        add(lift, "geom", type="box", size=".018 .025 .012", mass=".1", rgba=".9 .7 .15 1", contype="0", conaffinity="0")
        wrist = add(lift, "body", gravcomp="1")
        add(wrist, "joint", name=f"wrist_{i}", type="hinge", axis="1 0 0", range="-.8 .8", damping=".02")
        add(wrist, "geom", type="capsule", fromto="0 -.025 0 0 .025 0", size=".006", mass=".02", rgba=".9 .85 .4 1", contype="0", conaffinity="0")
    actuators = add(root, "actuator")
    add(actuators, "position", name="tip_servo", joint="tip", kp="3", kv=".2", forcerange="-1 1")
    # Terrain-normal stabilisers approximate a track support footprint. They do
    # not claim to model individual track links or suspension mechanics.
    for axis in ['pitch','roll']:
        add(actuators,'position',name=f'{axis}_support',joint=axis,kp='5',kv='.4',forcerange='-.5 .5')
    for i in range(len(scene["stations"])):
        for axis, kp, kv in [("arm_x", 80, 10), ("arm_z", 150, 12), ("wrist", 3, .2)]:
            add(actuators, "position", name=f"{axis}_{i}", joint=f"{axis}_{i}", kp=kp, kv=kv, forcerange="-8 8")
    return ET.tostring(root, encoding="unicode")


def angle(v):
    return math.atan2(math.sin(v), math.cos(v))


class Simulation:
    def __init__(self, planner):
        self.planner, self.scene = planner, planner.scene
        self.config = self.scene["config"]
        self.terrain=Terrain(self.scene)
        self.model = mujoco.MjModel.from_xml_string(scene_xml(self.scene),assets=self.terrain.assets())
        self.data = mujoco.MjData(self.model)
        self.q = {name: self.model.joint(name).qposadr[0] for name in ["x", "y", "yaw"]}
        self.d = {name: self.model.joint(name).dofadr[0] for name in self.q}
        self.reset()

    def reset(self, autostart=True):
        mujoco.mj_resetData(self.model, self.data)
        self.soc = self.config["initialSoc"]
        self.payload = 0.
        self.deliveries = 0
        self.station = None
        self.station_index = 0
        self.path_role = "work"
        self.history = []
        self.current = 0.
        self.voltage = 0.
        self.error = ""
        self.path = []
        self.set_path(self.scene["route"]["points"], "warehouse" if self.scene["route"].get("fromKind", "mining") == "mining" else "mining")
        self.data.qpos[self.q["x"]], self.data.qpos[self.q["y"]] = 0, 0
        self.data.qpos[self.q["yaw"]] = math.atan2(*(self.path[1]-self.path[0])[::-1])
        for i in range(len(self.scene["stations"])):
            self.data.qpos[self.model.joint(f"arm_z_{i}").qposadr[0]] = .08
        self.transition("loading" if autostart else "idle")
        mujoco.mj_forward(self.model, self.data)
        self.max_error = 0.
        self.stalled = 0.

    def set_path(self, points, goal):
        self.path = [np.array([p["x"], p["y"]])*self.config["metresPerUnit"] for p in points]
        self.index, self.goal = 1, goal

    @property
    def xy(self):
        return self.path_spawn + np.array([self.data.qpos[self.q["x"]], self.data.qpos[self.q["y"]]])

    @property
    def path_spawn(self):
        p = self.scene["route"]["points"][0]
        return np.array([p["x"], p["y"]])*self.config["metresPerUnit"]

    def map_position(self):
        p = self.xy / self.config["metresPerUnit"]
        return dict(x=float(p[0]), y=float(p[1]))

    def transition(self, stage):
        self.stage, self.stage_start = stage, self.data.time
        self.history.append(dict(time=self.data.time, stage=stage, soc=self.soc, goal=self.goal))
        self.history = self.history[-2000:]

    def request(self, op, kind=None):
        result = self.planner.ask(op=op, start=self.map_position(), soc=self.soc, kind=kind)
        if op == "charge":
            self.station = result["station"]
            self.station_index = next(i for i, s in enumerate(self.scene["stations"]) if s["id"] == self.station["id"])
            self.path_role = "to-charge"
            self.set_path(result["points"], "charging")
        else:
            self.path_role = "work"
            self.set_path(result["points"], kind)
        self.transition("driving")

    def step(self):
        dt = self.model.opt.timestep
        elapsed = self.data.time-self.stage_start
        c = self.config
        yaw = self.data.qpos[self.q["yaw"]]
        vx, vy, omega = (self.data.qvel[self.d[k]] for k in ["x", "y", "yaw"])
        forward = np.array([math.cos(yaw), math.sin(yaw)])
        lateral = np.array([-forward[1], forward[0]])
        velocity = np.array([vx, vy])
        speed = float(velocity @ forward)
        target_v = target_w = tip = 0.
        if self.stage in {"idle", "stopped", "error"}:
            self.data.qfrc_applied[:] = 0
            return
        try:
            if self.stage == "driving":
                delta = self.path[self.index]-self.xy
                distance = float(np.linalg.norm(delta))
                heading_error = angle(math.atan2(delta[1], delta[0])-yaw)
                if distance < .009:
                    if self.index < len(self.path)-1:
                        self.index += 1
                    elif np.linalg.norm(velocity) < .008:
                        self.transition("docking" if self.goal == "charging" else "unloading" if self.goal == "warehouse" else "loading")
                else:
                    target_w = max(-1., min(1., 3*heading_error))
                    if abs(heading_error) < .15:
                        target_v = min(c["speed"], math.sqrt(2*c["acceleration"]*max(0, distance-.003))) * max(0, math.cos(heading_error))
                if self.soc <= c["chargeTrigger"] and self.goal != "charging":
                    self.transition("charge-stop")
            elif self.stage == "charge-stop":
                if np.linalg.norm(velocity) < .003 and abs(omega) < .01:
                    self.request("charge")
            elif self.stage == "stopping":
                extended = any(self.data.qpos[self.model.joint(f"arm_x_{i}").qposadr[0]] > .012 for i in range(len(self.scene["stations"])))
                if np.linalg.norm(velocity) < .003 and abs(omega) < .01 and not extended:
                    self.transition("stopped")
            elif self.stage == "loading":
                self.payload = c["payloadKg"]*min(1, elapsed/4)
                if elapsed >= 4:
                    self.request("work", "warehouse")
            elif self.stage == "unloading":
                tip = min(1., elapsed) if elapsed < 3 else max(0, 4-elapsed)
                self.payload = c["payloadKg"]*max(0, 1-max(0, elapsed-1)/2)
                if elapsed >= 4:
                    self.deliveries += 1
                    self.request("work", "mining")
            elif self.stage == "docking":
                target_w = max(-.5, min(.5, 3*angle(self.station["dockHeading"]-yaw)))
                if abs(angle(self.station["dockHeading"]-yaw)) < .015 and abs(omega) < .02:
                    self.transition("connecting")
            elif self.stage == "connecting":
                i = self.station_index
                x = self.data.qpos[self.model.joint(f"arm_x_{i}").qposadr[0]]
                z = self.data.qpos[self.model.joint(f"arm_z_{i}").qposadr[0]]
                if elapsed > 2 and abs(x-.16) < .002 and abs(z-.08) < .003:
                    self.transition("charging")
                elif elapsed > 30:
                    raise RuntimeError("Station axis failed to reach contact position")
            elif self.stage == "charging":
                dock = self.station["dock"]
                dock_xy = np.array([dock["x"], dock["y"]])*c["metresPerUnit"]
                if np.linalg.norm(self.xy-dock_xy) > .025 or np.linalg.norm(velocity) > .015:
                    raise RuntimeError("Charging contact lost; current disabled")
                if self.soc >= c["targetSoc"]:
                    self.transition("disconnecting")
            elif self.stage == "disconnecting" and elapsed > 3:
                self.request("work", "warehouse" if self.payload > .001 else "mining")
            if self.soc <= .02:
                raise RuntimeError("Battery exhausted")
        except RuntimeError as exc:
            self.error = str(exc)
            self.transition("error")
            target_v = target_w = 0.

        # Generalized forces integrate a planar chassis, with saturated traction
        # and lateral resistance. This is not a deformable crawler-track model.
        mass = c["massKg"] + self.payload
        force = float(np.clip((target_v-speed)*mass*8, -mass*c["acceleration"], mass*c["acceleration"]))
        gradient=np.array(self.terrain.gradient(*self.xy))
        gravity_comp=float(self.model.body_subtreemass[self.model.body('truck').id])*9.81*gradient
        force+=float(gravity_comp@forward)
        force = float(np.clip(force, -min(2*c["torqueLimit"]/c["k"], c["mu"]*mass*9.81), min(2*c["torqueLimit"]/c["k"], c["mu"]*mass*9.81)))
        force_xy = forward*force+lateral*(float(gravity_comp@lateral)-float(velocity @ lateral)*mass*30)
        self.data.qfrc_applied[:] = 0
        self.data.qfrc_applied[self.d["x"]], self.data.qfrc_applied[self.d["y"]] = force_xy
        self.data.qfrc_applied[self.d["yaw"]] = np.clip((target_w-omega)*.04, -.015, .015)
        for side in [-1, 1]:
            wheel_speed = (speed+side*omega*c["trackWidth"]/2)/.02
            for x in [-.058, 0, .058]:
                dof = self.model.joint(f"wheel_{side}_{x}").dofadr[0]
                self.data.qfrc_applied[dof] = np.clip(.01*(wheel_speed-self.data.qvel[dof]), -.01, .01)
        self.data.ctrl[self.model.actuator("tip_servo").id] = tip
        along=float(gradient@forward);across=float(gradient@lateral)
        self.data.ctrl[self.model.actuator('pitch_support').id]=-math.atan(along)
        self.data.ctrl[self.model.actuator('roll_support').id]=math.atan(across)
        for i in range(len(self.scene["stations"])):
            extended = i == self.station_index and self.stage in {"connecting", "charging"}
            self.data.ctrl[self.model.actuator(f"arm_x_{i}").id] = .16 if extended else .01
            self.data.ctrl[self.model.actuator(f"arm_z_{i}").id] = .08
            self.data.ctrl[self.model.actuator(f"wrist_{i}").id] = .25 if extended else 0
        self.model.geom("cargo").rgba[3] = min(1, self.payload/max(c["payloadKg"], .001))
        ocv = 3.2+.9*self.soc+.1*self.soc**8
        if self.stage == "charging":
            self.current = min(1., max(.03, (4.2-ocv)/.12))
            self.soc = min(c["targetSoc"], self.soc+self.current*dt/(3600*c["capacityAh"]))
            self.voltage = ocv+self.current*.12
        else:
            power = .18 + (1.5+abs(force*speed)/c["converterEfficiency"] if abs(speed) > .001 or abs(omega) > .01 else 0)
            self.current = -power/max(ocv, 3)
            self.soc = max(0., self.soc+self.current*dt/(3600*c["capacityAh"]))
            self.voltage = ocv+self.current*.12
        mujoco.mj_step(self.model, self.data)
        if not np.isfinite(self.data.qpos).all():
            raise RuntimeError("Non-finite MuJoCo state")
        if self.stage == "driving" and abs(speed) < .001 and abs(target_v) > .02:
            self.stalled += dt
            if self.stalled > 20:
                self.error = "Chassis blocked by collision"
                self.transition("error")
        else:
            self.stalled = 0

    def status(self):
        return f"{self.stage} | SOC {self.soc*100:.1f}% | height {self.terrain.height(*self.xy):.2f} m | cargo {self.payload:.2f} kg | deliveries {self.deliveries}"

    def draw_path(self, scene):
        """Only decorate the active path; geometry is never used to teleport the truck."""
        color = np.array([1, .75, .05, 1] if self.goal == "charging" else [.1, .9, 1, 1], dtype=np.float32)
        samples=[]
        for a,b in zip(self.path,self.path[1:]):
            count=max(1,math.ceil(np.linalg.norm(b-a)/.1))
            samples.extend((a+(b-a)*j/count,a+(b-a)*(j+1)/count) for j in range(count))
        for a, b in samples:
            if scene.ngeom >= scene.maxgeom:
                break
            geom = scene.geoms[scene.ngeom]
            mujoco.mjv_initGeom(geom, mujoco.mjtGeom.mjGEOM_CAPSULE, np.zeros(3), np.zeros(3), np.eye(3).ravel(), color)
            mujoco.mjv_connector(geom, mujoco.mjtGeom.mjGEOM_CAPSULE, .015, [*a, self.terrain.height(*a)+.025], [*b, self.terrain.height(*b)+.025])
            scene.ngeom += 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, help="roi-workspace.json from site")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--seconds", type=float, default=0, help="Simulation time limit; 0 = endless")
    parser.add_argument("--speed", type=float, default=1, help="Wall-clock acceleration; operation durations remain 4 simulated seconds")
    parser.add_argument("--soc", type=float, default=.65)
    parser.add_argument("--capacity", type=float, default=.8)
    parser.add_argument("--screenshot", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--save-model", type=Path, help="Save generated MJCF scene")
    args = parser.parse_args()
    if args.speed <= 0 or args.seconds < 0 or (args.headless and not args.seconds):
        parser.error("Positive speed required; headless mode requires --seconds > 0")
    planner = Planner(args.workspace, {"initialSoc": args.soc, "capacityAh": args.capacity})
    try:
        sim = Simulation(planner)
        if args.save_model:
            args.save_model.parent.mkdir(parents=True, exist_ok=True)
            args.save_model.write_text(scene_xml(planner.scene), encoding="utf-8")
            (args.save_model.parent/'elevation.png').write_bytes(sim.terrain.assets()['elevation.png'])
        controls = {"paused": False, "follow": True, "overview": False, "reset": False}
        def key_callback(key):
            if key == 32:
                controls["paused"] = not controls["paused"]
            if key == ord("F"):
                controls["follow"] = not controls["follow"]
                controls["overview"] = not controls["follow"]
            if key == ord("R"):
                controls["reset"] = True
        if args.headless:
            context = nullcontext(None)
        else:
            from mujoco import viewer as mj_viewer
            context = mj_viewer.launch_passive(sim.model, sim.data, key_callback=key_callback)
        with context as viewer:
            if viewer:
                viewer.cam.lookat[:] = [5, 3.5, 0]
                viewer.cam.distance, viewer.cam.azimuth, viewer.cam.elevation = 10, 90, -55
            start, last_status, last_physics_time = time.monotonic(), -2., 0.
            while (not viewer or viewer.is_running()) and (not args.seconds or sim.data.time < args.seconds):
                if controls["reset"] or sim.data.time < last_physics_time-1e-9:
                    sim.reset()
                    controls["reset"], controls["paused"] = False, False
                    start, last_status = time.monotonic(), -2.
                if viewer and controls["paused"]:
                    viewer.sync()
                    time.sleep(.02)
                    start = time.monotonic()-sim.data.time/args.speed
                    continue
                for _ in range(10):
                    sim.step()
                    if sim.stage == "error":
                        raise RuntimeError(sim.error)
                last_physics_time = sim.data.time
                if sim.data.time-last_status >= 2:
                    print(f"{sim.data.time:8.1f}s {sim.status()}", flush=True)
                    last_status = sim.data.time
                if viewer:
                    viewer.user_scn.ngeom = 0
                    sim.draw_path(viewer.user_scn)
                    if controls["follow"]:
                        viewer.cam.lookat[:] = [*sim.xy, sim.terrain.height(*sim.xy)+.08]
                        viewer.cam.distance = 1.2
                    elif controls["overview"]:
                        viewer.cam.lookat[:] = [5, 3.5, 0]
                        viewer.cam.distance = 10
                        controls["overview"] = False
                    viewer.set_texts((mujoco.mjtFont.mjFONT_NORMAL, mujoco.mjtGridPos.mjGRID_TOPLEFT,
                                      "ROI test stand | SPACE: pause | F: follow\n"+sim.status(),
                                      f"Synthetic metric terrain: {sim.terrain.minimum:.2f} to {sim.terrain.maximum:.2f} m"))
                    viewer.sync()
                    time.sleep(max(0, start+sim.data.time/args.speed-time.monotonic()))
            if args.screenshot:
                from PIL import Image
                with mujoco.Renderer(sim.model, height=800, width=1280) as renderer:
                    cam = mujoco.MjvCamera()
                    cam.lookat[:] = [5, 3.5, 0]
                    cam.distance, cam.azimuth, cam.elevation = 10, 90, -55
                    renderer.update_scene(sim.data, camera=cam)
                    sim.draw_path(renderer.scene)
                    args.screenshot.parent.mkdir(parents=True, exist_ok=True)
                    Image.fromarray(renderer.render()).save(args.screenshot)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(dict(synthetic=True, engine="MuJoCo", version=mujoco.__version__,
                time=sim.data.time, stage=sim.stage, soc=sim.soc, deliveries=sim.deliveries,
                position=sim.data.xpos[sim.model.body('truck').id].tolist(),elevation=sim.scene['source']['elevation'],
                groundHeightM=sim.terrain.height(*sim.xy),history=sim.history), indent=2), encoding="utf-8")
    finally:
        planner.close()


if __name__ == "__main__":
    main()
