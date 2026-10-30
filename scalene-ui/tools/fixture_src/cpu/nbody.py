"""Pure-Python N-body simulation (velocity Verlet) with a NumPy energy check.

    python nbody.py 400 2000
"""
import math
import sys
import time

import numpy as np

G = 6.674e-11
SOFTENING = 1e-3


class Body:
    __slots__ = ("x", "y", "z", "vx", "vy", "vz", "mass")

    def __init__(self, x, y, z, vx, vy, vz, mass):
        self.x, self.y, self.z = x, y, z
        self.vx, self.vy, self.vz = vx, vy, vz
        self.mass = mass


def make_cluster(n, seed=42):
    rng = np.random.default_rng(seed)
    pos = rng.normal(0.0, 1.0e11, size=(n, 3))
    vel = rng.normal(0.0, 3.0e3, size=(n, 3))
    mass = rng.uniform(1.0e23, 1.0e26, size=n)
    return [Body(*pos[i], *vel[i], mass[i]) for i in range(n)]


def accelerations(bodies):
    n = len(bodies)
    acc = [[0.0, 0.0, 0.0] for _ in range(n)]
    for i in range(n):
        bi = bodies[i]
        ax = ay = az = 0.0
        for j in range(n):
            if i == j:
                continue
            bj = bodies[j]
            dx = bj.x - bi.x
            dy = bj.y - bi.y
            dz = bj.z - bi.z
            r2 = dx * dx + dy * dy + dz * dz + SOFTENING
            inv_r3 = 1.0 / (r2 * math.sqrt(r2))
            s = G * bj.mass * inv_r3
            ax += s * dx
            ay += s * dy
            az += s * dz
        acc[i][0], acc[i][1], acc[i][2] = ax, ay, az
    return acc


def step(bodies, acc, dt):
    for b, a in zip(bodies, acc):
        b.vx += 0.5 * dt * a[0]
        b.vy += 0.5 * dt * a[1]
        b.vz += 0.5 * dt * a[2]
        b.x += dt * b.vx
        b.y += dt * b.vy
        b.z += dt * b.vz
    new_acc = accelerations(bodies)
    for b, a in zip(bodies, new_acc):
        b.vx += 0.5 * dt * a[0]
        b.vy += 0.5 * dt * a[1]
        b.vz += 0.5 * dt * a[2]
    return new_acc


def total_energy(bodies):
    pos = np.array([[b.x, b.y, b.z] for b in bodies])
    vel = np.array([[b.vx, b.vy, b.vz] for b in bodies])
    mass = np.array([b.mass for b in bodies])
    kinetic = 0.5 * np.sum(mass * np.sum(vel * vel, axis=1))
    diff = pos[:, None, :] - pos[None, :, :]
    dist = np.sqrt(np.sum(diff * diff, axis=-1) + SOFTENING)
    np.fill_diagonal(dist, np.inf)
    potential = -0.5 * G * np.sum(np.outer(mass, mass) / dist)
    return kinetic + potential


def main(n=400, steps=2000, dt=3600.0):
    bodies = make_cluster(n)
    acc = accelerations(bodies)
    e0 = total_energy(bodies)
    t0 = time.perf_counter()
    for s in range(steps):
        acc = step(bodies, acc, dt)
        if s % 500 == 0:
            drift = abs((total_energy(bodies) - e0) / e0)
            print(f"step {s:5d}  energy drift {drift:.3e}")
    print(f"{steps} steps of {n} bodies in {time.perf_counter() - t0:.1f}s")


if __name__ == "__main__":
    args = [int(a) for a in sys.argv[1:3]]
    main(*args)
