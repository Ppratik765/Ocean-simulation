import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { RGBELoader as HDRLoader } from 'three/examples/jsm/loaders/RGBELoader.js'; 

// --- POST-PROCESSING IMPORTS ---
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import oceanVert from './shaders/ocean.vert.glsl?raw';
import oceanFrag from './shaders/ocean.frag.glsl?raw';

// 1. Scene Setup
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 20000);
camera.position.set(-200, 95, 0); 

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2; 
document.getElementById('app').appendChild(renderer.domElement);

// 2. The Ocean Material
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
const ocean = new THREE.Mesh(geometry, customOceanMaterial);
scene.add(ocean);

new HDRLoader().setPath('/textures/').load('skybox.hdr', function (texture) {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = texture;
    scene.environment = texture;
    customOceanMaterial.uniforms.uEnvMap.value = texture;
});

const sunLight = new THREE.DirectionalLight(0xffffff, 3.0);
sunLight.position.copy(customOceanMaterial.uniforms.uSunPosition.value).multiplyScalar(100); 
scene.add(sunLight);

// --- 3. CINEMATIC POST-PROCESSING (BLOOM) ---
const renderScene = new RenderPass(scene, camera);

// Resolution, Strength, Radius, Threshold
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
bloomPass.threshold = 0.99; // EXTREMELY HIGH: Only the absolute brightest sun pixels will glow
bloomPass.strength = 0.05;  // DIALED DOWN: Just a subtle optical bleed, not a massive halo
bloomPass.radius = 0.05;     // TIGHTENED: Keeps the glow very close to the light source

const outputPass = new OutputPass(); 

const composer = new EffectComposer(renderer);
composer.addPass(renderScene);
composer.addPass(bloomPass);
composer.addPass(outputPass);

// --- 4. SPATIAL AUDIO INTEGRATION ---
const listener = new THREE.AudioListener();
camera.add(listener); 

const oceanSound = new THREE.Audio(listener);
const audioLoader = new THREE.AudioLoader();

// Flags to handle the race condition
let audioLoaded = false;
let userInteracted = false;

audioLoader.load('/ocean_sound.mp3', function(buffer) {
    oceanSound.setBuffer(buffer);
    oceanSound.setLoop(true);
    oceanSound.setVolume(0.99); 
    audioLoaded = true;

    // If the user already clicked BEFORE the audio finished loading, play it now.
    if (userInteracted && listener.context.state === 'running') {
        oceanSound.play();
    }
});

// 5. WASD & Mouse Controls
const controls = new PointerLockControls(camera, renderer.domElement);
const blocker = document.getElementById('blocker');
const instructions = document.getElementById('instructions');

instructions.addEventListener('click', () => { 
    controls.lock(); 
    userInteracted = true;
    
    // CRITICAL FIX: Forcefully wake up the browser's audio engine
    if (listener.context.state === 'suspended') {
        listener.context.resume();
    }
    
    // If the audio is already loaded and ready, play it
    if (audioLoaded && !oceanSound.isPlaying) {
        oceanSound.play();
    }
});

controls.addEventListener('lock', () => { blocker.style.display = 'none'; });
controls.addEventListener('unlock', () => { blocker.style.display = 'flex'; });

const moveState = { forward: false, backward: false, left: false, right: false };
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();

document.addEventListener('keydown', (event) => {
    switch (event.code) {
        case 'KeyW': moveState.forward = true; break;
        case 'KeyA': moveState.left = true; break;
        case 'KeyS': moveState.backward = true; break;
        case 'KeyD': moveState.right = true; break;
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

// 6. The Render Loop
let lastTime = 0;
window.addEventListener('resize', onWindowResize, false);

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight); // Keep post-processing crisp
}
function animate(currentTime) {
    requestAnimationFrame(animate);
    
    const timeInSeconds = currentTime * 0.001; 
    const delta = lastTime === 0 ? 0 : timeInSeconds - lastTime;
    lastTime = timeInSeconds;

    customOceanMaterial.uniforms.uTime.value = timeInSeconds * 1.5;

    if (controls.isLocked === true) {
        velocity.x -= velocity.x * 5.0 * delta; 
        velocity.z -= velocity.z * 5.0 * delta;

        direction.z = Number(moveState.forward) - Number(moveState.backward);
        direction.x = Number(moveState.right) - Number(moveState.left);
        direction.normalize();

        const speed = 500.0; 
        if (moveState.forward || moveState.backward) velocity.z -= direction.z * speed * delta;
        if (moveState.left || moveState.right) velocity.x -= direction.x * speed * delta;

        controls.moveRight(-velocity.x * delta);
        controls.moveForward(-velocity.z * delta);
    }

    // CHANGED: We now render the scene through the Composer pipeline to get the Bloom
    composer.render();
}

requestAnimationFrame(animate);