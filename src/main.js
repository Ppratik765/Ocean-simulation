import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader as HDRLoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// ── FFT Ocean imports ────────────────────────────────────────────────────────
import { GPUOcean } from './gpgpu/gpuOcean.js';
import { createOceanMaterial, updateOceanMaterial } from './oceanMaterial.js';
import { OceanReadback } from './oceanReadback.js';

import sprayVert from './shaders/spray.vert.glsl?raw';
import sprayFrag from './shaders/spray.frag.glsl?raw';

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 20000);

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
              || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.1 : 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = !isMobile;
renderer.shadowMap.type    = THREE.PCFShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

// ─── FFT OCEAN SETUP ─────────────────────────────────────────────────────────
//
// Replaces the old 9-tile Gerstner LOD grid with a single high-density plane
// driven by a multi-cascade GPGPU FFT compute pipeline.
//
// The plane follows the camera on the XZ plane every frame, creating the
// illusion of an infinite ocean. The GPGPU textures tile seamlessly because
// they are computed in the spectral domain.
//

// 1. Initialise the GPGPU pipeline
const gpuOcean = new GPUOcean(renderer);

// 2. Sun direction (shared between ocean material and old lighting)
const sunDirection = new THREE.Vector3(100, 50, -100).normalize();

// 3. Create the ocean material (MeshPhysicalMaterial + onBeforeCompile)
const oceanMaterial = createOceanMaterial({
    displacementMap: gpuOcean.getDisplacementTexture(),
    normalJacobianMap: gpuOcean.getNormalJacobianTexture(),
    oceanSize: gpuOcean.primaryPatchSize,
    sunDirection: sunDirection,
});

// 4. Single dense plane geometry
const OCEAN_PLANE_SIZE = 10000;
const OCEAN_SEGMENTS   = isMobile ? 256 : 512;
const oceanGeo = new THREE.PlaneGeometry(
    OCEAN_PLANE_SIZE, OCEAN_PLANE_SIZE,
    OCEAN_SEGMENTS, OCEAN_SEGMENTS
);
oceanGeo.rotateX(-Math.PI / 2);

const oceanMesh = new THREE.Mesh(oceanGeo, oceanMaterial);
oceanMesh.receiveShadow = !isMobile;
oceanMesh.frustumCulled = false; // Always render — it fills the entire view
scene.add(oceanMesh);

// 5. Height readback for physics sync
const oceanReadback = new OceanReadback(renderer, gpuOcean.primaryPatchSize);

// ─── SPRAY ───────────────────────────────────────────────────────────────────
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
    vertexShader: sprayVert, fragmentShader: sprayFrag,
    uniforms: {
        uTime:              { value: 0 },
        uWaterColor:        { value: new THREE.Color(0x1a2b3c) },
        uWaterDeepColor:    { value: new THREE.Color(0x050d14) },
        uDisplacementMap:   { value: null },
        uNormalJacobianMap: { value: null },
        uOceanSize:         { value: gpuOcean.primaryPatchSize },
    },
    transparent: true, depthWrite: false, blending: THREE.NormalBlending
});
scene.add(new THREE.Points(sprayGeo, sprayMaterial));

// ─── BIRD RIG ─────────────────────────────────────────────────────────────────
const V_OFFSETS = [
    new THREE.Vector3(  0,  0,   0),
    new THREE.Vector3(-14,  1,  13),
    new THREE.Vector3( 14,  1,  13),
    new THREE.Vector3(-28,  2,  26),
    new THREE.Vector3( 28,  2,  26),
];
const WRAP_BASE = new THREE.Vector3(13.0, -14.0, 0.0);
const birdGroup = new THREE.Group();
birdGroup.position.set(0, 75, 0);
scene.add(birdGroup);
const tiltGroup = new THREE.Group();
birdGroup.add(tiltGroup);
let birdWrapper = null, birdModel = null, mixer = null, birdLoaded = false;
const allWrappers = [], allMixers = [];

