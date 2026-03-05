import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader as HDRLoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import oceanVert from './shaders/ocean.vert.glsl?raw';
import oceanFrag from './shaders/ocean.frag.glsl?raw';
import sprayVert from './shaders/spray.vert.glsl?raw';
import sprayFrag from './shaders/spray.frag.glsl?raw';

// ─────────────────────────────────────────────
// 1. SCENE / RENDERER
// ─────────────────────────────────────────────
const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 20000);

// ─────────────────────────────────────────────
// MOBILE DETECTION — drives every quality branch below
// ─────────────────────────────────────────────
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
              || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);

const renderer = new THREE.WebGLRenderer({ antialias: !isMobile, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;

renderer.shadowMap.enabled = !isMobile;   // shadows off on mobile — big GPU win
renderer.shadowMap.type    = THREE.PCFShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

// ─────────────────────────────────────────────
// 2. OCEAN
// ─────────────────────────────────────────────
// Mobile: replace the 16-iteration Gerstner loop with an 8-iteration version.
// This is the single biggest GPU saving — halves the vertex shader cost.
const oceanVertSrc = isMobile
    ? oceanVert.replace('i < 16', 'i < 8').replace('i < 4', 'i < 2')  // fewer waves + fewer capillary
    : oceanVert;
const oceanFragSrc = isMobile
    ? oceanFrag.replace('i < 4', 'i < 2')   // fewer capillary noise octaves in frag
    : oceanFrag;

const customOceanMaterial = new THREE.ShaderMaterial({
    vertexShader: oceanVertSrc,
    fragmentShader: oceanFragSrc,
    uniforms: {
        uTime:           { value: 0 },
        uSunPosition:    { value: new THREE.Vector3(100, 50, -100).normalize() },
        uWaterColor:     { value: new THREE.Color(0x1a2b3c) },
        uWaterDeepColor: { value: new THREE.Color(0x050d14) },
        uEnvMap:         { value: null }
    }
});

// Mobile: 512×512 — noticeably better than 256 while still 4× cheaper than
// desktop 1024. Paired with a 2×2 grid the total vertex count stays lean.
const oceanRes  = isMobile ? 512  : 1024;
const GRID_DIM  = isMobile ? 2    : 3;    // 2×2 mobile, 3×3 desktop
const GRID_HALF = (GRID_DIM - 1) / 2;    // 0.5 for 2×2 → offsets ±5000; 1 for 3×3 → offsets ±10000
const geometry = new THREE.PlaneGeometry(10000, 10000, oceanRes, oceanRes);
geometry.rotateX(-Math.PI / 2);

// ─────────────────────────────────────────────
// OCEAN GRID — omnidirectional infinite treadmill.
// Tiles snap to nearest TILE_SIZE multiple of bird position every frame.
// 2×2 covers ±10 000 units in all directions (fog hides the edge at distance).
// 3×3 covers ±15 000 — never visibly finite on desktop.
// ─────────────────────────────────────────────
const TILE_SIZE = 10000;
const oceans = [];
for (let row = 0; row < GRID_DIM; row++) {
    for (let col = 0; col < GRID_DIM; col++) {
        const o = new THREE.Mesh(geometry, customOceanMaterial);
        o.position.set(
            (col - GRID_HALF) * TILE_SIZE,
            0,
            (row - GRID_HALF) * TILE_SIZE
        );
        o.receiveShadow = !isMobile;
        scene.add(o);
        oceans.push(o);
    }
}

// ─────────────────────────────────────────────
// 3. SPRAY
// ─────────────────────────────────────────────
const particleCount = isMobile ? 15000 : 60000;
const sprayGeo = new THREE.BufferGeometry();
const posArr   = new Float32Array(particleCount * 3);
const randArr  = new Float32Array(particleCount);
const velArr   = new Float32Array(particleCount * 3);
for (let i = 0; i < particleCount; i++) {
    posArr[i*3]   = (Math.random() - 0.5) * 10000;
    posArr[i*3+1] = 0;
    posArr[i*3+2] = (Math.random() - 0.5) * 10000;
    randArr[i]    = Math.random();
    velArr[i*3]   = 1.5 + Math.random();
    velArr[i*3+1] = 1.0 + Math.random();
    velArr[i*3+2] = 0.5 + Math.random();
}
sprayGeo.setAttribute('position',  new THREE.BufferAttribute(posArr,  3));
sprayGeo.setAttribute('aRandom',   new THREE.BufferAttribute(randArr, 1));
sprayGeo.setAttribute('aVelocity', new THREE.BufferAttribute(velArr,  3));

const sprayMaterial = new THREE.ShaderMaterial({
    vertexShader: sprayVert,
    fragmentShader: sprayFrag,
    uniforms: {
        uTime:           { value: 0 },
        uWaterColor:     { value: new THREE.Color(0x1a2b3c) },
        uWaterDeepColor: { value: new THREE.Color(0x050d14) }
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending
});
scene.add(new THREE.Points(sprayGeo, sprayMaterial));

// ─────────────────────────────────────────────
// 4. BIRD RIG
//
//   birdGroup  → yaw (A/D), altitude (W/S), forward motion
//   tiltGroup  → visual roll (Z) + pitch (X) only — never touches position
//   birdWrapper→ re-centres the off-origin GLB
//   birdModel  → GLTF scene
//
// Camera uses the ORIGINAL confirmed-working formula:
//   idealOffset(local) × birdGroup.matrixWorld  (no lerp, perfectly stable)
//   X = 8.5  aligns camera behind the bird's visual spine
//   Y = -4   slight downward look to frame bird in upper-centre of screen
//   Z = currentCamDist  (scalar-lerped for formation zoom)
// ─────────────────────────────────────────────

// V-formation local offsets relative to lead birdWrapper position.
// Z > 0 = behind lead (birds fly in -Z).  X = lateral spread.
const V_OFFSETS = [
    new THREE.Vector3(  0,  0,   0),   // Lead
    new THREE.Vector3(-14,  1,  13),   // Left  1
    new THREE.Vector3( 14,  1,  13),   // Right 1
    new THREE.Vector3(-28,  2,  26),   // Left  2
    new THREE.Vector3( 28,  2,  26),   // Right 2
];

// The centering offset that corrects the off-centre GLB origin.
// These values are the same ones used in the original working code.
const WRAP_BASE = new THREE.Vector3(13.0, -14.0, 0.0);

const birdGroup = new THREE.Group();
birdGroup.position.set(0, 75, 0);
scene.add(birdGroup);

const tiltGroup = new THREE.Group();
birdGroup.add(tiltGroup);

let birdWrapper  = null;
let birdModel    = null;
let mixer        = null;
let birdLoaded   = false;

// allWrappers[0] = lead birdWrapper, allWrappers[1-4] = wingmen
const allWrappers = [];
const allMixers   = [];

const gltfLoader = new GLTFLoader();
gltfLoader.load('/bird.glb', (gltf) => {
    if (birdLoaded) return;
    birdLoaded = true;

    // ── CRITICAL: clone raw scenes BEFORE mutating gltf.scene's rotation ──
    // SkeletonUtils.clone copies the object graph at the time of calling.
    // If we mutated rotation.y on gltf.scene first, every clone would inherit
    // that rotation, and our subsequent `clone.rotation.y = Math.PI` would
    // appear to "cancel" the inherited value in certain Three.js versions.
    // Cloning first gives each wingman a clean, unmodified base.
    const rawClones = [];
    for (let i = 1; i < V_OFFSETS.length; i++) {
        rawClones.push(SkeletonUtils.clone(gltf.scene));
    }

    // ── LEAD BIRD ─────────────────────────────────────────────────────────
    birdModel            = gltf.scene;
    birdModel.rotation.y = Math.PI;

    // Anisotropic filtering + HDRI env map + shadow casting on bird
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    birdModel.traverse(child => {
        if (child.isMesh && child.material) {
            child.castShadow = true;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(mat => {
                ['map','normalMap','roughnessMap','metalnessMap','aoMap','emissiveMap'].forEach(key => {
                    if (mat[key]) { mat[key].anisotropy = maxAniso; mat[key].needsUpdate = true; }
                });
                if (mat.envMapIntensity !== undefined) mat.envMapIntensity = 1.0;
                mat.needsUpdate = true;
            });
        }
    });

    birdWrapper = new THREE.Group();
    birdWrapper.position.copy(WRAP_BASE);
    birdWrapper.add(birdModel);
    tiltGroup.add(birdWrapper);
    allWrappers.push(birdWrapper);

    if (gltf.animations?.length > 0) {
        mixer = new THREE.AnimationMixer(birdModel);
        const leadAction = mixer.clipAction(gltf.animations[0]);
        leadAction.timeScale = 0.5;   // half-speed flap — looks natural
        leadAction.play();
        allMixers.push(mixer);
    }

    // ── WINGMEN ───────────────────────────────────────────────────────────
    rawClones.forEach((cloneScene, idx) => {
        const i = idx + 1;   // offset index into V_OFFSETS

        // Each clone is a fresh copy — safe to set rotation directly
        cloneScene.rotation.y = Math.PI;   // face away from camera (same as lead)

        const wrapper = new THREE.Group();
        wrapper.position.set(
            WRAP_BASE.x + V_OFFSETS[i].x,
            WRAP_BASE.y + V_OFFSETS[i].y,
            WRAP_BASE.z + V_OFFSETS[i].z
        );
        wrapper.add(cloneScene);
        wrapper.visible = false;   // hidden until spacebar
        tiltGroup.add(wrapper);
        allWrappers.push(wrapper);

        if (gltf.animations?.length > 0) {
            const m = new THREE.AnimationMixer(cloneScene);
            const action = m.clipAction(gltf.animations[0]);
            action.timeScale = 0.5;   // match lead bird's half-speed flap
            action.play();
            m.update(i * 0.37);   // phase-offset so wingmen don't flap in sync
            allMixers.push(m);
        }
    });
});

// ─────────────────────────────────────────────
// 5. WORLD OBJECT POOL
//
// ARCHITECTURE:
//   - Load one template GLB per prop type.
//   - Clone into a fixed pool of POOL_SIZE instances at startup.
//   - Each frame, any prop that has fallen RECYCLE_DIST behind the camera
//     is teleported to a random position ahead — identical to the ocean
//     tile treadmill, giving the illusion of an endlessly populated sea.
//   - Y position is set each frame from a lightweight JS Gerstner
//     approximation so props convincingly ride the waves.
//
// GOLDEN PARTICLE SYSTEM:
//   - Each treasure_chest instance gets a small Points cloud of 40 golden
//     sparkles that slowly spiral upward and loop.
//
// PROXIMITY SCATTER:
//   - When birdGroup comes within SCATTER_RADIUS of any prop, the
//     V-formation wingmen drift outward and then snap back when clear.
// ─────────────────────────────────────────────

// ── Gentle bob offset — props don't chase the full wave, they just gently
//    rise and fall by ±1.5 units on a slow personal timer.  This avoids the
//    glitching caused by trying to match the fast Gerstner math every frame.
function getBobOffset(phase, t) {
    return Math.sin(t * 0.4 + phase) * 1.5;
}

// ── Pool configuration ─────────────────────────────────────────────────────
const PROP_DISTRIBUTION = [
    { file: 'boat_1',         count: 3, scale: 0.8,  yBase: -5.0 },
    { file: 'boat_2',         count: 3, scale: 0.8,  yBase: -5.0 },
    { file: 'barrel',         count: 4, scale: 1.2,  yBase: -0.6 },
    { file: 'crate',          count: 4, scale: 1.0,  yBase: -0.5 },
    { file: 'treasure_chest', count: 4, scale: 0.9,  yBase: -0.5 },
];

// Props recycle when they drift more than this distance from the bird in XZ.
// They are then placed at a random position in a ring just outside SPAWN_MIN_DIST,
// distributed in all directions so turning around reveals objects everywhere.
const SPAWN_MIN_DIST  = 400;    // inner dead-zone (not right on top of bird)
const SPAWN_MAX_DIST  = 3000;   // how far out props are placed on recycle
const RECYCLE_DIST    = 3200;   // recycle when farther than this from bird

const propPool = [];

// Returns a random world position in a ring around the bird,
// spread in all directions (full 360°) so the ocean looks populated
// even when the player turns around.
function randomPropPosition() {
    const angle = Math.random() * Math.PI * 2;
    const dist  = SPAWN_MIN_DIST + Math.random() * (SPAWN_MAX_DIST - SPAWN_MIN_DIST);
    return {
        x: birdGroup.position.x + Math.cos(angle) * dist,
        z: birdGroup.position.z + Math.sin(angle) * dist,
    };
}

// ── CHEST GLOW SPRITE ──────────────────────────────────────────────────────
// Canvas-generated radial gradient texture: golden at centre, fully
// transparent at edges. AdditiveBlending means it only adds light —
// it never darkens anything — giving a natural bloom-like glow.
const glowCanvas  = document.createElement('canvas');
glowCanvas.width  = 128;
glowCanvas.height = 128;
const glowCtx     = glowCanvas.getContext('2d');
const glowGrad    = glowCtx.createRadialGradient(64, 64, 0, 64, 64, 64);
glowGrad.addColorStop(0.0, 'rgba(255, 200,  50, 0.55)');  // warm gold, semi-opaque core
glowGrad.addColorStop(0.3, 'rgba(255, 160,  20, 0.25)');  // fade to amber
glowGrad.addColorStop(1.0, 'rgba(255, 120,   0, 0.00)');  // fully transparent edge
glowCtx.fillStyle = glowGrad;
glowCtx.fillRect(0, 0, 128, 128);

const glowTex = new THREE.CanvasTexture(glowCanvas);
const glowMat = new THREE.SpriteMaterial({
    map:      glowTex,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
});
const glowSprite = new THREE.Sprite(glowMat);
glowSprite.scale.set(6, 4, 1);     // wide oval — wider than tall to hug the chest top
glowSprite.position.set(0, 2.2, 0); // float just above the lid

// ── Loader — spawns each type's instances immediately as it loads ──────────
// This means if one model fails/is slow, the rest still appear.
PROP_DISTRIBUTION.forEach(typeDef => {
    gltfLoader.load(`/${typeDef.file}.glb`, (gltf) => {
        const template = gltf.scene;
        template.scale.setScalar(typeDef.scale);

        // Anisotropic filtering eliminates the blurry/shimmering textures
        // seen at oblique angles — the max value the GPU supports is used.
        const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
        template.traverse(child => {
            if (child.isMesh && child.material) {
                // Shadows
                child.castShadow    = true;
                child.receiveShadow = true;

                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach(mat => {
                    // Anisotropic filtering on all texture maps
                    ['map','normalMap','roughnessMap','metalnessMap','aoMap','emissiveMap'].forEach(key => {
                        if (mat[key]) {
                            mat[key].anisotropy = maxAnisotropy;
                            mat[key].needsUpdate = true;
                        }
                    });
                    // HDRI environment intensity — controls how strongly the
                    // skybox HDRI affects reflections and diffuse IBL on this material.
                    // 1.0 is physically correct; we nudge slightly above so props
                    // read clearly against the dark ocean in all lighting conditions.
                    if (mat.envMapIntensity !== undefined) mat.envMapIntensity = 1.0;
                    mat.needsUpdate = true;
                });
            }
        });

        for (let n = 0; n < typeDef.count; n++) {
            const mesh = template.clone(true);

            // Place in a full ring around starting position
            const pos = randomPropPosition();
            mesh.position.set(pos.x, typeDef.yBase, pos.z);
            mesh.rotation.set(0, Math.random() * Math.PI * 2, 0);
            scene.add(mesh);

            let sparklePoints = null;
            let chestGlow     = null;
            if (typeDef.file === 'treasure_chest') {
                const geo = sparkleGeo.clone();
                sparklePoints = new THREE.Points(geo, sparkleMat);
                sparklePoints.position.y = 1.5;
                mesh.add(sparklePoints);

                // ── VISIBLE GLOW SPRITE ────────────────────────────────────
                // A canvas-drawn radial gradient gives a soft organic glow
                // that looks like warm light pooling above the coin hoard.
                // Sprites always face the camera, so it reads correctly from
                // any angle the player flies past.
                mesh.add(glowSprite.clone());

                // ── POINT LIGHT ───────────────────────────────────────────
                // Spills golden light onto the ocean surface and the chest
                // itself. Kept faint (0.5) so it reads as ambience not a torch.
                // PointLight skipped on mobile — PointLights are expensive draw calls
                if (!isMobile) {
                    chestGlow = new THREE.PointLight(0xffaa00, 0.5, 20, 2);
                    chestGlow.position.set(0, 2.0, 0);
                    mesh.add(chestGlow);
                }
            }

            propPool.push({
                mesh,
                type:     typeDef.file,
                yBase:    typeDef.yBase,
                bobPhase: Math.random() * Math.PI * 2,
                sparklePoints,
                chestGlow,
            });
        }
    });
});
const SPARKLE_COUNT  = 40;
const sparkleGeo     = new THREE.BufferGeometry();
const sparklePos     = new Float32Array(SPARKLE_COUNT * 3);
const sparklePhases  = new Float32Array(SPARKLE_COUNT);
for (let i = 0; i < SPARKLE_COUNT; i++) {
    // Spread in a small 3-unit radius at Y=0; animated upward each frame
    sparklePos[i*3]   = (Math.random() - 0.5) * 3;
    sparklePos[i*3+1] = Math.random() * 4;
    sparklePos[i*3+2] = (Math.random() - 0.5) * 3;
    sparklePhases[i]  = Math.random() * Math.PI * 2;
}
sparkleGeo.setAttribute('position', new THREE.BufferAttribute(sparklePos, 3));
const sparkleMat = new THREE.PointsMaterial({
    color: 0xffd700,
    size: 0.35,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
});

// ── Scatter state for wingmen ──────────────────────────────────────────────
// targetScatter[i] and currentScatter[i] are XZ offsets (world units)
// applied on top of V_OFFSETS so the wingmen drift when near a prop.
const SCATTER_RADIUS = 180;
const scatterTargets  = Array.from({ length: 4 }, () => new THREE.Vector3());
const scatterCurrents = Array.from({ length: 4 }, () => new THREE.Vector3());
let   isScattering    = false;
let   scatterCooldown = 0;   // seconds before allowing re-scatter

// ── Loader — defined above inline per type ─────────────────────────────────

// ─────────────────────────────────────────────
// 6. POST-PROCESSING  (with MSAA × 8 to fix aliasing)
//
// WHY: EffectComposer renders to an internal WebGLRenderTarget, which
// completely bypasses the renderer's own antialias flag (that flag only
// applies to the final canvas blit, which the composer never does).
// Supplying a WebGLRenderTarget with `samples: 8` gives us hardware MSAA
// through the full post-processing chain — bloom included.
// ─────────────────────────────────────────────
const msaaTarget = new THREE.WebGLRenderTarget(
    window.innerWidth,
    window.innerHeight,
    {
        samples:    isMobile ? 1 : 4,        // no MSAA on mobile — huge fillrate saving
        type:       THREE.HalfFloatType,
        colorSpace: renderer.outputColorSpace,
    }
);

const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85
);
bloomPass.threshold = 0.99;
bloomPass.radius    = 0.05;
const composer = new EffectComposer(renderer, msaaTarget);  // ← pass MSAA target here
composer.addPass(new RenderPass(scene, camera));
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ─────────────────────────────────────────────
// 7. SKYBOX
// ─────────────────────────────────────────────
let currentSkyboxIndex = 0;
const totalSkyboxes    = 5;
const hdrLoader        = new HDRLoader().setPath('/textures/');
let targetExposure = 0.95, currentExposure = 0.95;
let targetBloom    = 0.05, currentBloom    = 0.05;
let isTransitioning = false;
renderer.toneMappingExposure = currentExposure;
bloomPass.strength           = currentBloom;

function switchSkybox(dir) {
    if (isTransitioning) return;
    isTransitioning = true;
    targetExposure  = 0.0;
    setTimeout(() => {
        const next = (currentSkyboxIndex + dir + totalSkyboxes) % totalSkyboxes;
        hdrLoader.load(`skybox_${next}.hdr`, (tex) => {
            tex.mapping = THREE.EquirectangularReflectionMapping;
            scene.background = scene.environment = tex;
            customOceanMaterial.uniforms.uEnvMap.value = tex;
            currentSkyboxIndex = next;
            targetBloom    = next >= 3 ? 0.0 : 0.05;
            targetExposure = 0.95;
            setTimeout(() => { isTransitioning = false; }, 500);
        });
    }, 400);
}
hdrLoader.load(`skybox_${currentSkyboxIndex}.hdr`, (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = scene.environment = tex;
    customOceanMaterial.uniforms.uEnvMap.value = tex;
});

// ─────────────────────────────────────────────
// 8. LIGHTING
// ─────────────────────────────────────────────

// HemisphereLight provides sky/ground ambient fill so model undersides
// are never pitch-black — matches what the HDRI environment suggests.
// Sky colour matches a mid-blue sky; ground colour matches dark ocean.
// Intensity kept low (0.6) so it doesn't wash out the directional shadow.
const hemiLight = new THREE.HemisphereLight(0x8ab0d0, 0x0d1a24, 0.6);
scene.add(hemiLight);

// Directional sun — intensity reduced from 3.0 → 1.8 now that the HDRI
// environment provides IBL diffuse + specular on PBR model materials.
// 3.0 was overexposing models and making them look unnatural vs the ocean.
const sunLight = new THREE.DirectionalLight(0xfff5e0, 1.8);
sunLight.position.copy(customOceanMaterial.uniforms.uSunPosition.value).multiplyScalar(100);

// Shadow camera frustum widened to ±600 so it covers nearby props even
// when the bird is flying fast and props are spread across a large area.
// 4096 shadow map gives sharper shadow edges on the ocean surface.
sunLight.castShadow              = !isMobile;
sunLight.shadow.mapSize.width    = isMobile ? 1024 : 4096;
sunLight.shadow.mapSize.height   = isMobile ? 1024 : 4096;
sunLight.shadow.camera.near      = 1;
sunLight.shadow.camera.far       = 1000;
sunLight.shadow.camera.left      = -600;
sunLight.shadow.camera.right     =  600;
sunLight.shadow.camera.top       =  600;
sunLight.shadow.camera.bottom    = -600;
sunLight.shadow.bias             = -0.0005;
sunLight.shadow.normalBias       =  0.02;
scene.add(sunLight);
scene.add(sunLight.target);   // target must be in scene for updateMatrixWorld to work

// ─────────────────────────────────────────────
// 9. AUDIO
// ─────────────────────────────────────────────
const listener   = new THREE.AudioListener();
camera.add(listener);
const oceanSound = new THREE.Audio(listener);
let audioLoaded  = false;
new THREE.AudioLoader().load('/ocean_sound.mp3', (buf) => {
    oceanSound.setBuffer(buf); oceanSound.setLoop(true); oceanSound.setVolume(0.99);
    audioLoaded = true;
});

// ─────────────────────────────────────────────
// 10. INPUT
// ─────────────────────────────────────────────
const blocker = document.getElementById('blocker');
let isSimulating = false;
let isFormation  = false;

document.getElementById('instructions').addEventListener('click', () => {
    isSimulating = true;
    blocker.style.display = 'none';
    if (listener.context.state === 'suspended') listener.context.resume();
    if (audioLoaded && !oceanSound.isPlaying) oceanSound.play();
});

const moveState = { forward: false, backward: false, left: false, right: false };
const _worldY   = new THREE.Vector3(0, 1, 0);

function toggleFormation() {
    isFormation = !isFormation;
    for (let i = 1; i < allWrappers.length; i++) {
        if (allWrappers[i]) allWrappers[i].visible = isFormation;
    }
}

document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { isSimulating = false; blocker.style.display = 'flex'; return; }
    switch (e.code) {
        case 'KeyW': moveState.forward  = true;  break;
        case 'KeyA': moveState.left     = true;  break;
        case 'KeyS': moveState.backward = true;  break;
        case 'KeyD': moveState.right    = true;  break;
        case 'KeyQ': switchSkybox(-1);           break;
        case 'KeyE': switchSkybox(1);            break;
        case 'Space': e.preventDefault(); toggleFormation(); break;
    }
});
document.addEventListener('keyup', (e) => {
    switch (e.code) {
        case 'KeyW': moveState.forward  = false; break;
        case 'KeyA': moveState.left     = false; break;
        case 'KeyS': moveState.backward = false; break;
        case 'KeyD': moveState.right    = false; break;
    }
});

