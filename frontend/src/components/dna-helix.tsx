"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";

/**
 * Tiny decorative DNA double-helix.
 * Used inline beside the "Welcome to MediDoor" title in the login card.
 * No user input — pure visual.
 */
function Helix() {
  const group = useRef<THREE.Group>(null);

  // Pre-compute the two strands and the connecting "rungs".
  const { left, right, rungs } = useMemo(() => {
    const turns = 2.2;
    const steps = 22;
    const radius = 0.55;
    const height = 2.6;
    const left: THREE.Vector3[] = [];
    const right: THREE.Vector3[] = [];
    const rungs: { a: THREE.Vector3; b: THREE.Vector3 }[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const angle = t * turns * Math.PI * 2;
      const y = (t - 0.5) * height;
      const a = new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      const b = new THREE.Vector3(
        Math.cos(angle + Math.PI) * radius,
        y,
        Math.sin(angle + Math.PI) * radius
      );
      left.push(a);
      right.push(b);
      if (i % 2 === 0) rungs.push({ a, b });
    }
    return { left, right, rungs };
  }, []);

  useFrame((_, dt) => {
    if (group.current) group.current.rotation.y += dt * 0.6;
  });

  return (
    <group ref={group} rotation={[0.1, 0, 0]}>
      {left.map((p, i) => (
        <mesh key={`l${i}`} position={p}>
          <sphereGeometry args={[0.085, 20, 20]} />
          <meshStandardMaterial color="#06ad65" roughness={0.25} metalness={0.4} />
        </mesh>
      ))}
      {right.map((p, i) => (
        <mesh key={`r${i}`} position={p}>
          <sphereGeometry args={[0.085, 20, 20]} />
          <meshStandardMaterial color="#1ec77f" roughness={0.25} metalness={0.4} />
        </mesh>
      ))}
      {rungs.map((s, i) => {
        const mid = s.a.clone().add(s.b).multiplyScalar(0.5);
        const dir = s.b.clone().sub(s.a);
        const len = dir.length();
        const quat = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          dir.clone().normalize()
        );
        const euler = new THREE.Euler().setFromQuaternion(quat);
        return (
          <mesh
            key={`b${i}`}
            position={mid}
            rotation={[euler.x, euler.y, euler.z]}
          >
            <cylinderGeometry args={[0.025, 0.025, len, 10]} />
            <meshStandardMaterial color="#8feac1" roughness={0.4} />
          </mesh>
        );
      })}
    </group>
  );
}

export function DnaHelix({ className = "h-20 w-20" }: { className?: string }) {
  return (
    <div className={className}>
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [0, 0, 3.4], fov: 38 }}
        gl={{ alpha: true, antialias: true }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.7} />
        <directionalLight position={[3, 4, 5]} intensity={1.1} />
        <directionalLight position={[-3, -2, 2]} intensity={0.4} color="#06ad65" />
        <Suspense fallback={null}>
          <Helix />
        </Suspense>
      </Canvas>
    </div>
  );
}