const gltfLoader = new GLTFLoader();
gltfLoader.load('/bird.glb', (gltf) => {
    if (birdLoaded) return;
    birdLoaded = true;
    const rawClones = [];
    for (let i = 1; i < V_OFFSETS.length; i++) rawClones.push(SkeletonUtils.clone(gltf.scene));

    birdModel = gltf.scene;
    birdModel.rotation.y = Math.PI;
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
        const a = mixer.clipAction(gltf.animations[0]);
        a.timeScale = 0.5; a.play();
        allMixers.push(mixer);
    }
    rawClones.forEach((cloneScene, idx) => {
        const i = idx + 1;
        cloneScene.rotation.y = Math.PI;
        const wrapper = new THREE.Group();
        wrapper.position.set(WRAP_BASE.x + V_OFFSETS[i].x, WRAP_BASE.y + V_OFFSETS[i].y, WRAP_BASE.z + V_OFFSETS[i].z);
        wrapper.add(cloneScene); wrapper.visible = false;
        tiltGroup.add(wrapper); allWrappers.push(wrapper);
        if (gltf.animations?.length > 0) {
            const m = new THREE.AnimationMixer(cloneScene);
            const a = m.clipAction(gltf.animations[0]);
            a.timeScale = 0.5; a.play(); m.update(i * 0.37);
            allMixers.push(m);
        }
    });
});

// ─── WORLD PROPS ─────────────────────────────────────────────────────────────
// getBobOffset is now a fallback — props primarily use GPU readback heights
function getBobOffset(phase, t) { return Math.sin(t * 0.4 + phase) * 1.5; }

const PROP_DISTRIBUTION = [
    { file: 'boat_1',         count: 3, scale: 0.6,  yBase: -6.0 },
    { file: 'boat_2',         count: 3, scale: 0.6,  yBase: -6.0 },
    { file: 'barrel',         count: 4, scale: 1.8,  yBase: -1.2 },
    { file: 'crate',          count: 4, scale: 1.3,  yBase: -1.2 },
    { file: 'treasure_chest', count: 4, scale: 1.6,  yBase: -1.2 },
];
const SPAWN_MIN_DIST = 400, SPAWN_MAX_DIST = 3000, RECYCLE_DIST = 3200;
const propPool = [];
function randomPropPosition() {
    const angle = Math.random() * Math.PI * 2;
    const dist  = SPAWN_MIN_DIST + Math.random() * (SPAWN_MAX_DIST - SPAWN_MIN_DIST);
    return { x: birdGroup.position.x + Math.cos(angle) * dist,
             z: birdGroup.position.z + Math.sin(angle) * dist };
}

const glowCanvas = document.createElement('canvas');
glowCanvas.width = glowCanvas.height = 128;
const glowCtx = glowCanvas.getContext('2d');
const glowGrad = glowCtx.createRadialGradient(64,64,0,64,64,64);
glowGrad.addColorStop(0.0, 'rgba(255,200, 50,0.55)');
glowGrad.addColorStop(0.3, 'rgba(255,160, 20,0.25)');
glowGrad.addColorStop(1.0, 'rgba(255,120,  0,0.00)');
glowCtx.fillStyle = glowGrad; glowCtx.fillRect(0,0,128,128);
const glowMat = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(glowCanvas),
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true
});
const glowSprite = new THREE.Sprite(glowMat);
glowSprite.scale.set(6,4,1); glowSprite.position.set(0,2.2,0);