const setupBtn = (id, action) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('touchstart',  (e) => { e.preventDefault(); moveState[action] = true; });
    btn.addEventListener('touchend',    (e) => { e.preventDefault(); moveState[action] = false; });
    btn.addEventListener('touchcancel', (e) => { e.preventDefault(); moveState[action] = false; });
    btn.addEventListener('mousedown',   ()  => { moveState[action] = true; });
    btn.addEventListener('mouseup',     ()  => { moveState[action] = false; });
    btn.addEventListener('mouseleave',  ()  => { moveState[action] = false; });
};
setupBtn('btn-forward', 'forward'); setupBtn('btn-backward', 'backward');
setupBtn('btn-left', 'left');       setupBtn('btn-right', 'right');

// Formation toggle button (mobile only — bottom-right)
const btnFormation = document.getElementById('btn-formation');
if (btnFormation) {
    btnFormation.addEventListener('touchstart', (e) => { e.preventDefault(); toggleFormation(); });
    btnFormation.addEventListener('mousedown',  ()  => { toggleFormation(); });
}

// ENV button — cycles skybox forward (same as keyboard E)
const btnEnv = document.getElementById('btn-env');
if (btnEnv) {
    btnEnv.addEventListener('touchstart', (e) => { e.preventDefault(); switchSkybox(1); });
    btnEnv.addEventListener('mousedown',  ()  => { switchSkybox(1); });
}

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    msaaTarget.setSize(window.innerWidth, window.innerHeight);
});

