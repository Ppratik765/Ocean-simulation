import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'; 
import { RGBELoader as HDRLoader } from 'three/examples/jsm/loaders/RGBELoader.js'; 

import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import oceanVert from './shaders/ocean.vert.glsl?raw';
import oceanFrag from './shaders/ocean.frag.glsl?raw';
import sprayVert from './shaders/spray.vert.glsl?raw';
import sprayFrag from './shaders/spray.frag.glsl?raw';

// 1. Scene Setup
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 20000);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);

const customOceanMaterial = new THREE.ShaderMaterial({
    vertexShader: oceanVert,
    fragmentShader: oceanFrag,
    uniforms: {
        uTime: { value: 0 },
        uSunPosition: { value: new THREE.Vector3(100, 50, -100).normalize() }, 
        uWaterColor: { value: new THREE.Color(0x1a2b3c) },     
        uWaterDeepColor: { value: new THREE.Color(0x050d14) }, 
        uEnvMap: { value: null } 
    },
    wireframe: false 
});

const geometry = new THREE.PlaneGeometry(10000, 10000, 1024, 1024);
geometry.rotateX(-Math.PI / 2); 

// --- INFINITE OCEAN TREADMILL ---
// We create 3 massive ocean tiles that will leapfrog each other endlessly
const oceans = [];
for (let i = 0; i < 3; i++) {
    const o = new THREE.Mesh(geometry, customOceanMaterial);
    o.position.z = -i * 10000;
    scene.add(o);
    oceans.push(o);
}

const particleCount = 250000;
const sprayGeo = new THREE.BufferGeometry();
const posArray = new Float32Array(particleCount * 3);
const randomArray = new Float32Array(particleCount);
const velArray = new Float32Array(particleCount * 3);

for(let i = 0; i < particleCount; i++) {
    posArray[i * 3] = (Math.random() - 0.5) * 10000; 
    posArray[i * 3 + 1] = 0;                         
    posArray[i * 3 + 2] = (Math.random() - 0.5) * 10000; 
    randomArray[i] = Math.random();
    velArray[i * 3] = 1.5 + Math.random();       
    velArray[i * 3 + 1] = 1.0 + Math.random();   
    velArray[i * 3 + 2] = 0.5 + Math.random();   
}

sprayGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
sprayGeo.setAttribute('aRandom', new THREE.BufferAttribute(randomArray, 1));
sprayGeo.setAttribute('aVelocity', new THREE.BufferAttribute(velArray, 3));

const sprayMaterial = new THREE.ShaderMaterial({
    vertexShader: sprayVert,
    fragmentShader: sprayFrag,
    uniforms: { 
        uTime: { value: 0 },
        uWaterColor: { value: new THREE.Color(0x1a2b3c) },     
        uWaterDeepColor: { value: new THREE.Color(0x050d14) }  
    },
    transparent: true,
    depthWrite: false, 
    blending: THREE.NormalBlending 
});

const sprayParticles = new THREE.Points(sprayGeo, sprayMaterial);
scene.add(sprayParticles);

// --- 1.5 BIRD RIG & ROOT BONE LOCK ---
const birdGroup = new THREE.Group();
birdGroup.position.set(0, 75, 0); 
scene.add(birdGroup);

const tiltGroup = new THREE.Group(); 
birdGroup.add(tiltGroup);

let birdModel;
let mixer;
let birdRootBone = null;
const initialBonePos = new THREE.Vector3();
const gltfLoader = new GLTFLoader();

gltfLoader.load('/bird.glb', (gltf) => {
    birdModel = gltf.scene;
    birdModel.rotation.y = Math.PI; 
    
    // THE GHOSTING FIX: We map the exact starting coordinates of the physical skeleton.
    birdModel.traverse(child => {
        if (child.isBone && !birdRootBone) {
            birdRootBone = child;
            initialBonePos.copy(child.position);
        }
    });

    const birdWrapper = new THREE.Group();
    // Your exact requested alignment coordinates
    birdWrapper.position.set(13.0, -14.0, 0.0); 
    birdWrapper.add(birdModel);
    tiltGroup.add(birdWrapper);
    
    if (gltf.animations && gltf.animations.length > 0) {
        mixer = new THREE.AnimationMixer(birdModel);
        mixer.clipAction(gltf.animations[0]).play();
    }
});

// --- 10-SECOND VOLUMETRIC BLUE TRAIL ---
let trailMesh;
const trailPoints = [];
const trailLength = 300; // 60 frames per second * 10 seconds of flight data
const trailMat = new THREE.MeshBasicMaterial({ color: 0x00aaff, transparent: true, opacity: 0.8 });
trailMesh = new THREE.Mesh(new THREE.BufferGeometry(), trailMat);
scene.add(trailMesh);

