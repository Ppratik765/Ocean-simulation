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

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);

// ─────────────────────────────────────────────
// 2. OCEAN
// ─────────────────────────────────────────────
const customOceanMaterial = new THREE.ShaderMaterial({
    vertexShader: oceanVert,
    fragmentShader: oceanFrag,
    uniforms: {
        uTime:           { value: 0 },
        uSunPosition:    { value: new THREE.Vector3(100, 50, -100).normalize() },
        uWaterColor:     { value: new THREE.Color(0x1a2b3c) },
        uWaterDeepColor: { value: new THREE.Color(0x050d14) },
        uEnvMap:         { value: null }
    }
});

const geometry = new THREE.PlaneGeometry(10000, 10000, 1024, 1024);
geometry.rotateX(-Math.PI / 2);
const oceans = [];
for (let i = 0; i < 3; i++) {
    const o = new THREE.Mesh(geometry, customOceanMaterial);
    o.position.z = -i * 10000;
    scene.add(o);
    oceans.push(o);
}

// ─────────────────────────────────────────────
// 3. SPRAY
// ─────────────────────────────────────────────
const particleCount = 250000;
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
    birdModel.rotation.y = Math.PI;   // face away from camera

    birdWrapper = new THREE.Group();
    birdWrapper.position.copy(WRAP_BASE);
    birdWrapper.add(birdModel);
    tiltGroup.add(birdWrapper);
    allWrappers.push(birdWrapper);

    if (gltf.animations?.length > 0) {
        mixer = new THREE.AnimationMixer(birdModel);
        mixer.clipAction(gltf.animations[0]).play();
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
            m.clipAction(gltf.animations[0]).play();
            // Phase-offset so wingmen don't all flap in mechanical sync
            m.update(i * 0.37);
            allMixers.push(m);
        }
    });
});

// (Trail system removed)

// ─────────────────────────────────────────────
// 6. POST-PROCESSING
// ─────────────────────────────────────────────
const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85
);
bloomPass.threshold = 0.99;
bloomPass.radius    = 0.05;
const composer = new EffectComposer(renderer);
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
const sunLight = new THREE.DirectionalLight(0xffffff, 3.0);
sunLight.position.copy(customOceanMaterial.uniforms.uSunPosition.value).multiplyScalar(100);
scene.add(sunLight);

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