const SPARKLE_COUNT = 40;
const sparkleGeo    = new THREE.BufferGeometry();
const sparklePos    = new Float32Array(SPARKLE_COUNT * 3);
const sparklePhases = new Float32Array(SPARKLE_COUNT);
for (let i = 0; i < SPARKLE_COUNT; i++) {
    sparklePos[i*3] = (Math.random()-0.5)*3; sparklePos[i*3+1] = Math.random()*4; sparklePos[i*3+2] = (Math.random()-0.5)*3;
    sparklePhases[i] = Math.random() * Math.PI * 2;
}
sparkleGeo.setAttribute('position', new THREE.BufferAttribute(sparklePos, 3));
const sparkleMat = new THREE.PointsMaterial({
    color: 0xffd700, size: 0.35, transparent: true, opacity: 0.75,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
});

let creakBuffer = null;
const listener = new THREE.AudioListener();
camera.add(listener);

PROP_DISTRIBUTION.forEach(typeDef => {
    gltfLoader.load(`/${typeDef.file}.glb`, (gltf) => {
        const template = gltf.scene;
        template.scale.setScalar(typeDef.scale);
        const maxAni = renderer.capabilities.getMaxAnisotropy();
        template.traverse(child => {
            if (child.isMesh && child.material) {
                child.castShadow = child.receiveShadow = true;
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach(mat => {
                    ['map','normalMap','roughnessMap','metalnessMap','aoMap','emissiveMap'].forEach(k => {
                        if (mat[k]) { mat[k].anisotropy = maxAni; mat[k].needsUpdate = true; }
                    });
                    if (mat.envMapIntensity !== undefined) mat.envMapIntensity = 1.0;
                    mat.needsUpdate = true;
                });
            }
        });
        const isBoat = typeDef.file === 'boat_1' || typeDef.file === 'boat_2';
        for (let n = 0; n < typeDef.count; n++) {
            const mesh = template.clone(true);
            const pos  = randomPropPosition();
            mesh.position.set(pos.x, typeDef.yBase, pos.z);
            mesh.rotation.set(0, Math.random() * Math.PI * 2, 0);
            scene.add(mesh);
            let sparklePoints = null, chestGlow = null, creak = null;
            if (typeDef.file === 'treasure_chest') {
                const geo = sparkleGeo.clone();
                sparklePoints = new THREE.Points(geo, sparkleMat);
                sparklePoints.position.y = 1.5;
                mesh.add(sparklePoints);
                mesh.add(glowSprite.clone());
                if (!isMobile) {
                    chestGlow = new THREE.PointLight(0xffaa00, 0.5, 20, 2);
                    chestGlow.position.set(0, 2.0, 0);
                    mesh.add(chestGlow);
                }
            }
            if (isBoat) {
                creak = new THREE.PositionalAudio(listener);
                creak.setLoop(true);
                creak.setVolume(0.99);
                creak.setRefDistance(40);
                creak.setRolloffFactor(1.5);
                creak.setMaxDistance(350);
                creak._startOffset = Math.random() * 4.53;
                mesh.add(creak);
                if (creakBuffer) creak.setBuffer(creakBuffer);
            }
            propPool.push({ mesh, type: typeDef.file, yBase: typeDef.yBase,
                            bobPhase: Math.random() * Math.PI * 2,
                            sparklePoints, chestGlow, creak });
        }
    });
});

const SCATTER_RADIUS  = 180;
const scatterTargets  = Array.from({ length: 4 }, () => new THREE.Vector3());
const scatterCurrents = Array.from({ length: 4 }, () => new THREE.Vector3());
let   isScattering    = false, scatterCooldown = 0;

// ─── POST-PROCESSING ──────────────────────────────────────────────────────────
const msaaTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    samples:    isMobile ? 2 : 4,
    type:       THREE.HalfFloatType,
    colorSpace: renderer.outputColorSpace
});

const bloomRes = new THREE.Vector2(
    Math.floor(window.innerWidth  * 0.5),
    Math.floor(window.innerHeight * 0.5)
);
const bloomPass = new UnrealBloomPass(bloomRes, 1.5, 0.4, 0.85);
bloomPass.threshold = 0.99; bloomPass.radius = 0.04;

