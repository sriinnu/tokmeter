import { useEffect, useState } from "react";

export type WebGLSupport = "checking" | "supported" | "unsupported";

/**
 * Probe for WebGL before loading three.js, so browsers without it (or with
 * hardware acceleration off) never download the 3D chunk at all.
 */
export function useWebGLSupport(): WebGLSupport {
  const [support, setSupport] = useState<WebGLSupport>("checking");
  useEffect(() => {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      setSupport(gl ? "supported" : "unsupported");
      // Release the probe context right away; browsers cap live contexts.
      (gl as WebGLRenderingContext | null)?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      setSupport("unsupported");
    }
  }, []);
  return support;
}