// ─────────────────────────────────────────────
// 11. CAMERA CONSTANTS
//
// Camera sits at birdGroup.local(0, H, Z) — X is always ZERO.
// X=0 means the camera is exactly on the yaw axis, so rotating birdGroup
// never swings the camera sideways. Previously CAM_X=8.5 caused the bird
// to drift to corners during turns because the camera orbited at a
// different radius to the bird's visual centre.
//
// The camera LOOKS AT birdWrapper.getWorldPosition() every frame — the
// bird's actual visual centre — so no hardcoded X offset is needed at all.
// ─────────────────────────────────────────────
const CAM_SOLO_DIST =  10.0;
const CAM_FORM_DIST =  70.0;
const CAM_SOLO_H    =   4.0;
const CAM_FORM_H    =  20.0;

let currentCamDist = CAM_SOLO_DIST;
let currentCamH    = CAM_SOLO_H;
let currentLookZ   = 0; // kept so lerp lines below still compile

const _camLocal        = new THREE.Vector3();
const _birdWorldCenter = new THREE.Vector3();


// ─────────────────────────────────────────────
// 12. ROOT-BONE LOCK
//    Runs after mixer.update() to kill root-motion translation.
//    Only zeroes bones whose immediate parent is NOT also a bone
//    (i.e. skeleton roots). All child bones (wings etc.) are untouched.
// ─────────────────────────────────────────────
function lockRootBones(model) {
    if (!model) return;
    model.traverse((child) => {
        if (child.isBone && child.parent && !child.parent.isBone) {
            child.position.set(0, 0, 0);
        }
    });
}