const composer = new EffectComposer(renderer, msaaTarget);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ─── SKYBOX ───────────────────────────────────────────────────────────────────
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();

let currentSkyboxIndex = 0;
const totalSkyboxes = 5;
const hdrLoader = new HDRLoader().setPath('/textures/');
let targetExposure = 0.95, currentExposure = 0.95;
let targetBloom = 0.05,    currentBloom    = 0.05;
let isTransitioning = false;
renderer.toneMappingExposure = currentExposure;
bloomPass.strength = currentBloom;

function applySkybox(tex) {
    tex.mapping       = THREE.EquirectangularReflectionMapping;
    scene.background  = tex;
    scene.environment = pmremGenerator.fromEquirectangular(tex).texture;
    // The MeshPhysicalMaterial automatically picks up scene.environment
}

function switchSkybox(dir) {
    if (isTransitioning) return;
    isTransitioning = true; targetExposure = 0.0;
    setTimeout(() => {
        const next = (currentSkyboxIndex + dir + totalSkyboxes) % totalSkyboxes;
        hdrLoader.load(`skybox_${next}.hdr`, (tex) => {
            applySkybox(tex);
            currentSkyboxIndex = next;
            targetBloom = next >= 3 ? 0.0 : 0.05; targetExposure = 0.95;
            setTimeout(() => { isTransitioning = false; }, 500);
        });
    }, 400);
}
hdrLoader.load(`skybox_0.hdr`, applySkybox);

// ─── LIGHTING ─────────────────────────────────────────────────────────────────
scene.add(new THREE.HemisphereLight(0x8ab0d0, 0x0d1a24, 0.6));
const sunLight = new THREE.DirectionalLight(0xfff5e0, 1.8);
sunLight.position.copy(sunDirection).multiplyScalar(100);
sunLight.castShadow           = !isMobile;
sunLight.shadow.mapSize.width = sunLight.shadow.mapSize.height = 1024;
sunLight.shadow.camera.near   = 1;    sunLight.shadow.camera.far    = 1000;
sunLight.shadow.camera.left   = -200; sunLight.shadow.camera.right  =  200;
sunLight.shadow.camera.top    =  200; sunLight.shadow.camera.bottom = -200;
sunLight.shadow.bias = -0.0005; sunLight.shadow.normalBias = 0.02;
scene.add(sunLight); scene.add(sunLight.target);

// ─── AUDIO ────────────────────────────────────────────────────────────────────
let audioStarted = false;

const oceanSound = new THREE.Audio(listener);
let   audioReady = false;
new THREE.AudioLoader().load('/ocean_sound.mp3', (buf) => {
    oceanSound.setBuffer(buf); oceanSound.setLoop(true); oceanSound.setVolume(0.90);
    audioReady = true;
    if (audioStarted && !oceanSound.isPlaying) oceanSound.play();
});

const SEAGULL_POOL = 3;
const seagullSounds = [];
let   seagullBuf    = null;
let   seagullTimer  = 4 + Math.random() * 4;
let   seagullIdx    = 0;
new THREE.AudioLoader().load('/Seagull_sound.m4a', (buf) => {
    seagullBuf = buf;
    for (let i = 0; i < SEAGULL_POOL; i++) {
        const s = new THREE.Audio(listener);
        s.setBuffer(buf); s.setLoop(false);
        seagullSounds.push(s);
    }
});
function playSeagull() {
    if (!seagullBuf || !seagullSounds.length) return;
    const s = seagullSounds[seagullIdx++ % SEAGULL_POOL];
    if (s.isPlaying) s.stop();
    s.setPlaybackRate(0.80 + Math.random() * 0.38);
    s.setVolume(0.50 + Math.random() * 0.35);
    s.play();
}

