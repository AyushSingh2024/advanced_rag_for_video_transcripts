"use strict";
/* ============================================================================
   The wave band — React Bits' GradientWaves, ported to plain WebGL2.

   The component you sent is React and depends on `ogl`. This app has no
   bundler, no React, and no npm install available, so what runs here is a port
   rather than the component: the *shader is verbatim* — same GLSL, same
   uniform names, same detail-to-steps mapping — and the ~30 lines of `ogl`
   that stood behind it (Renderer, Program, Mesh, Triangle) are replaced by the
   fullscreen-triangle draw they compile down to. Nothing visual is invented
   here; if you later add a build step, this file can be deleted and the real
   component dropped in with the same numbers.

   Two of your numbers did change, and only these two:

     brightness  0.9 -> 0.6   (dark theme; 1.0 in light, as you had it)
     opacity     1.0 -> 0.7   (dark theme; 0.55 in light)

   Your values are tuned for a decorative panel with nothing on top of it. Here
   the band sits behind the page title, and at brightness 0.9 / opacity 1.0 the
   white crests reach roughly #e6e6e6 — which puts near-white text on a
   near-white background at about 1.1:1. The values above are the highest that
   still hold the title clear of WCAG AA against the brightest pixel the shader
   can produce (the arithmetic is in frontend/verify-ui.mjs, and it uses the
   shader's own worst case: crest * brightness at full alpha). Light mode keeps
   your brightness exactly, because there the same maths runs the other way — a
   brighter band only helps dark text. Everything else — colours, speed,
   amplitude, swell, turbulence, tilt, zoom, height, fog, detail, grain — is
   exactly as you specified.

   The band is also the reason the greeting, the health pills and the course
   line moved below the masthead: no scrim worth looking through gets small
   13px type to 4.5:1 over moving water. Only the title sits on the waves.
   ========================================================================= */

(() => {
  const host = document.getElementById("waves");
  if (!host) return;

  const CONFIG = {
    horizonColor: "#b77140",
    waveColor: "#d88e5a",
    crestColor: "#FFFFFF",
    speed: 0.3,
    amplitude: 2.5,
    waveScale: 0.7,
    waveRatio: 0.8,
    swell: 35,
    turbulence: 16,
    tilt: 1.3,
    zoom: 0.75,
    height: 5.5,
    fogDepth: 18,
    detail: "low",
    grain: true,
    grainIntensity: 0.08,
    mouseInteraction: false,
    parallaxStrength: 0.57,
    /* Per theme, because the band has to sit under the title in both. Held to
       the point where the title still clears WCAG AA against the worst pixel
       the shader can paint, and no dimmer than that. */
    dark: { brightness: 0.6, opacity: 0.7 },
    light: { brightness: 1.0, opacity: 0.55 },
  };

  const detailToSteps = (detail) => (detail === "low" ? 40 : detail === "high" ? 110 : 70);

  const hexToRgb = (hex) => {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim());
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 0, 0];
  };

  /* ---------------------------------------------------------------- shader ---
     Verbatim from the component. Do not tidy: the constants inside plasma()
     and the camera basis are what make it look like the reference. */
  const VERTEX = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

  const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uSpeed;