document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { isSimulating = false; blocker.style.display = 'flex'; return; }
    switch (e.code) {
        case 'KeyW': moveState.forward  = true;  break;
        case 'KeyA': moveState.left     = true;  break;
        case 'KeyS': moveState.backward = true;  break;
        case 'KeyD': moveState.right    = true;  break;
        case 'KeyQ': switchSkybox(-1);           break;
        case 'KeyE': switchSkybox(1);            break;
        case 'Space':
            e.preventDefault();
            isFormation = !isFormation;
            for (let i = 1; i < allWrappers.length; i++) {
                if (allWrappers[i]) allWrappers[i].visible = isFormation;
            }
            break;
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

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

// ─────────────────────────────────────────────
// 11. CAMERA CONSTANTS
//
// These use the ORIGINAL confirmed-working formula:
//   point.applyMatrix4(birdGroup.matrixWorld)
//
// CAM_OFFSET_LOCAL: camera sits behind and slightly above the bird in its local frame.
//   X = 8.5  → laterally centres on the bird's visual spine (matches WRAP_BASE.x
//              adjusted for the GLB's internal mass centre, empirically tuned)
//   Y = -4.0 → camera is 4 units above the bird's rig origin, giving a slight
//              downward angle so the bird appears in upper-centre of screen
//   Z = (runtime) currentCamDist, positive = behind (bird flies in -Z direction)
//
// CAM_LOOKAT_LOCAL: what the camera always points at.
//   X = 8.5  → same lateral alignment as camera (bird is always screen-centre)
//   Y = -9.0 → the approximate Y centre of the bird mesh in local rig space
//   Z = -10.0→ slightly ahead of birdGroup origin (camera looks "through" the bird)
// ─────────────────────────────────────────────
const CAM_X         =  8.5;
const CAM_Y_OFFSET  = -4.0;
const CAM_LOOK_Y    = -9.0;
const CAM_LOOK_Z    = -10.0;

// Solo: close and tight.  Formation: zoomed out to frame all 5 birds.
const CAM_SOLO_DIST =  10.0;
const CAM_FORM_DIST =  70.0;
const CAM_SOLO_H    = -4.0;    // Y offset of camera (local)
const CAM_FORM_H    =  20.0;   // Y offset of camera (local) in formation

let currentCamDist = CAM_SOLO_DIST;
let currentCamH    = CAM_SOLO_H;
let currentLookZ   = CAM_LOOK_Z;   // lerped so formation toggle has no snap

// Pre-allocated vectors — allocated once, reused every frame (avoids GC)
const _camLocal    = new THREE.Vector3();
const _lookLocal   = new THREE.Vector3();


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

    // ── OCEAN TREADMILL ───────────────────────────────────────────────────
    oceans.forEach(o => { if (camera.position.z < o.position.z - 10000) o.position.z -= 30000; });

    // ── SHADER TIME ───────────────────────────────────────────────────────
    customOceanMaterial.uniforms.uTime.value = t * 1.25;
    sprayMaterial.uniforms.uTime.value       = t * 1.25;

    // ── EXPOSURE / BLOOM ──────────────────────────────────────────────────
    currentExposure += (targetExposure - currentExposure) * Math.min(delta * 8, 1);
    renderer.toneMappingExposure = currentExposure;
    currentBloom += (targetBloom - currentBloom) * Math.min(delta * 8, 1);
    bloomPass.strength = currentBloom;

    // ── CAMERA ZOOM SCALARS (lerp only the scalar, not the position) ──────
    const tDist  = isFormation ? CAM_FORM_DIST : CAM_SOLO_DIST;
    const tH     = isFormation ? CAM_FORM_H    : CAM_SOLO_H;
    const tLookZ = isFormation ? 13.0          : CAM_LOOK_Z;
    currentCamDist += (tDist  - currentCamDist) * Math.min(delta * 3, 1);
    currentCamH    += (tH     - currentCamH)    * Math.min(delta * 3, 1);
    currentLookZ   += (tLookZ - currentLookZ)   * Math.min(delta * 3, 1);

    // ── FLIGHT ────────────────────────────────────────────────────────────
    if (isSimulating) {
        // W/S → altitude only
        if (moveState.forward)  birdGroup.position.y += 35.0 * delta;
        if (moveState.backward) birdGroup.position.y -= 35.0 * delta;

        // A/D → yaw on world Y (altitude 100% unaffected)
        if (moveState.left)  birdGroup.rotateOnWorldAxis(_worldY,  1.0 * delta);
        if (moveState.right) birdGroup.rotateOnWorldAxis(_worldY, -1.0 * delta);

        // Continuous forward flight
        birdGroup.translateZ(-50.0 * delta);

        // Pitch target
        let targetPitch = 0;
        if (moveState.forward)  targetPitch =  Math.PI / 12;
        if (moveState.backward) targetPitch = -Math.PI / 12;

        // Altitude clamp: 22 – 220
        if (birdGroup.position.y <= 22.0)  { birdGroup.position.y = 22.0;  if (targetPitch < 0) targetPitch = 0; }
        if (birdGroup.position.y >= 220.0) { birdGroup.position.y = 220.0; if (targetPitch > 0) targetPitch = 0; }

        // Roll: A → anticlockwise (+Z), D → clockwise (-Z)
        const targetRoll = moveState.left ? Math.PI / 5 : moveState.right ? -Math.PI / 5 : 0;
        tiltGroup.rotation.z += (targetRoll  - tiltGroup.rotation.z) * delta * 4.0;
        tiltGroup.rotation.x += (targetPitch - tiltGroup.rotation.x) * delta * 4.0;

        // ── CAMERA ────────────────────────────────────────────────────────
        if (birdWrapper) {
            birdGroup.updateMatrixWorld(true);

            _camLocal.set(CAM_X, currentCamH, currentCamDist);
            _lookLocal.set(CAM_X, CAM_LOOK_Y, currentLookZ);   // lerped Z = no snap

            camera.position.copy(_camLocal).applyMatrix4(birdGroup.matrixWorld);
            _lookLocal.applyMatrix4(birdGroup.matrixWorld);

            camera.up.set(0, 1, 0);
            camera.lookAt(_lookLocal);
            camera.rotateZ(-tiltGroup.rotation.z * 0.08);
        }
    }

    composer.render();
}

requestAnimationFrame(animate);