const FLAP_PERIOD = 0.875;
let   flapTimer   = FLAP_PERIOD * 0.5;
const flapSound   = new THREE.Audio(listener);
let   flapBuf     = null;
new THREE.AudioLoader().load('/wind_flapping.m4a', (buf) => {
    flapBuf = buf;
    flapSound.setBuffer(buf); flapSound.setLoop(false); flapSound.setVolume(0.60);
});
function playFlap() {
    if (!flapBuf) return;
    if (flapSound.isPlaying) flapSound.stop();
    flapSound.setPlaybackRate(0.97 + Math.random() * 0.06);
    flapSound.play();
}

new THREE.AudioLoader().load('/wood_creaking.m4a', (buf) => {
    creakBuffer = buf;
    propPool.forEach(prop => {
        if (prop.creak && !prop.creak.buffer) {
            prop.creak.setBuffer(buf);
            if (audioStarted && !prop.creak.isPlaying)
                prop.creak.play(prop.creak._startOffset ?? 0);
        }
    });
});

function startAudio() {
    if (audioStarted) return;
    audioStarted = true;
    if (listener.context.state === 'suspended') listener.context.resume();
    if (audioReady && !oceanSound.isPlaying) oceanSound.play();
    propPool.forEach(prop => {
        if (prop.creak?.buffer && !prop.creak.isPlaying)
            prop.creak.play(prop.creak._startOffset ?? 0);
    });
}

// ─── INPUT ────────────────────────────────────────────────────────────────────
const blocker = document.getElementById('blocker');
let isSimulating = false, isFormation = false;
document.getElementById('instructions').addEventListener('click', () => {
    isSimulating = true; blocker.style.display = 'none'; startAudio();
});

const moveState = { forward: false, backward: false, left: false, right: false };
const _worldY   = new THREE.Vector3(0, 1, 0);

function toggleFormation() {
    isFormation = !isFormation;
    for (let i = 1; i < allWrappers.length; i++)
        if (allWrappers[i]) allWrappers[i].visible = isFormation;
}

document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { isSimulating = false; blocker.style.display = 'flex'; return; }
    switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':    moveState.forward  = true;  break;
        case 'KeyA':
        case 'ArrowLeft':  moveState.left     = true;  break;
        case 'KeyS':
        case 'ArrowDown':  moveState.backward = true;  break;
        case 'KeyD':
        case 'ArrowRight': moveState.right    = true;  break;
        case 'KeyQ':       switchSkybox(-1);           break;
        case 'KeyE':       switchSkybox(1);            break;
        case 'Space':      e.preventDefault(); toggleFormation(); break;
    }
});
document.addEventListener('keyup', (e) => {
    switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':    moveState.forward  = false; break;
        case 'KeyA':
        case 'ArrowLeft':  moveState.left     = false; break;
        case 'KeyS':
        case 'ArrowDown':  moveState.backward = false; break;
        case 'KeyD':
        case 'ArrowRight': moveState.right    = false; break;
    }
});

const setupBtn = (id, action) => {
    const btn = document.getElementById(id); if (!btn) return;
    btn.addEventListener('touchstart',  (e) => { e.preventDefault(); moveState[action] = true;  });
    btn.addEventListener('touchend',    (e) => { e.preventDefault(); moveState[action] = false; });
    btn.addEventListener('touchcancel', (e) => { e.preventDefault(); moveState[action] = false; });
    btn.addEventListener('mousedown',   ()  => { moveState[action] = true;  });
    btn.addEventListener('mouseup',     ()  => { moveState[action] = false; });
    btn.addEventListener('mouseleave',  ()  => { moveState[action] = false; });
};
setupBtn('btn-forward','forward'); setupBtn('btn-backward','backward');
setupBtn('btn-left','left');       setupBtn('btn-right','right');

const btnF = document.getElementById('btn-formation');
if (btnF) { btnF.addEventListener('touchstart',(e)=>{e.preventDefault();toggleFormation();}); btnF.addEventListener('mousedown',toggleFormation); }
const btnE = document.getElementById('btn-env');
if (btnE) { btnE.addEventListener('touchstart',(e)=>{e.preventDefault();switchSkybox(1);}); btnE.addEventListener('mousedown',()=>switchSkybox(1)); }