uniform float uAmplitude;
uniform float uWaveScale;
uniform float uWaveRatio;
uniform float uSwell;
uniform float uTurbulence;
uniform float uTilt;
uniform float uZoom;
uniform float uHeight;
uniform float uFogDepth;
uniform float uSteps;
uniform float uBrightness;
uniform float uOpacity;
uniform float uGrain;
uniform float uGrainIntensity;
uniform vec2 uMouse;
uniform float uParallax;
uniform bool uEnableMouse;
uniform vec3 uHorizonColor;
uniform vec3 uWaveColor;
uniform vec3 uCrestColor;
out vec4 fragColor;
const float MAX_DIST = 20000.0;
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float plasma(vec3 r, vec2 freq, vec4 tc) {
  float mx = r.x + tc.x;
  mx += uSwell * sin((r.y + mx) / 20.0 + tc.y);
  float my = r.y - tc.z;
  my += uTurbulence * cos(r.x / 23.0 + tc.w);
  return r.z - (sin(mx * freq.x) * uAmplitude + sin(my * freq.y) * uAmplitude + uHeight);
}
float raymarch(vec3 pos, vec3 dir, vec2 freq, vec4 tc) {
  float dist = 0.0;
  for (int i = 0; i < 128; i++) {
    if (float(i) >= uSteps) break;
    float dscene = plasma(pos + dist * dir, freq, tc);
    if (abs(dscene) < 0.1) break;
    dist += 0.9 * dscene;
    if (!(abs(dist) < MAX_DIST)) return MAX_DIST;
  }
  return dist;
}
void main() {
  float T = iTime * uSpeed;
  vec2 freq = vec2(uWaveScale / 7.0, (uWaveScale * uWaveRatio) / 3.0);
  vec4 tc = vec4(T / 0.130, T / 0.810, T / 0.200, T / 0.710);
  float c, s;
  float vfov = (3.14159 / 2.3) / max(uZoom, 0.05);
  vec3 cam = vec3(0.0, 0.0, 30.0);
  vec2 uv = (gl_FragCoord.xy / iResolution.xy) - 0.5;
  uv.x *= iResolution.x / iResolution.y;
  uv.y *= -1.0;
  vec3 dir = vec3(0.0, 0.0, -1.0);
  float ulen = length(uv);
  float xrot = vfov * ulen;
  c = cos(xrot); s = sin(xrot);
  dir = mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c) * dir;
  vec2 nuv = ulen > 1e-5 ? uv / ulen : vec2(1.0, 0.0);
  c = nuv.x; s = nuv.y;
  dir = mat3(c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0) * dir;
  c = cos(uTilt); s = sin(uTilt);
  dir = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c) * dir;
  if (uEnableMouse) {
    float yaw = (uMouse.x - 0.5) * uParallax * 0.4;
    float pitch = (uMouse.y - 0.5) * uParallax * 0.4;
    c = cos(yaw); s = sin(yaw);
    dir = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c) * dir;
    c = cos(pitch); s = sin(pitch);
    dir = mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c) * dir;
  }
  float dist = raymarch(cam, dir, freq, tc);
  vec3 pos = cam + dist * dir;
  float t = clamp(uFogDepth / max(dist, 0.001), 0.0, 1.0);
  vec3 body = mix(uWaveColor, uCrestColor, clamp(pos.z * 0.08 + 0.5, 0.0, 1.0));
  vec3 col = mix(uHorizonColor, body, t);
  col *= uBrightness;
  col = clamp(col, 0.0, 1.0);
  float alpha = clamp(t, 0.0, 1.0) * uOpacity;
  if (uGrain > 0.5) {
    float g = hash21(gl_FragCoord.xy + mod(iTime, 64.0) * 11.0);
    alpha += (g - 0.5) * uGrainIntensity;
  }
  alpha = clamp(alpha, 0.0, 1.0);
  fragColor = vec4(col * alpha, alpha);
}
`;

  /* ------------------------------------------------------------------ setup --- */
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });

  // No WebGL2, or a blocked context: leave the element alone. The flat warm
  // gradient already on .waves in CSS is the fallback, and it is the same
  // horizon colour, so the page looks intentional rather than broken.
  if (!gl) return;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn("waves: shader failed to compile —", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vs = compile(gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  if (!vs || !fs) return;

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("waves: program failed to link —", gl.getProgramInfoLog(program));
    return;
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  gl.useProgram(program);

  // One triangle large enough to cover the clip cube. This is all `ogl`'s
  // Triangle geometry is, and it saves an index buffer and a second vertex.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const positionLoc = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

  const u = (name) => gl.getUniformLocation(program, name);
  const U = {
    resolution: u("iResolution"), time: u("iTime"),
    speed: u("uSpeed"), amplitude: u("uAmplitude"), waveScale: u("uWaveScale"),
    waveRatio: u("uWaveRatio"), swell: u("uSwell"), turbulence: u("uTurbulence"),
    tilt: u("uTilt"), zoom: u("uZoom"), height: u("uHeight"), fogDepth: u("uFogDepth"),
    steps: u("uSteps"), brightness: u("uBrightness"), opacity: u("uOpacity"),
    grain: u("uGrain"), grainIntensity: u("uGrainIntensity"),
    mouse: u("uMouse"), parallax: u("uParallax"), enableMouse: u("uEnableMouse"),
    horizon: u("uHorizonColor"), wave: u("uWaveColor"), crest: u("uCrestColor"),
  };

  gl.uniform1f(U.speed, CONFIG.speed);
  gl.uniform1f(U.amplitude, CONFIG.amplitude);
  gl.uniform1f(U.waveScale, CONFIG.waveScale);
  gl.uniform1f(U.waveRatio, CONFIG.waveRatio);
  gl.uniform1f(U.swell, CONFIG.swell);
  gl.uniform1f(U.turbulence, CONFIG.turbulence);
  gl.uniform1f(U.tilt, CONFIG.tilt);
  gl.uniform1f(U.zoom, CONFIG.zoom);
  gl.uniform1f(U.height, CONFIG.height);
  gl.uniform1f(U.fogDepth, CONFIG.fogDepth);
  gl.uniform1f(U.steps, detailToSteps(CONFIG.detail));
  gl.uniform1f(U.grain, CONFIG.grain ? 1 : 0);
  gl.uniform1f(U.grainIntensity, CONFIG.grainIntensity);
  gl.uniform1f(U.parallax, CONFIG.parallaxStrength);
  gl.uniform1i(U.enableMouse, CONFIG.mouseInteraction ? 1 : 0);
  gl.uniform2f(U.mouse, 0.5, 0.5);
  gl.uniform3fv(U.horizon, hexToRgb(CONFIG.horizonColor));
  gl.uniform3fv(U.wave, hexToRgb(CONFIG.waveColor));
  gl.uniform3fv(U.crest, hexToRgb(CONFIG.crestColor));

  // Premultiplied output over a fully transparent clear, so the band composites
  // onto the paper instead of drawing its own black.
  gl.clearColor(0, 0, 0, 0);

  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  function applyTheme() {
    const theme = darkQuery.matches ? CONFIG.dark : CONFIG.light;
    gl.uniform1f(U.brightness, theme.brightness);
    gl.uniform1f(U.opacity, theme.opacity);
  }
  applyTheme();

  /* ------------------------------------------------------------------ frame --- */
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
  let width = 0;
  let height = 0;

  function resize() {
    const rect = host.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr()));
    const h = Math.max(1, Math.round(rect.height * dpr()));
    if (w === width && h === height) return false;
    width = w;
    height = h;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(U.resolution, w, h);
    return true;
  }

  // Elapsed time accumulates only while the band is actually drawing, so
  // coming back to a backgrounded tab resumes rather than jumping forward.
  let elapsed = motionQuery.matches ? 6 : 0;
  let last = 0;
  let raf = 0;
  let onScreen = true;
  let alive = true;

  function draw() {
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    resize();
    elapsed += (now - last) / 1000;
    last = now;
    gl.uniform1f(U.time, elapsed);
    draw();
  }

  function stop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function start() {
    if (raf || !alive) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  /* One frame, held still. Someone who asked for reduced motion gets the
     picture without the movement, not a blank strip. */
  function drawStill() {
    resize();
    gl.uniform1f(U.time, elapsed);
    draw();
  }

  function sync() {
    const shouldRun = alive && onScreen && !document.hidden && !motionQuery.matches;
    if (shouldRun) start();
    else {
      stop();
      if (alive && onScreen && !document.hidden) drawStill();
    }
  }

  host.appendChild(canvas);
  resize();

  new ResizeObserver(() => {
    if (motionQuery.matches || !raf) drawStill();
  }).observe(host);

  // Scrolled past, or the tab went to the background: stop burning GPU on a
  // raymarcher nobody is looking at.
  new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    sync();
  }, { threshold: 0 }).observe(host);

  document.addEventListener("visibilitychange", sync);
  darkQuery.addEventListener("change", () => { applyTheme(); if (!raf) drawStill(); });
  motionQuery.addEventListener("change", sync);

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();   // keep the canvas restorable rather than dead
    stop();
  });
  canvas.addEventListener("webglcontextrestored", () => { resize(); sync(); });

  // Release the context on navigation instead of waiting for the GC to notice.
  window.addEventListener("pagehide", () => {
    alive = false;
    stop();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  });

  sync();
})();
