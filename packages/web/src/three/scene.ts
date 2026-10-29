import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { binFor, type Matrix } from "../lib/series.js";

/** Sequential steps, matching the 2D grid's `--seq-*` ramp so both views agree. */
const SEQ_STEPS = 8;

export interface BarFieldPalette {
  seq: THREE.Color[];
  zero: THREE.Color;
  floor: THREE.Color;
  highlight: THREE.Color;
}

export interface Layout {
  xStep: number;
  zStep: number;
  width: number;
  depth: number;
  height: number;
}

export interface BarFieldScene {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  mesh: THREE.InstancedMesh;
  layout: Layout;
  /** Instance index → [row, col]. */
  cellOf: (instance: number) => [number, number];
  colorOf: (instance: number) => THREE.Color;
  render: () => void;
  resetView: () => void;
  orbit: (dTheta: number, dPhi: number, zoom: number) => void;
  resize: (width: number, height: number) => void;
  dispose: () => void;
}

/**
 * Read a CSS colour token as an sRGB THREE.Color. Tokens may be oklch(), which
 * THREE can't parse, so the browser rasterises one pixel and we read it back.
 */
export function readPalette(root: HTMLElement): BarFieldPalette {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const style = getComputedStyle(root);
  const read = (name: string, fallback: string): THREE.Color => {
    const value = style.getPropertyValue(name).trim() || fallback;
    if (!ctx) return new THREE.Color(fallback);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = fallback;
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  };
  return {
    seq: Array.from({ length: SEQ_STEPS }, (_, i) => read(`--seq-${i}`, "#3987e5")),
    zero: read("--muted", "#888888"),
    floor: read("--secondary", "#777777"),
    highlight: read("--foreground", "#ffffff"),
  };
}

export function computeLayout(matrix: Matrix): Layout {
  const cols = Math.max(1, matrix.cols.length);
  const rows = Math.max(1, matrix.rows.length);
  // Wide-and-shallow grids (90 days × 8 projects) get deeper rows so the
  // field reads as a field, not a ribbon; heights scale with the footprint.
  const xStep = 1;
  const zStep = Math.min(5, Math.max(1.4, (cols / rows) * 0.75));
  const width = cols * xStep;
  const depth = rows * zStep;
  const height = Math.min(18, Math.max(4, Math.max(width, depth) * 0.22));
  return { xStep, zStep, width, depth, height };
}

export function createBarField(
  container: HTMLElement,
  matrix: Matrix,
  palette: BarFieldPalette,
  options: { reducedMotion: boolean }
): BarFieldScene {
  const layout = computeLayout(matrix);
  const rows = matrix.rows.length;
  const cols = matrix.cols.length;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(0.6, 1.4, 1);
  scene.add(sun);

  const floorGeometry = new THREE.PlaneGeometry(layout.width + 2, layout.depth + 2);
  const floorMaterial = new THREE.MeshLambertMaterial({ color: palette.floor });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(layout.width / 2, -0.01, layout.depth / 2);
  scene.add(floor);

  // Unit box with its base at y=0, so scale.y is the bar height.
  const geometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const material = new THREE.MeshLambertMaterial();
  const count = rows * cols;
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
  const colors: THREE.Color[] = [];
  const matrix4 = new THREE.Matrix4();
  const barW = layout.xStep * 0.78;
  const barD = Math.min(layout.zStep * 0.78, 1.6);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const value = matrix.values[r][c];
      const h =
        value > 0 && matrix.max > 0 ? Math.max(0.06, (value / matrix.max) * layout.height) : 0.03;
      matrix4.compose(
        new THREE.Vector3((c + 0.5) * layout.xStep, 0, (r + 0.5) * layout.zStep),
        new THREE.Quaternion(),
        new THREE.Vector3(barW, h, barD)
      );
      mesh.setMatrixAt(i, matrix4);
      const color = value > 0 ? palette.seq[binFor(value, matrix.max, SEQ_STEPS)] : palette.zero;
      colors.push(color);
      mesh.setColorAt(i, color);
    }
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  const target = new THREE.Vector3(layout.width / 2, 0, layout.depth / 2);
  controls.target.copy(target);
  controls.enableDamping = !options.reducedMotion;
  controls.dampingFactor = 0.12;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.minDistance = 4;
  controls.maxDistance = Math.max(layout.width, layout.depth) * 4;
  controls.listenToKeyEvents(container);

  const resetView = () => {
    // Portrait viewports see less width at the same distance; back off to fit.
    const fit = Math.max(1, 1.3 / Math.max(0.1, camera.aspect));
    const dist = (Math.max(layout.width, layout.depth) * 0.95 + layout.height) * fit;
    camera.position.set(target.x + dist * 0.22, target.y + dist * 0.58, target.z + dist * 0.88);
    controls.target.copy(target);
    controls.update();
  };
  resetView();

  const render = () => renderer.render(scene, camera);
  const spherical = new THREE.Spherical();
  const offset = new THREE.Vector3();
  const orbit = (dTheta: number, dPhi: number, zoom: number) => {
    offset.copy(camera.position).sub(controls.target);
    spherical.setFromVector3(offset);
    spherical.theta += dTheta;
    spherical.phi = Math.min(controls.maxPolarAngle, Math.max(0.15, spherical.phi + dPhi));
    spherical.radius = Math.min(
      controls.maxDistance,
      Math.max(controls.minDistance, spherical.radius * zoom)
    );
    offset.setFromSpherical(spherical);
    camera.position.copy(controls.target).add(offset);
    camera.lookAt(controls.target);
    controls.update();
  };

  return {
    renderer,
    camera,
    controls,
    mesh,
    layout,
    cellOf: (instance) => [Math.floor(instance / cols), instance % cols],
    colorOf: (instance) => colors[instance],
    render,
    resetView,
    orbit,
    resize: (width, height) => {
      renderer.setSize(width, height, false);
      renderer.domElement.style.width = `${width}px`;
      renderer.domElement.style.height = `${height}px`;
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
    },
    dispose: () => {
      controls.dispose();
      geometry.dispose();
      material.dispose();
      floorGeometry.dispose();
      floorMaterial.dispose();
      mesh.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
