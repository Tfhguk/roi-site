"""Integration checks against the real MuJoCo solver and shared route planner."""
from simulate import Planner, Simulation
import numpy as np


def advance_until(sim, predicate, seconds):
    limit = sim.data.time + seconds
    while not predicate() and sim.data.time < limit:
        sim.step()
        assert sim.stage != "error", sim.error
        assert np.isfinite(sim.data.qpos).all()
        assert 0 < sim.soc <= 1
    assert predicate(), (sim.stage, sim.data.time, sim.error)


def main():
    p = Planner(config={"initialSoc": .65})
    try:
        s = Simulation(p)
        advance_until(s, lambda: s.deliveries >= 2, 550)
        assert s.stage == "driving", "Work continues after unloading"
        loaded = next(h for h in s.history if h["stage"] == "loading")
        departure = next(h for h in s.history if h["stage"] == "driving")
        assert abs(departure["time"]-loaded["time"]-4) < .004
        unloaded = next(h for h in s.history if h["stage"] == "unloading")
        departure = next(h for h in s.history if h["stage"] == "driving" and h["time"] > unloaded["time"])
        assert abs(departure["time"]-unloaded["time"]-4) < .004
        print("PASS: real MuJoCo dynamics, finite states, two deliveries, continuous work, four-second operations", flush=True)
    finally:
        p.close()
    for loaded in [True, False]:
        p = Planner(config={"initialSoc": .24, "capacityAh": .3, "targetSoc": .4})
        try:
            s = Simulation(p)
            if not loaded:
                s.transition("driving")
            advance_until(s, lambda: s.stage == "charging", 250)
            assert s.payload > .01 if loaded else s.payload == 0
            position = s.xy.copy()
            advance_until(s, lambda: s.stage == "disconnecting", 450)
            assert s.soc >= .399
            assert np.linalg.norm(s.xy-position) < .01, "Truck remains stationary while charging"
            advance_until(s, lambda: s.stage == "driving", 10)
            assert s.goal == ("warehouse" if loaded else "mining")
            print("PASS: stop, dynamic charger path, docking axes, charge, disconnect, cargo-based destination", loaded, flush=True)
        finally:
            p.close()


if __name__ == "__main__":
    main()
