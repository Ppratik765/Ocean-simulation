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

new HDRLoader().setPath('/textures/').load('skybox_1.hdr', function (texture) {
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

// 5. UNIFIED DESKTOP & MOBILE CONTROLS
const controls = new PointerLockControls(camera, renderer.domElement);
const blocker = document.getElementById('blocker');
const instructions = document.getElementById('instructions');

// State tracker to allow movement on mobile without PointerLock
let isSimulating = false; 

instructions.addEventListener('click', () => { 
    // On desktop, this locks the mouse. On mobile, it often fails silently but that's fine.
    controls.lock(); 
    isSimulating = true;
    blocker.style.display = 'none';

    if (listener.context.state === 'suspended') {
        listener.context.resume();
    }
    if (audioLoaded && !oceanSound.isPlaying) {
        oceanSound.play();
    }
});

controls.addEventListener('unlock', () => { 
    blocker.style.display = 'flex'; 
    isSimulating = false; // Stop movement if unlocked
});

// Movement state
const moveState = { forward: false, backward: false, left: false, right: false };
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();

// --- DESKTOP KEYBOARD ---
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

// --- MOBILE TOUCH-TO-LOOK ---
let touchX = 0;
let touchY = 0;
const lookSensitivity = 0.003;
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

document.addEventListener('touchstart', (e) => {
    // Only register touch if it's on the canvas (not on the buttons)
    if (e.touches.length > 0 && e.target.tagName === 'CANVAS') {
        touchX = e.touches[0].pageX;
        touchY = e.touches[0].pageY;
    }
}, { passive: false });

document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 0 && e.target.tagName === 'CANVAS' && isSimulating) {
        e.preventDefault(); // Prevent scrolling the page
        
        const deltaX = e.touches[0].pageX - touchX;
        const deltaY = e.touches[0].pageY - touchY;
        
        touchX = e.touches[0].pageX;
        touchY = e.touches[0].pageY;

        // Rotate camera manually
        euler.setFromQuaternion(camera.quaternion);
        euler.y -= deltaX * lookSensitivity;
        euler.x -= deltaY * lookSensitivity;
        euler.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, euler.x)); // Prevent flipping upside down
        camera.quaternion.setFromEuler(euler);
    }
}, { passive: false });

// --- MOBILE UI BUTTON WIRING ---
const setupButton = (id, action) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    
    // Handle touch interactions
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); moveState[action] = true; });
    btn.addEventListener('touchend', (e) => { e.preventDefault(); moveState[action] = false; });
    btn.addEventListener('touchcancel', (e) => { e.preventDefault(); moveState[action] = false; });
    
    // Handle mouse clicks on the UI for testing on desktop
    btn.addEventListener('mousedown', (e) => { moveState[action] = true; });
    btn.addEventListener('mouseup', (e) => { moveState[action] = false; });
    btn.addEventListener('mouseleave', (e) => { moveState[action] = false; });
};

setupButton('btn-forward', 'forward');
setupButton('btn-backward', 'backward');
setupButton('btn-left', 'left');
setupButton('btn-right', 'right');


// 6. The Render Loop
let lastTime = 0;

function animate(currentTime) {
    requestAnimationFrame(animate);
    
    const timeInSeconds = currentTime * 0.001; 
    const delta = lastTime === 0 ? 0 : timeInSeconds - lastTime;
    lastTime = timeInSeconds;

    customOceanMaterial.uniforms.uTime.value = timeInSeconds * 1.5;

    // CHANGED: We now check isSimulating instead of controls.isLocked
    // This allows movement on mobile where PointerLock doesn't exist
    if (isSimulating) {
        velocity.x -= velocity.x * 5.0 * delta; 
        velocity.z -= velocity.z * 5.0 * delta;

        direction.z = Number(moveState.forward) - Number(moveState.backward);
        direction.x = Number(moveState.right) - Number(moveState.left);
        direction.normalize();

        const speed = 500.0; 
        if (moveState.forward || moveState.backward) velocity.z -= direction.z * speed * delta;
        if (moveState.left || moveState.right) velocity.x -= direction.x * speed * delta;

        // Apply movement
        controls.moveRight(-velocity.x * delta);
        controls.moveForward(-velocity.z * delta);
    }

    composer.render();
}

requestAnimationFrame(animate);