// ─────────────────────────────────────────────
// 13. ROOT-BONE LOCK


// ─────────────────────────────────────────────
// 14. RENDER LOOP
// ─────────────────────────────────────────────
let lastTime = 0;

function animate(currentTime) {
    requestAnimationFrame(animate);

    const t     = currentTime * 0.001;
    const delta = Math.min(lastTime === 0 ? 0 : t - lastTime, 0.05);
    lastTime    = t;

    // ── MIXERS + ROOT-MOTION LOCK ─────────────────────────────────────────
    allMixers.forEach((m, i) => {
        m.update(delta);
        lockRootBones(allWrappers[i]?.children[0] ?? null);
    });

    // ── OCEAN GRID SNAP ───────────────────────────────────────────────────
    // Snap the grid centre to the nearest TILE_SIZE multiple of birdGroup XZ.
    // Each tile then positions itself at gridCentre + its (col,row) offset.
    // Because tiles jump a full TILE_SIZE at once they are never visible mid-move.
    const snapX = Math.round(birdGroup.position.x / TILE_SIZE) * TILE_SIZE;
    const snapZ = Math.round(birdGroup.position.z / TILE_SIZE) * TILE_SIZE;
    let tileIdx = 0;
    for (let row = 0; row < GRID_DIM; row++) {
        for (let col = 0; col < GRID_DIM; col++) {
            oceans[tileIdx].position.set(
                snapX + (col - GRID_HALF) * TILE_SIZE,
                0,
                snapZ + (row - GRID_HALF) * TILE_SIZE
            );
            tileIdx++;
        }
    }

    // ── SHADER TIME ───────────────────────────────────────────────────────
    customOceanMaterial.uniforms.uTime.value = t * 1.25;
    sprayMaterial.uniforms.uTime.value       = t * 1.25;

    // ── EXPOSURE / BLOOM ──────────────────────────────────────────────────
    currentExposure += (targetExposure - currentExposure) * Math.min(delta * 8, 1);
    renderer.toneMappingExposure = currentExposure;
    currentBloom += (targetBloom - currentBloom) * Math.min(delta * 8, 1);
    bloomPass.strength = currentBloom;

    // ── CAMERA ZOOM SCALARS ───────────────────────────────────────────────
    const tDist = isFormation ? CAM_FORM_DIST : CAM_SOLO_DIST;
    const tH    = isFormation ? CAM_FORM_H    : CAM_SOLO_H;
    currentCamDist += (tDist - currentCamDist) * Math.min(delta * 3, 1);
    currentCamH    += (tH    - currentCamH)    * Math.min(delta * 3, 1);

    // ── FLIGHT ────────────────────────────────────────────────────────────
    if (isSimulating) {
        // W/S → altitude only
        if (moveState.forward)  birdGroup.position.y += 35.0 * delta;
        if (moveState.backward) birdGroup.position.y -= 35.0 * delta;

        // Continuous forward flight
        birdGroup.translateZ(-50.0 * delta);

        // COORDINATED BANK TURN: A/D set the roll target on tiltGroup.
        // The roll angle then drives yaw automatically — exactly like real
        // aircraft banking into a turn. No direct yaw on keypress means the
        // bird never jumps to a corner of the screen; it tilts first, then
        // smoothly arcs. The turn rate is proportional to the current roll.
        const targetRoll = moveState.left ? Math.PI / 5 : moveState.right ? -Math.PI / 5 : 0;
        tiltGroup.rotation.z += (targetRoll - tiltGroup.rotation.z) * delta * 4.0;
        // tiltGroup.rotation.z: positive = rolled left, negative = rolled right.
        // Negate it: rolled left → yaw left (negative world-Y rotation in Three.js = left turn)
        birdGroup.rotateOnWorldAxis(_worldY, tiltGroup.rotation.z * 0.55 * delta);

        // Pitch target
        let targetPitch = 0;
        if (moveState.forward)  targetPitch =  Math.PI / 12;
        if (moveState.backward) targetPitch = -Math.PI / 12;

        // Altitude clamp: 22 – 220
        if (birdGroup.position.y <= 22.0)  { birdGroup.position.y = 22.0;  if (targetPitch < 0) targetPitch = 0; }
        if (birdGroup.position.y >= 220.0) { birdGroup.position.y = 220.0; if (targetPitch > 0) targetPitch = 0; }

        tiltGroup.rotation.x += (targetPitch - tiltGroup.rotation.x) * delta * 4.0;

        // ── WORLD PROPS: treadmill (all directions) + bob + sparkles ─────
        // Distance check is in XZ from birdGroup (not camera Z) so the
        // treadmill works in every direction — turning around still shows
        // objects because recycled props are placed in a full 360° ring.
        let nearestPropDistSq = Infinity;
        // Also track closest BOAT for avoidance — barrels/crates/chests excluded
        let avoidPropPos = null;
        let avoidDistSq  = Infinity;
        const AVOIDANCE_RADIUS = 55;    // only triggers when genuinely close to a boat
        const AVOIDANCE_R_SQ   = AVOIDANCE_RADIUS * AVOIDANCE_RADIUS;

        propPool.forEach(prop => {
            const m  = prop.mesh;
            const dx = m.position.x - birdGroup.position.x;
            const dz = m.position.z - birdGroup.position.z;
            const dSq = dx * dx + dz * dz;

            // ── TREADMILL ─────────────────────────────────────────────────
            if (dSq > RECYCLE_DIST * RECYCLE_DIST) {
                const pos = randomPropPosition();
                m.position.set(pos.x, prop.yBase, pos.z);
                m.rotation.set(0, Math.random() * Math.PI * 2, 0);
            }

            // ── BOB ───────────────────────────────────────────────────────
            m.position.y = prop.yBase + getBobOffset(prop.bobPhase, t);

            // ── SPARKLES + CHEST GLOW ─────────────────────────────────────
            if (prop.sparklePoints) {
                const pos = prop.sparklePoints.geometry.attributes.position;
                for (let si = 0; si < SPARKLE_COUNT; si++) {
                    pos.setY(si, (pos.getY(si) + delta * 1.2) % 5.0);
                    pos.setX(si, pos.getX(si) + Math.sin(t * 1.5 + sparklePhases[si]) * 0.005);
                }
                pos.needsUpdate = true;
                sparkleMat.opacity = 0.55 + Math.sin(t * 3.0) * 0.2;
            }
            // Pulse PointLight + glow sprite together — slow drift with a
            // faster high-frequency shimmer layered on top (firelight feel).
            if (prop.chestGlow) {
                const pulse = 0.45 + Math.sin(t * 2.3 + prop.bobPhase) * 0.15
                                   + Math.sin(t * 5.7 + prop.bobPhase * 1.3) * 0.05;
                prop.chestGlow.intensity = pulse;
                // The glow sprite shares the same pulse so they feel unified.
                // SpriteMaterial opacity is per-material and shared across all
                // clones — each chest has its own cloned Sprite, but they all
                // share glowMat. We animate via the sprite's scale X instead,
                // giving each chest a subtly breathing feel independently.
                const sprite = m.children.find(c => c.isSprite);
                if (sprite) sprite.scale.set(6 + pulse * 1.5, 4 + pulse, 1);
            }

            // ── CLOSEST PROP TRACKING (scatter uses all types; avoidance boats only) ──
            if (dSq < nearestPropDistSq) nearestPropDistSq = dSq;
            const isBoat = prop.type === 'boat_1' || prop.type === 'boat_2';
            if (isBoat && dSq < avoidDistSq) { avoidDistSq = dSq; avoidPropPos = m.position; }
        });

        // ── COLLISION AVOIDANCE ───────────────────────────────────────────
        // If a prop is within AVOIDANCE_RADIUS of the bird, compute the
        // avoidance direction in birdGroup LOCAL space.
        // Only steer if the obstacle is roughly AHEAD (local Z < 0 = in front).
        // The steer is a gentle yaw push away from the obstacle's local X side,
        // and a gentle altitude push upward to clear it vertically.
        if (avoidPropPos && avoidDistSq < AVOIDANCE_R_SQ) {
            // Transform prop world position into birdGroup local space
            const localProp = birdGroup.worldToLocal(avoidPropPos.clone());

            // Only react if obstacle is ahead (negative local Z = in front of bird)
            if (localProp.z < 30) {
                const avoidStrength = 1.0 - (Math.sqrt(avoidDistSq) / AVOIDANCE_RADIUS);

                // Steer away: if prop is to the right (local X > 0) → yaw left, and vice versa
                const yawDir = localProp.x > 0 ? 1 : -1;
                birdGroup.rotateOnWorldAxis(_worldY, yawDir * avoidStrength * 1.8 * delta);

                // Nudge altitude upward to clear the obstacle
                birdGroup.position.y += avoidStrength * 25.0 * delta;
                birdGroup.position.y = Math.min(birdGroup.position.y, 220.0);
            }
        }

        // ── PROXIMITY SCATTER ─────────────────────────────────────────────
        // When the bird flies close to any prop, wingmen briefly break
        // formation and drift outward before snapping back.
        scatterCooldown = Math.max(0, scatterCooldown - delta);
        const SCATTER_R_SQ = SCATTER_RADIUS * SCATTER_RADIUS;

        if (nearestPropDistSq < SCATTER_R_SQ && !isScattering && scatterCooldown === 0) {
            isScattering = true;
            // Assign each wingman a random outward scatter target
            scatterTargets.forEach((sv, i) => {
                const side = (i % 2 === 0) ? -1 : 1;
                sv.set(side * (8 + Math.random() * 12), Math.random() * 5, Math.random() * 8);
            });
        }
        if (nearestPropDistSq > SCATTER_R_SQ * 1.5 && isScattering) {
            isScattering = false;
            scatterCooldown = 3.0;
            scatterTargets.forEach(sv => sv.set(0, 0, 0));
        }

        // Apply scatter offsets to wingmen (indices 1-4 of allWrappers)
        scatterCurrents.forEach((cur, i) => {
            cur.lerp(scatterTargets[i], delta * 3.0);
            const wrapper = allWrappers[i + 1];
            if (wrapper) {
                wrapper.position.set(
                    WRAP_BASE.x + V_OFFSETS[i + 1].x + cur.x,
                    WRAP_BASE.y + V_OFFSETS[i + 1].y + cur.y,
                    WRAP_BASE.z + V_OFFSETS[i + 1].z + cur.z
                );
            }
        });

        // Keep directional light (and its shadow camera) centred on the bird.
        // Without this the fixed shadow frustum would quickly slide off-screen
        // as the bird flies, and all prop shadows would vanish.
        sunLight.position.set(
            birdGroup.position.x + customOceanMaterial.uniforms.uSunPosition.value.x * 100,
            customOceanMaterial.uniforms.uSunPosition.value.y * 100,
            birdGroup.position.z + customOceanMaterial.uniforms.uSunPosition.value.z * 100
        );
        sunLight.target.position.copy(birdGroup.position);
        sunLight.target.updateMatrixWorld();

        // ── CAMERA ────────────────────────────────────────────────────────
        if (birdWrapper) {
            birdGroup.updateMatrixWorld(true);

            // Camera at local(0, H, dist) — X=0 keeps it on the yaw axis so
            // turning never swings the camera in a lateral arc.
            _camLocal.set(0, currentCamH, currentCamDist);
            camera.position.copy(_camLocal).applyMatrix4(birdGroup.matrixWorld);

            // Look at the bird's actual visual centre in world space.
            birdWrapper.getWorldPosition(_birdWorldCenter);
            // Nudge Y up slightly so camera looks at body, not feet.
            _birdWorldCenter.y += 8;

            camera.up.set(0, 1, 0);
            camera.lookAt(_birdWorldCenter);
            // Subtle roll to make banking feel physical — kept very small.
            camera.rotateZ(-tiltGroup.rotation.z * 0.06);
        }
    }

    composer.render();
}

requestAnimationFrame(animate);