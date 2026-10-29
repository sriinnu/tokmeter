import { Minus, Plus, RotateCcw, RotateCw, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { EmptyState } from "../components/states.js";
import { Button } from "../components/ui/button.js";
import type { Matrix } from "../lib/series.js";
import type { ResolvedTheme } from "../lib/theme.js";
import { type BarFieldScene, createBarField, readPalette } from "./scene.js";

interface Hover {
  x: number;
  y: number;
  row: number;
  col: number;
}

export interface BarField3DProps {
  matrix: Matrix;
  label: string;
  rowLabel: (row: string) => string;
  colLabel: (col: string) => string;
  formatValue: (value: number) => string;
  theme: ResolvedTheme;
  reducedMotion: boolean;
  /** Label every Nth column along the front edge. */
  colEvery: number;
}

const ROTATE_STEP = Math.PI / 12;

/**
 * Instanced bar field: one box per matrix cell, height linear in value and
 * colour on the same sequential ramp as the 2D grid. Rendering is on demand —
 * only while the camera moves — so an idle view costs nothing.
 */
export default function BarField3D({
  matrix,
  label,
  rowLabel,
  colLabel,
  formatValue,
  theme,
  reducedMotion,
  colEvery,
}: BarField3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<BarFieldScene | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [failed, setFailed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: theme is a rebuild trigger (palette is read from CSS)
  useEffect(() => {
    const host = hostRef.current;
    const labelHost = labelsRef.current;
    if (!host || !labelHost) return;

    let field: BarFieldScene;
    const palette = readPalette(document.documentElement);
    try {
      field = createBarField(host, matrix, palette, { reducedMotion });
    } catch {
      setFailed(true);
      return;
    }
    sceneRef.current = field;
    const { camera, controls, mesh, layout } = field;

    // Axis labels are DOM text projected from 3D anchors, so they stay crisp
    // and readable at any zoom instead of being baked into textures.
    labelHost.replaceChildren();
    const anchors: Array<{ el: HTMLElement; at: THREE.Vector3 }> = [];
    const addLabel = (text: string, at: THREE.Vector3, className: string) => {
      const el = document.createElement("span");
      el.textContent = text;
      el.className = className;
      labelHost.appendChild(el);
      anchors.push({ el, at });
    };
    matrix.rows.forEach((row, r) => {
      addLabel(
        rowLabel(row),
        new THREE.Vector3(-0.6, 0, (r + 0.5) * layout.zStep),
        "absolute left-0 top-0 max-w-36 -translate-x-full -translate-y-1/2 truncate whitespace-nowrap text-[11px] text-muted-foreground"
      );
    });
    matrix.cols.forEach((col, c) => {
      if (c % colEvery !== 0) return;
      addLabel(
        colLabel(col),
        new THREE.Vector3((c + 0.5) * layout.xStep, 0, layout.depth + 0.8),
        "absolute left-0 top-0 -translate-x-1/2 whitespace-nowrap text-[10px] text-muted-foreground"
      );
    });
    const projected = new THREE.Vector3();
    const placeLabels = () => {
      const { clientWidth: w, clientHeight: h } = host;
      for (const { el, at } of anchors) {
        projected.copy(at).project(camera);
        const visible =
          projected.z < 1 && Math.abs(projected.x) <= 1.05 && Math.abs(projected.y) <= 1.05;
        el.style.display = visible ? "" : "none";
        if (visible) {
          el.style.transform = `translate(${((projected.x + 1) / 2) * w}px, ${((1 - projected.y) / 2) * h}px)`;
        }
      }
    };

    let dirty = true;
    let frame = 0;
    const draw = () => {
      field.render();
      placeLabels();
    };
    const loop = () => {
      // update() returns true while damping is still settling the camera.
      if (controls.update() || dirty) {
        dirty = false;
        draw();
      }
      frame = requestAnimationFrame(loop);
    };
    const onChange = () => {
      dirty = true;
    };
    controls.addEventListener("change", onChange);

    let framed = false;
    const resize = () => {
      field.resize(host.clientWidth, host.clientHeight);
      // Frame once the real aspect is known; later resizes keep the user's view.
      if (!framed && host.clientWidth > 0) {
        framed = true;
        field.resetView();
      }
      dirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    frame = requestAnimationFrame(loop);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let lit = -1;
    const restore = () => {
      if (lit >= 0) {
        mesh.setColorAt(lit, field.colorOf(lit));
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        lit = -1;
        dirty = true;
      }
    };
    const onMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(mesh, false)[0];
      if (hit?.instanceId === undefined) {
        restore();
        setHover(null);
        return;
      }
      if (hit.instanceId !== lit) {
        restore();
        lit = hit.instanceId;
        mesh.setColorAt(lit, field.colorOf(lit).clone().lerp(palette.highlight, 0.45));
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        dirty = true;
      }
      const [row, col] = field.cellOf(hit.instanceId);
      setHover({ x: event.clientX - rect.left, y: event.clientY - rect.top, row, col });
    };
    const onLeave = () => {
      restore();
      setHover(null);
    };
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.removeEventListener("change", onChange);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      labelHost.replaceChildren();
      field.dispose();
      sceneRef.current = null;
    };
  }, [matrix, theme, reducedMotion, rowLabel, colLabel, colEvery]);

  if (failed) {
    return (
      <EmptyState
        art="no-webgl"
        title="3D couldn’t start"
        message="WebGL could not start in this browser. The grid below shows the same data."
      />
    );
  }

  const value = hover ? matrix.values[hover.row]?.[hover.col] : undefined;
  const nudge = (dTheta: number, dPhi: number, zoom: number) =>
    sceneRef.current?.orbit(dTheta, dPhi, zoom);

  return (
    <div className="grid gap-2">
      <div className="relative overflow-hidden rounded-lg border bg-card">
        <div
          ref={hostRef}
          // An application region: focusable, and arrow keys pan the camera.
          role="application"
          aria-roledescription="3D bar chart"
          aria-label={label}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: focus is what lets arrow keys pan the camera
          tabIndex={0}
          className="h-[min(62vh,520px)] min-h-72 w-full cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:cursor-grabbing"
        />
        <div ref={labelsRef} aria-hidden className="pointer-events-none absolute inset-0" />
        {hover && value !== undefined && (
          <div
            className="pointer-events-none absolute z-10 min-w-36 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
            style={{
              left: Math.min(hover.x + 12, (hostRef.current?.clientWidth ?? 0) - 170),
              top: Math.max(hover.y - 52, 4),
            }}
          >
            <div className="font-medium">{rowLabel(matrix.rows[hover.row])}</div>
            <div className="text-muted-foreground">{colLabel(matrix.cols[hover.col])}</div>
            <div className="num mt-0.5 font-semibold">
              {value > 0 ? formatValue(value) : "No usage"}
            </div>
          </div>
        )}
      </div>
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="toolbar"
        aria-label="3D view controls"
      >
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Rotate left"
          onClick={() => nudge(-ROTATE_STEP, 0, 1)}
        >
          <RotateCcw aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Rotate right"
          onClick={() => nudge(ROTATE_STEP, 0, 1)}
        >
          <RotateCw aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Zoom in"
          onClick={() => nudge(0, 0, 0.85)}
        >
          <Plus aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Zoom out"
          onClick={() => nudge(0, 0, 1 / 0.85)}
        >
          <Minus aria-hidden />
        </Button>
        <Button variant="outline" size="sm" onClick={() => sceneRef.current?.resetView()}>
          <Undo2 aria-hidden /> Reset view
        </Button>
        <span className="text-xs text-muted-foreground">
          Drag to orbit · scroll to zoom · focus the view and use arrow keys to pan
        </span>
      </div>
    </div>
  );
}
