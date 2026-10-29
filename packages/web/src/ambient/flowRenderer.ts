/**
 * Raw-WebGL flow field for the Overview header. Deliberately not three.js:
 * one full-screen triangle and one fragment shader is ~3 kB, loaded lazily.
 *
 * Budget rules: DPR capped at 1.5, at most ~30 fps, no frames while the tab is
 * hidden or the band is off-screen, and a single static frame when motion is
 * off. Tempo/brightness changes ease over ~1.5 s so a refresh never jolts.
 */

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_bright;
uniform vec3 u_bg;
uniform float u_dark;

const vec3 V1 = vec3(0.357, 0.271, 0.788); // #5B45C9
const vec3 V2 = vec3(0.545, 0.486, 1.0);   // #8B7CFF
const vec3 V3 = vec3(0.706, 0.659, 1.0);   // #B4A8FF
const vec3 AMBER = vec3(0.961, 0.722, 0.255); // #F5B841

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = vec2(uv.x * u_res.x / u_res.y, uv.y) * 2.2;
  float t = u_time * 0.05;
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, -t * 0.8)));
  float f = fbm(p + 1.8 * q + vec2(t * 0.6, 0.0));
  vec3 col = mix(V1, V2, smoothstep(0.2, 0.8, f));
  col = mix(col, V3, smoothstep(0.55, 0.95, q.y) * 0.6);
  col = mix(col, AMBER, smoothstep(0.5, 0.8, f * q.x * 1.7) * 0.85);
  // Faint under the text on the left, fuller towards the right edge: the
  // header copy sits on near-background colour so its contrast holds.
  float k = mix(0.06, 0.62, smoothstep(0.3, 0.95, uv.x)) * u_bright;
  k *= mix(1.0, 1.15, u_dark);
  gl_FragColor = vec4(mix(u_bg, col, clamp(k, 0.0, 0.75)), 1.0);
}
`;

const FRAME_MS = 1000 / 30;
const EASE_SECONDS = 1.5;
const MAX_DPR = 1.5;
// The field is soft and low-frequency, so it renders at half resolution and
// the browser upscales it: a quarter of the fragment work for no visible loss.
const RENDER_SCALE = 0.5;

export interface FlowOptions {
  animate: boolean;
  tempo: number;
  brightness: number;
  /** Theme background as linear-ish sRGB 0..1. */
  background: [number, number, number];
  dark: boolean;
  onFirstFrame: () => void;
}

export interface FlowRenderer {
  update: (next: Partial<Omit<FlowOptions, "onFirstFrame">>) => void;
  dispose: () => void;
}

/** Returns null when WebGL is unavailable; the caller keeps its CSS gradient. */
export function startFlow(canvas: HTMLCanvasElement, initial: FlowOptions): FlowRenderer | null {
  const options = { ...initial };
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;
  // With hardware acceleration off the browser falls back to a CPU renderer
  // (SwiftShader, llvmpipe), where this field costs several ms of CPU per
  // frame and can starve the page. There it stays a still frame.
  const software = isSoftwareRenderer(gl);

  let program: WebGLProgram | null = null;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};
  let frame = 0;
  let lost = false;
  let visible = true;
  let firstFrame = true;
  let phase = 0;
  let tempo = options.tempo;
  let brightness = options.brightness;
  let lastDraw = 0;
  let lastTick = 0;

  const build = (): boolean => {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return false;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL API, not a React hook
    gl.useProgram(prog);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // One triangle covering the viewport; cheaper than a quad's diagonal seam.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    program = prog;
    uniforms = Object.fromEntries(
      ["u_res", "u_time", "u_bright", "u_bg", "u_dark"].map((name) => [
        name,
        gl.getUniformLocation(prog, name),
      ])
    );
    return true;
  };

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR) * RENDER_SCALE;
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
  };

  const draw = () => {
    if (!program || lost) return;
    resize();
    gl.uniform2f(uniforms.u_res, canvas.width, canvas.height);
    gl.uniform1f(uniforms.u_time, phase);
    gl.uniform1f(uniforms.u_bright, brightness);
    gl.uniform3f(uniforms.u_bg, ...options.background);
    gl.uniform1f(uniforms.u_dark, options.dark ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (firstFrame) {
      firstFrame = false;
      options.onFirstFrame();
    }
  };

  const running = () =>
    options.animate && !software && visible && !lost && document.visibilityState === "visible";

  const tick = (now: number) => {
    frame = 0;
    if (!running()) return;
    frame = requestAnimationFrame(tick);
    if (now - lastDraw < FRAME_MS) return;
    const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 0;
    lastTick = now;
    lastDraw = now;
    const ease = Math.min(1, dt / EASE_SECONDS);
    tempo += (options.tempo - tempo) * ease;
    brightness += (options.brightness - brightness) * ease;
    // Phase integrates tempo, so a tempo change speeds the flow up smoothly
    // instead of jumping to a different point in time.
    phase += dt * tempo;
    draw();
  };

  const schedule = () => {
    if (running()) {
      if (!frame) {
        lastTick = 0;
        frame = requestAnimationFrame(tick);
      }
    } else {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      // Motion off or paused: settle on the target values in one still frame.
      tempo = options.tempo;
      brightness = options.brightness;
      draw();
    }
  };

  const onVisibility = () => schedule();
  const observer = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    schedule();
  });
  const sizeObserver = new ResizeObserver(() => {
    if (!running()) draw();
  });
  const onLost = (event: Event) => {
    event.preventDefault(); // allow restoration
    lost = true;
    program = null;
    schedule();
  };
  const onRestored = () => {
    lost = false;
    if (build()) schedule();
  };

  if (!build()) return null;
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  document.addEventListener("visibilitychange", onVisibility);
  observer.observe(canvas);
  sizeObserver.observe(canvas);
  schedule();

  return {
    update: (next) => {
      Object.assign(options, next);
      schedule();
      if (!running()) draw();
    },
    dispose: () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      sizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

function isSoftwareRenderer(gl: WebGLRenderingContext): boolean {
  let name = String(gl.getParameter(gl.RENDERER) ?? "");
  // Chrome and Safari mask RENDERER as "WebKit WebGL"; only then ask the
  // debug extension (Firefox reports a real name and warns if it is queried).
  if (/webkit/i.test(name)) {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (info) name = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "");
  }
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
}