// ─── TAB VISIBILITY (AUDIO PAUSE) ─────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (listener.context.state === 'running') {
            listener.context.suspend();
        }
    } else {
        if (isSimulating && listener.context.state === 'suspended') {
            listener.context.resume();
        }
    }
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    msaaTarget.setSize(window.innerWidth, window.innerHeight);
    bloomPass.setSize(
        Math.floor(window.innerWidth  * 0.5),
        Math.floor(window.innerHeight * 0.5)
    );
});

// ─── CAMERA CONSTANTS ─────────────────────────────────────────────────────────
const CAM_X         =  8.5;
const CAM_LOOK_Y    = -9.0;
const CAM_LOOK_Z    = -10.0;
const CAM_SOLO_DIST =  10.0, CAM_FORM_DIST =  70.0;
const CAM_SOLO_H    =  -4.0, CAM_FORM_H    =  20.0;
let currentCamDist = CAM_SOLO_DIST, currentCamH = CAM_SOLO_H, currentLookZ = CAM_LOOK_Z;
const _camLocal = new THREE.Vector3(), _lookLocal = new THREE.Vector3();

// ─── ROOT-BONE LOCK ───────────────────────────────────────────────────────────
function lockRootBones(model) {
    if (!model) return;
    model.traverse(child => {
        if (child.isBone && child.parent && !child.parent.isBone) child.position.set(0,0,0);
    });
}

// ─── RENDER LOOP ──────────────────────────────────────────────────────────────
const TARGET_FRAME_MS = 1000 / 60;
let lastTime      = 0;
let lastFrameTime = 0;
let _sparkleFrame = 0;

// Prop readback stagger counter — different props read at different frames
let _propReadbackCounter = 0;