// --- CINEMATIC POST-PROCESSING ---
const renderScene = new RenderPass(scene, camera);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
bloomPass.threshold = 0.99; 
bloomPass.radius = 0.05;    

const outputPass = new OutputPass(); 
const composer = new EffectComposer(renderer);
composer.addPass(renderScene);
composer.addPass(bloomPass);
composer.addPass(outputPass);

// --- DYNAMIC SKYBOX ENGINE ---
let currentSkyboxIndex = 0;
const totalSkyboxes = 5; 
const hdrLoader = new HDRLoader().setPath('/textures/');

let targetExposure = 0.95;
let currentExposure = 0.95;
let targetBloom = 0.05;
let currentBloom = 0.05;
let isTransitioning = false;

renderer.toneMappingExposure = currentExposure;
bloomPass.strength = currentBloom;

function switchSkybox(direction) {
    if (isTransitioning) return;
    isTransitioning = true;
    targetExposure = 0.0;
    
    setTimeout(() => {
        let nextIndex = (currentSkyboxIndex + direction + totalSkyboxes) % totalSkyboxes;
        
        hdrLoader.load(`skybox_${nextIndex}.hdr`, function (texture) {
            texture.mapping = THREE.EquirectangularReflectionMapping;
            scene.background = texture;
            scene.environment = texture;
            customOceanMaterial.uniforms.uEnvMap.value = texture;
            
            currentSkyboxIndex = nextIndex;
            targetBloom = currentSkyboxIndex >= 3 ? 0.0 : 0.05;
            targetExposure = 0.95;
            
            setTimeout(() => { isTransitioning = false; }, 500);
        });
    }, 400); 
}

hdrLoader.load(`skybox_${currentSkyboxIndex}.hdr`, function (texture) {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = texture;
    scene.environment = texture;
    customOceanMaterial.uniforms.uEnvMap.value = texture;
});

const sunLight = new THREE.DirectionalLight(0xffffff, 3.0);
sunLight.position.copy(customOceanMaterial.uniforms.uSunPosition.value).multiplyScalar(100); 
scene.add(sunLight);

const listener = new THREE.AudioListener();
camera.add(listener); 
const oceanSound = new THREE.Audio(listener);
const audioLoader = new THREE.AudioLoader();

let audioLoaded = false;
let userInteracted = false;

audioLoader.load('/ocean_sound.mp3', function(buffer) {
    oceanSound.setBuffer(buffer);
    oceanSound.setLoop(true);
    oceanSound.setVolume(0.99); 
    audioLoaded = true;
    if (userInteracted && listener.context.state === 'running') oceanSound.play();
});

// --- CONTROLS ---
const blocker = document.getElementById('blocker');
const instructions = document.getElementById('instructions');
let isSimulating = false; 

instructions.addEventListener('click', () => { 
    isSimulating = true;
    blocker.style.display = 'none';
    if (listener.context.state === 'suspended') listener.context.resume();
    if (audioLoaded && !oceanSound.isPlaying) oceanSound.play();
});

const moveState = { forward: false, backward: false, left: false, right: false };

document.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') {
        isSimulating = false;
        blocker.style.display = 'flex';
    }
    switch (event.code) {
        case 'KeyW': moveState.forward = true; break;
        case 'KeyA': moveState.left = true; break;
        case 'KeyS': moveState.backward = true; break;
        case 'KeyD': moveState.right = true; break;
        case 'KeyQ': switchSkybox(-1); break; 
        case 'KeyE': switchSkybox(1); break;  
    }
});
document.addEventListener('keyup', (event) => {
    switch (event.code) {
        case 'KeyW': moveState.forward = false; break;
        case 'KeyA': moveState.left = false; break;
        case 'KeyS': moveState.backward = false; break;
        case 'KeyD': moveState.right = false; break;
    }
});

const setupButton = (id, action) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); moveState[action] = true; });
    btn.addEventListener('touchend', (e) => { e.preventDefault(); moveState[action] = false; });
    btn.addEventListener('touchcancel', (e) => { e.preventDefault(); moveState[action] = false; });
    btn.addEventListener('mousedown', (e) => { moveState[action] = true; });
    btn.addEventListener('mouseup', (e) => { moveState[action] = false; });
    btn.addEventListener('mouseleave', (e) => { moveState[action] = false; });
};

setupButton('btn-forward', 'forward');
setupButton('btn-backward', 'backward');
setupButton('btn-left', 'left');
setupButton('btn-right', 'right');

let lastTime = 0;
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

