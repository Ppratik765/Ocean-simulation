# Waveglider

A browser-based relaxation experience built with WebGL and custom GLSL shaders. You fly as a bird over a physically simulated ocean, with no objectives, no scoring, and no time pressure. The intent is a quiet, meditative escape that runs entirely in the browser without installation.

Live: [waveglider.vercel.app](https://waveglider.vercel.app)

---

## What it is

Waveglider is not a game in the conventional sense. There is nothing to collect, no enemies, no progression system. You steer a bird over an infinite ocean through different sky environments. The wings flap at a rhythm close to a resting heartbeat. The wave physics, spray, ambient audio, and passing boats are there to be noticed, not interacted with.

It started as an experiment in GPU ocean simulation after reading the mathematics behind Gerstner waves. The wave system worked well enough to keep building, and it gradually became something that felt genuinely calm to spend time in.

---

## Controls

### Desktop

| Input | Action |
|---|---|
| W | Climb |
| S | Dive |
| A | Bank and turn left |
| D | Bank and turn right |
| Q | Previous sky environment |
| E | Next sky environment |
| Space | Toggle V-formation |
| Escape | Pause |

### Mobile

On-screen touch buttons are displayed automatically. The ENV button cycles sky environments. The V button toggles the formation. Landscape orientation triggers fullscreen automatically.

---

## Technical overview

### Stack

- Three.js r183
- Vite 7 (build tooling)
- Vanilla JavaScript (ES modules)
- Custom GLSL vertex and fragment shaders
- Web Audio API via Three.js AudioListener

### Ocean simulation

The ocean surface is a 1024x1024 (desktop) or 384x384 (mobile) plane geometry displaced in the vertex shader using Gerstner wave mathematics. Gerstner waves model physically plausible ocean surfaces by displacing vertices both vertically and horizontally, producing the characteristic peaked crests and flat troughs of real water rather than the symmetric sine curves of naive implementations.

Twelve wave components are summed per vertex on desktop (eight on mobile). The wave directions, wavelengths, steepnesses, and speeds are distributed using the golden ratio to avoid repetitive patterns. Spatial domain warping is applied before wave evaluation, distorting the grid non-uniformly and completely eliminating the quilted, tiling appearance common in procedural ocean renders.

The fragment shader adds:

- Fresnel reflection computed per pixel against the PMREM-filtered HDRI environment map
- Subsurface scattering approximated as a scatter colour term driven by wave elevation
- Geometric shadowing from a dot product between the macro surface normal and the light direction
- Micro-ripple capillary waves from a multi-octave simplex noise normal perturbation
- Volumetric foam using ridged FBM noise masked by wave steepness (the vChoppiness varying)
- Distance fog that samples the horizon band of the HDRI for correct colour matching

### Spray particles

60,000 point particles (15,000 on mobile) ride the wave surface. Each particle evaluates a 4-iteration Gerstner approximation in the vertex shader to find the local wave height and normal, then launches upward along that normal with simulated gravity. A steepness threshold gates when spray is visible, so it only appears on genuinely choppy wave geometry. Particles are rendered as soft radial circles in the fragment shader and blended additively.

### Infinite ocean tiling

The ocean uses a 3x3 grid of tiles (9 meshes). Every frame the grid centre snaps to the nearest 10,000-unit multiple of the bird's XZ position. Because the ocean shader runs entirely in world-space coordinates (not UV space), there are no visible seams when tiles jump. The bird can fly in any direction indefinitely. The grid covers a radius of 15,000 units in all directions, which is well beyond the fog falloff distance at any altitude.

### Bird rig

The bird is a GLTF model with skeletal animation. The rig hierarchy is:

```
birdGroup       — yaw, altitude, continuous forward motion
  tiltGroup     — visual roll (Z) and pitch (X) only
    birdWrapper — rigid offset correcting the GLB's off-centre origin
      birdModel — GLTF scene, rotated 180 degrees on Y
```

This separation means banking (A/D) applies roll to tiltGroup, which then drives yaw on birdGroup proportionally — a coordinated turn where the bird tilts before arcing. The camera offset is applied in birdGroup local space, so it rotates identically with the rig and the bird remains centred on screen regardless of turn angle.

The GLTF contains root motion baked into the skeleton. To prevent the skeleton root from drifting across the scene (rubber-banding), the root bone's position is reset to its initial value every frame after mixer.update(). This preserves the wing flap animation while eliminating the translation component.

### V-formation

Toggling the formation spawns four additional birds cloned with SkeletonUtils.clone before any rotation mutations are applied to the original GLTF scene. Each clone gets its own AnimationMixer with a phase offset so the wingbeats are desynchronised. The wingmen are positioned in birdWrapper local space using fixed V-shaped offsets. When the bird passes close to a world prop, the wingmen drift outward on randomised scatter vectors and snap back after a cooldown.

### World props

Eighteen prop instances (boats, barrels, crates, treasure chests) are maintained in a pool. Props that drift more than 3,200 units from the bird in XZ are teleported to a random position in a 400–3,000 unit ring in a random direction, giving a 360-degree spread that persists when the player turns around. Props bob on a simple sine function rather than evaluating the full wave shader, avoiding the visual glitching that occurs when trying to match Gerstner phase positions from JavaScript.

Treasure chests have a canvas-generated radial gradient glow sprite (AdditiveBlending), a PointLight, and a rising particle system of 40 gold sparkles per chest. The glow and light pulse together on a dual-frequency sine to produce a firelight quality.

### Lighting

- HemisphereLight (sky 0x8ab0d0, ground 0x0d1a24, intensity 0.6) — ambient fill
- DirectionalLight with PCF shadow maps at 2048x2048
- HDRI environment maps loaded as equirectangular HDR textures, processed through PMREMGenerator before assignment to scene.environment — this produces the correct specular IBL mip chain that PBR materials require to evaluate reflections without shimmering artefacts

### Post-processing

EffectComposer chain: RenderPass → UnrealBloomPass → OutputPass

The render target uses MSAA x4 (samples: 4) on desktop and no multisampling on mobile. The bloom pass is configured with a high threshold (0.99) so it only brightens true HDR highlights — sun glints on wave crests and the chest glow sprites — rather than washing out the scene.

### Audio

Four layered audio sources:

| Layer | File | Technique | Volume |
|---|---|---|---|
| Ocean waves | ocean_sound.mp3 | THREE.Audio, looped | 0.80 |
| Seagulls | Seagull_sound.m4a | Pool of 3 Audio objects, random pitch 0.80–1.18, random interval 3–9s | 0.30–0.65 |
| Wood creaking | wood_creaking.m4a | THREE.PositionalAudio parented to each boat mesh, rolloff 1.5, maxDistance 350 | 0.70 |
| Wing flaps | wind_flapping.m4a | THREE.Audio, fired every 0.855s with ±10% jitter | 0.20 |

All audio is gated behind a user gesture (the click-to-start screen) to comply with browser autoplay policies. Late-loading buffers are started in the render loop the first frame they become available after the simulation has begun.

### Mobile optimisation

Detection uses both the user-agent string and maxTouchPoints to handle edge cases, including Samsung S Pen devices, which can misreport pointer capability to the browser as fine/hover even when only the touchscreen is in use. On these devices, a JS fallback adds a class to the document root to force touch controls visible regardless of CSS pointer media query results.

Mobile quality tier differences from desktop:

- Ocean mesh: 384x384 vs 1024x1024
- Gerstner iterations: 8 vs 12
- Spray particles: 15,000 vs 60,000
- MSAA: x2 vs x4
- Shadow maps: disabled
- PointLights on chests: disabled
- Pixel ratio: capped at 1.0 vs 1.5
- Renderer antialias: disabled vs enabled

### Performance

The render loop is hard-capped at 60fps by comparing elapsed time against a 16.67ms budget before executing any frame work. This halves GPU load on 120/144Hz displays with no visual cost.

---

## Project structure

```
/
├── index.html
├── public/
│   ├── bird.glb
│   ├── boat_1.glb
│   ├── boat_2.glb
│   ├── barrel.glb
│   ├── crate.glb
│   ├── treasure_chest.glb
│   ├── ocean_sound.mp3
│   ├── Seagull_sound.m4a
│   ├── wind_flapping.m4a
│   ├── wood_creaking.m4a
│   ├── wave.png
│   └── textures/
│       ├── skybox_0.hdr
│       ├── skybox_1.hdr
│       ├── skybox_2.hdr
│       ├── skybox_3.hdr
│       └── skybox_4.hdr
└── src/
    ├── main.js
    ├── style.css
    └── shaders/
        ├── ocean.vert.glsl
        ├── ocean.frag.glsl
        ├── spray.vert.glsl
        └── spray.frag.glsl
```

---

## Running locally

Requires Node.js 20 or later.

```bash
npm install
npm run dev
```

Open http://localhost:5173 in a browser. The game requires WebGL 2.0, which is supported in all modern browsers.

---

## Background

The wave mathematics are based on the Gerstner wave formulation described in GPU Gems Chapter 1 (Finch, 2004), which itself draws from the classical fluid dynamics work on trochoidal wave theory. The next planned development is replacing the summed sinusoid approach with a Fast Fourier Transform spectrum method as described in Jerry Tessendorf's 1999 paper "Simulating Ocean Water", which produces a statistically correct Phillips spectrum and significantly more realistic open-ocean appearance.

---

## References

- Finch, M. (2004). Effective Water Simulation from Physical Models. GPU Gems, Chapter 1. NVIDIA.
- Tessendorf, J. (1999). Simulating Ocean Water. SIGGRAPH Course Notes.
- Jiménez, J. et al. (2012). Filmic SMAA. SIGGRAPH.

---

## License

MIT