function animate(currentTime) {
    requestAnimationFrame(animate);
    if (currentTime - lastFrameTime < TARGET_FRAME_MS - 0.5) return;
    lastFrameTime = currentTime;

    const t     = currentTime * 0.001;
    const delta = Math.min(lastTime === 0 ? 0 : t - lastTime, 0.05);
    lastTime = t;

    allMixers.forEach((m, i) => { m.update(delta); lockRootBones(allWrappers[i]?.children[0] ?? null); });

    // ── FFT OCEAN UPDATE ─────────────────────────────────────────────────────
    // 1. Run the GPGPU compute pipeline
    gpuOcean.update(t);

    // 2. Update ocean material textures
    updateOceanMaterial(oceanMaterial, {
        time: t,
        displacementMap: gpuOcean.getDisplacementTexture(),
        normalJacobianMap: gpuOcean.getNormalJacobianTexture(),
    });

    // 3. Update spray uniforms
    sprayMaterial.uniforms.uTime.value = t;
    sprayMaterial.uniforms.uDisplacementMap.value = gpuOcean.getDisplacementTexture();
    sprayMaterial.uniforms.uNormalJacobianMap.value = gpuOcean.getNormalJacobianTexture();

    // 4. Snap ocean plane to camera XZ position (infinite ocean illusion)
    oceanMesh.position.x = birdGroup.position.x;
    oceanMesh.position.z = birdGroup.position.z;
    oceanMesh.position.y = 0;

    // ── EXPOSURE / BLOOM TRANSITIONS ─────────────────────────────────────────
    currentExposure += (targetExposure - currentExposure) * Math.min(delta * 8, 1);
    renderer.toneMappingExposure = currentExposure;
    currentBloom += (targetBloom - currentBloom) * Math.min(delta * 8, 1);
    bloomPass.strength = currentBloom;

    const tDist = isFormation ? CAM_FORM_DIST : CAM_SOLO_DIST;
    const tH    = isFormation ? CAM_FORM_H    : CAM_SOLO_H;
    const tLZ   = isFormation ? 13.0          : CAM_LOOK_Z;
    currentCamDist += (tDist - currentCamDist) * Math.min(delta * 3, 1);
    currentCamH    += (tH    - currentCamH)    * Math.min(delta * 3, 1);
    currentLookZ   += (tLZ   - currentLookZ)   * Math.min(delta * 3, 1);

    if (isSimulating) {

        propPool.forEach(prop => {
            if (prop.creak?.buffer && !prop.creak.isPlaying)
                prop.creak.play(prop.creak._startOffset ?? 0);
        });

        seagullTimer -= delta;
        if (seagullTimer <= 0) {
            playSeagull();
            seagullTimer = 3 + Math.random() * 6;
        }

        flapTimer -= delta;
        if (flapTimer <= 0) {
            playFlap();
            flapTimer = FLAP_PERIOD * (0.9 + Math.random() * 0.2);
        }

        if (moveState.forward)  birdGroup.position.y += 35.0 * delta;
        if (moveState.backward) birdGroup.position.y -= 35.0 * delta;
        birdGroup.translateZ(-50.0 * delta);

        const targetRoll = moveState.left ? Math.PI/5 : moveState.right ? -Math.PI/5 : 0;
        tiltGroup.rotation.z += (targetRoll - tiltGroup.rotation.z) * delta * 4.0;
        birdGroup.rotateOnWorldAxis(_worldY, tiltGroup.rotation.z * 0.55 * delta);

        let targetPitch = 0;
        if (moveState.forward)  targetPitch =  Math.PI/12;
        if (moveState.backward) targetPitch = -Math.PI/12;

        // ── GPU-driven altitude limit ────────────────────────────────────────
        // Read the actual wave height beneath the bird from the GPGPU texture
        const displacementTex = gpuOcean.getDisplacementTexture();
        const birdWaveHeight = displacementTex
            ? oceanReadback.sample(displacementTex, birdGroup.position.x, birdGroup.position.z, 3)
            : 0;
        const minAltitude = Math.max(22.0, birdWaveHeight + 15.0);

        if (birdGroup.position.y <= minAltitude)  { birdGroup.position.y = minAltitude;  if (targetPitch < 0) targetPitch = 0; }
        if (birdGroup.position.y >= 220.0) { birdGroup.position.y = 220.0; if (targetPitch > 0) targetPitch = 0; }
        tiltGroup.rotation.x += (targetPitch - tiltGroup.rotation.x) * delta * 4.0;

        let nearestPropDistSq = Infinity, avoidPropPos = null, avoidDistSq = Infinity;
        const AVOID_R = 55, AVOID_RSQ = AVOID_R * AVOID_R;
        _sparkleFrame++;
        _propReadbackCounter++;

        propPool.forEach((prop, propIdx) => {
            const m = prop.mesh;
            const dx = m.position.x - birdGroup.position.x;
            const dz = m.position.z - birdGroup.position.z;
            const dSq = dx*dx + dz*dz;

            if (dSq > RECYCLE_DIST * RECYCLE_DIST) {
                const pos = randomPropPosition();
                m.position.set(pos.x, prop.yBase, pos.z);
                m.rotation.set(0, Math.random() * Math.PI * 2, 0);
            }

            // ── GPU-driven prop bobbing ──────────────────────────────────────
            // Stagger readback: each prop reads every 6th frame on a different offset
            if (displacementTex && ((_propReadbackCounter + propIdx) % 6 === 0)) {
                const propWaveHeight = oceanReadback.sample(displacementTex, m.position.x, m.position.z, 1);
                prop._lastWaveHeight = propWaveHeight;
            }
            const waveH = prop._lastWaveHeight ?? 0;
            m.position.y = prop.yBase + waveH + getBobOffset(prop.bobPhase, t) * 0.3;

            // Sparkle update throttled to every other frame
            if (prop.sparklePoints && (_sparkleFrame & 1) === 0) {
                const pos = prop.sparklePoints.geometry.attributes.position;
                for (let si = 0; si < SPARKLE_COUNT; si++) {
                    pos.setY(si, (pos.getY(si) + delta * 2.4) % 5.0);
                    pos.setX(si, pos.getX(si) + Math.sin(t*1.5 + sparklePhases[si]) * 0.005);
                }
                pos.needsUpdate = true;
                sparkleMat.opacity = 0.55 + Math.sin(t*3.0) * 0.2;
            }
            if (prop.chestGlow) {
                const pulse = 0.45 + Math.sin(t*2.3 + prop.bobPhase)*0.15 + Math.sin(t*5.7 + prop.bobPhase*1.3)*0.05;
                prop.chestGlow.intensity = pulse;
                const sprite = m.children.find(c => c.isSprite);
                if (sprite) sprite.scale.set(6 + pulse*1.5, 4 + pulse, 1);
            }

            if (dSq < nearestPropDistSq) nearestPropDistSq = dSq;
            const isBoat = prop.type === 'boat_1' || prop.type === 'boat_2';
            if (isBoat && dSq < avoidDistSq) { avoidDistSq = dSq; avoidPropPos = m.position; }
        });

        if (avoidPropPos && avoidDistSq < AVOID_RSQ) {
            const lp = birdGroup.worldToLocal(avoidPropPos.clone());
            if (lp.z < 30) {
                const str = 1.0 - Math.sqrt(avoidDistSq) / AVOID_R;
                birdGroup.rotateOnWorldAxis(_worldY, (lp.x > 0 ? 1 : -1) * str * 1.8 * delta);
                birdGroup.position.y = Math.min(birdGroup.position.y + str*25*delta, 220);
            }
        }

        scatterCooldown = Math.max(0, scatterCooldown - delta);
        const SCATTER_RSQ = SCATTER_RADIUS * SCATTER_RADIUS;
        if (nearestPropDistSq < SCATTER_RSQ && !isScattering && scatterCooldown === 0) {
            isScattering = true;
            scatterTargets.forEach((sv, i) => { const s=(i%2===0)?-1:1; sv.set(s*(8+Math.random()*12),Math.random()*5,Math.random()*8); });
        }
        if (nearestPropDistSq > SCATTER_RSQ * 1.5 && isScattering) {
            isScattering = false; scatterCooldown = 3.0;
            scatterTargets.forEach(sv => sv.set(0,0,0));
        }
        scatterCurrents.forEach((cur, i) => {
            cur.lerp(scatterTargets[i], delta * 3.0);
            const w = allWrappers[i+1];
            if (w) w.position.set(WRAP_BASE.x+V_OFFSETS[i+1].x+cur.x, WRAP_BASE.y+V_OFFSETS[i+1].y+cur.y, WRAP_BASE.z+V_OFFSETS[i+1].z+cur.z);
        });

        sunLight.position.set(
            birdGroup.position.x + sunDirection.x * 100,
            sunDirection.y * 100,
            birdGroup.position.z + sunDirection.z * 100
        );
        sunLight.target.position.copy(birdGroup.position);
        sunLight.target.updateMatrixWorld();

        if (birdWrapper) {
            birdGroup.updateMatrixWorld(true);
            _camLocal.set(CAM_X, currentCamH, currentCamDist);
            _lookLocal.set(CAM_X, CAM_LOOK_Y, currentLookZ);
            camera.position.copy(_camLocal).applyMatrix4(birdGroup.matrixWorld);
            _lookLocal.applyMatrix4(birdGroup.matrixWorld);
            camera.up.set(0,1,0);
            camera.lookAt(_lookLocal);
            camera.rotateZ(-tiltGroup.rotation.z * 0.08);
        }
    }

    composer.render();
}

requestAnimationFrame(animate);