function animate(currentTime) {
    requestAnimationFrame(animate);
    
    const timeInSeconds = currentTime * 0.001; 
    const delta = lastTime === 0 ? 0 : timeInSeconds - lastTime;
    lastTime = timeInSeconds;

    if (mixer) {
        mixer.update(delta);
        // THE RUBBER-BANDING KILLER:
        // We let the wings flap, but we forcefully lock the skeleton's root coordinate
        // back to zero every frame. It physically cannot glitch forward or backward now.
        if (birdRootBone) {
            birdRootBone.position.copy(initialBonePos);
        }
    }

    // THE INFINITE OCEAN TREADMILL LOGIC:
    // If the camera flies past the middle of an ocean tile, the tile behind it 
    // seamlessly teleports forward to extend the horizon infinitely.
    oceans.forEach(o => {
        if (camera.position.z < o.position.z - 10000) {
            o.position.z -= 30000;
        }
    });

    customOceanMaterial.uniforms.uTime.value = timeInSeconds * 1.25;
    sprayMaterial.uniforms.uTime.value = timeInSeconds * 1.25; 

    if (currentExposure !== targetExposure) {
        currentExposure += (targetExposure - currentExposure) * delta * 8.0;
        if (Math.abs(currentExposure - targetExposure) < 0.01) currentExposure = targetExposure;
        renderer.toneMappingExposure = currentExposure;
    }

    if (currentBloom !== targetBloom) {
        currentBloom += (targetBloom - currentBloom) * delta * 8.0;
        if (Math.abs(currentBloom - targetBloom) < 0.001) currentBloom = targetBloom;
        bloomPass.strength = currentBloom;
    }

    if (isSimulating) {
        // --- ARCADE FLIGHT MECHANICS ---
        const flightSpeed = 50.0; 
        const verticalSpeed = 35.0; 
        const turnSpeed = 1.0;

        // W/S only change the Y altitude directly. No physics overlap.
        if (moveState.forward) birdGroup.position.y += verticalSpeed * delta;
        if (moveState.backward) birdGroup.position.y -= verticalSpeed * delta;
        
        // A/D only rotate around the strict Global Y axis. Altitude is 100% untouched.
        if (moveState.left) birdGroup.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), turnSpeed * delta);
        if (moveState.right) birdGroup.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), -turnSpeed * delta);

        birdGroup.translateZ(-flightSpeed * delta);

        // --- PITCH & BOUNDARIES ---
        let targetPitch = 0;
        if (moveState.forward) targetPitch = Math.PI / 4;   
        if (moveState.backward) targetPitch = -Math.PI / 4; 

        // If bounds are hit, Y translation stops, and pitch immediately resets to zero to preserve the illusion
        if (birdGroup.position.y <= 12.0) {
            birdGroup.position.y = 12.0;
            if (targetPitch < 0) targetPitch = 0; 
        }
        if (birdGroup.position.y >= 180.0) {
            birdGroup.position.y = 180.0;
            if (targetPitch > 0) targetPitch = 0; 
        }

        // --- VISUAL TILT (ROLL) ---
        if (birdModel) {
            let targetRoll = 0;
            if (moveState.left) targetRoll = Math.PI / 5;   // A -> Tilt Left (Anticlockwise)
            if (moveState.right) targetRoll = -Math.PI / 5; // D -> Tilt Right (Clockwise)

            tiltGroup.rotation.z += (targetRoll - tiltGroup.rotation.z) * delta * 4.0;
            tiltGroup.rotation.x += (targetPitch - tiltGroup.rotation.x) * delta * 4.0;
        }

        // --- 10 SECOND VOLUMETRIC TRAIL ---
        // Bound exactly to your 8.5, -9.0, 0 offset so it shoots straight out of the model
        const tailOffset = new THREE.Vector3(8.6, -8.2, 0.0).applyMatrix4(tiltGroup.matrixWorld);
        trailPoints.push(tailOffset.clone());
        if (trailPoints.length > trailLength) trailPoints.shift(); 

        if (trailPoints.length > 2) {
            const curve = new THREE.CatmullRomCurve3(trailPoints);
            // 0.08 radius mimics a thick, flat 8px line perfectly without heavy plugins
            const tubeGeo = new THREE.TubeGeometry(curve, trailPoints.length, 0.03, 4, false);
            if (trailMesh.geometry) trailMesh.geometry.dispose();
            trailMesh.geometry = tubeGeo;
        }

        // --- PERFECT CENTERED CAMERA FOLLOW ---
        const idealOffset = new THREE.Vector3(8.5, -4.0, 10.0); 
        const idealLookAt = new THREE.Vector3(8.5, -9.0, -10.0);
        
        const currentOffset = idealOffset.applyMatrix4(birdGroup.matrixWorld);
        const currentLookAt = idealLookAt.applyMatrix4(birdGroup.matrixWorld);
        
        camera.position.copy(currentOffset);
        camera.up.set(0, 1, 0); 
        camera.lookAt(currentLookAt);
    }

    composer.render();
}

requestAnimationFrame(animate);
