import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { RGBELoader as HDRLoader } from 'three/examples/jsm/loaders/RGBELoader.js'; 

// --- POST-PROCESSING & OPTICS IMPORTS ---
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js'; // Added Lensflare

import oceanVert from './shaders/ocean.vert.glsl?raw';
import oceanFrag from './shaders/ocean.frag.glsl?raw';
import sprayVert from './shaders/spray.vert.glsl?raw';
import sprayFrag from './shaders/spray.frag.glsl?raw';

// 1. Scene Setup
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 20000);
camera.position.set(-200, 75, 0); 

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// FIXED: Lowered exposure from 1.2 to 0.95 to prevent the skybox from blowing out into pure white
renderer.toneMappingExposure = 0.95; 
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

// --- 2.5 THE VOLUMETRIC SPRAY SYSTEM ---
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

new HDRLoader().setPath('/textures/').load('skybox_1.hdr', function (texture) {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = texture;
    scene.environment = texture;
    customOceanMaterial.uniforms.uEnvMap.value = texture;
});

// --- LIGHTING & CINEMATIC LENS FLARES ---
const sunLight = new THREE.DirectionalLight(0xffffff, 3.0);
sunLight.position.copy(customOceanMaterial.uniforms.uSunPosition.value).multiplyScalar(100); 

// Procedurally generate lens flare textures so you don't need to download external images
function createFlareTexture(size, innerColor, outerColor) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
    gradient.addColorStop(0, innerColor);
    gradient.addColorStop(1, outerColor);
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
}

// Generate the core sun glow and the scattered blue/warm lens artifacts
const flareMain = createFlareTexture(512, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)');
const flareArtifact = createFlareTexture(512, 'rgba(100,150,255,0.4)', 'rgba(100,150,255,0)');

const lensflare = new Lensflare();
lensflare.addElement(new LensflareElement(flareMain, 600, 0, new THREE.Color(0xffffff)));
lensflare.addElement(new LensflareElement(flareArtifact, 60, 0.6));
lensflare.addElement(new LensflareElement(flareArtifact, 70, 0.7));
lensflare.addElement(new LensflareElement(flareArtifact, 120, 0.9));
lensflare.addElement(new LensflareElement(flareArtifact, 70, 1.0));

sunLight.add(lensflare);
scene.add(sunLight);

// --- 3. CINEMATIC POST-PROCESSING (BLOOM) ---
const renderScene = new RenderPass(scene, camera);

// Dialed back the strength so it just softens the highlights naturally
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
bloomPass.threshold = 0.99; 
bloomPass.strength = 0.03;  
bloomPass.radius = 0.05;    

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

let audioLoaded = false;
let userInteracted = false;

audioLoader.load('/ocean_sound.mp3', function(buffer) {
    oceanSound.setBuffer(buffer);
    oceanSound.setLoop(true);
    oceanSound.setVolume(0.99); 
    audioLoaded = true;

    if (userInteracted && listener.context.state === 'running') {
        oceanSound.play();
    }
});

// --- 5. UNIFIED DESKTOP & MOBILE CONTROLS ---
const controls = new PointerLockControls(camera, renderer.domElement);
const blocker = document.getElementById('blocker');
const instructions = document.getElementById('instructions');

// RESTORED: This flag ensures movement works on mobile even when PointerLock fails
let isSimulating = false; 

instructions.addEventListener('click', () => { 
    controls.lock(); 
    userInteracted = true;
    isSimulating = true;
    blocker.style.display = 'none';
    
    if (listener.context.state === 'suspended') listener.context.resume();
    if (audioLoaded && !oceanSound.isPlaying) oceanSound.play();
});

controls.addEventListener('unlock', () => { 
    blocker.style.display = 'flex'; 
    isSimulating = false;
});

const moveState = { forward: false, backward: false, left: false, right: false };
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();

// Desktop Keyboard
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

// RESTORED: Mobile Touch-to-Look
let touchX = 0;
let touchY = 0;
const lookSensitivity = 0.003;
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

document.addEventListener('touchstart', (e) => {
    if (e.touches.length > 0 && e.target.tagName === 'CANVAS') {
        touchX = e.touches[0].pageX;
        touchY = e.touches[0].pageY;
    }
}, { passive: false });

document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 0 && e.target.tagName === 'CANVAS' && isSimulating) {
        e.preventDefault(); 
        const deltaX = e.touches[0].pageX - touchX;
        const deltaY = e.touches[0].pageY - touchY;
        
        touchX = e.touches[0].pageX;
        touchY = e.touches[0].pageY;

        euler.setFromQuaternion(camera.quaternion);
        euler.y -= deltaX * lookSensitivity;
        euler.x -= deltaY * lookSensitivity;
        euler.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, euler.x)); 
        camera.quaternion.setFromEuler(euler);
    }
}, { passive: false });

// RESTORED: Mobile UI Button Wiring
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

// 6. The Render Loop
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

    customOceanMaterial.uniforms.uTime.value = timeInSeconds * 1.25;
    sprayMaterial.uniforms.uTime.value = timeInSeconds * 1.25; 

    // RESTORED: Checks isSimulating so you can move on mobile without PointerLock
    if (isSimulating) {
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

    composer.render();
}

requestAnimationFrame(animate);