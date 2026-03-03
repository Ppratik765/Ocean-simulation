import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { RGBELoader as HDRLoader } from 'three/examples/jsm/loaders/RGBELoader.js'; 

import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import oceanVert from './shaders/ocean.vert.glsl?raw';
import oceanFrag from './shaders/ocean.frag.glsl?raw';
import sprayVert from './shaders/spray.vert.glsl?raw';
import sprayFrag from './shaders/spray.frag.glsl?raw';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 20000);
camera.position.set(-200, 75, 0); 

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
const ocean = new THREE.Mesh(geometry, customOceanMaterial);
scene.add(ocean);

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

// --- DYNAMIC SKYBOX ENGINE & TRANSITIONS ---
let currentSkyboxIndex = 0;
// THE FIX: Updated the total count to exactly 5 (indices 0, 1, 2, 3, 4)
const totalSkyboxes = 5; 
const hdrLoader = new HDRLoader().setPath('/textures/');

// Transition state variables
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
    
    // 1. Fade out (Close camera aperture)
    targetExposure = 0.0;
    
    // 2. Wait 400ms for screen to go black, then seamlessly swap assets
    setTimeout(() => {
        let nextIndex = (currentSkyboxIndex + direction + totalSkyboxes) % totalSkyboxes;
        
        hdrLoader.load(`skybox_${nextIndex}.hdr`, function (texture) {
            texture.mapping = THREE.EquirectangularReflectionMapping;
            scene.background = texture;
            scene.environment = texture;
            customOceanMaterial.uniforms.uEnvMap.value = texture;
            
            currentSkyboxIndex = nextIndex;
            
            // 3. Disable bloom for night skies (indices 3 and 4)
            targetBloom = currentSkyboxIndex >= 3 ? 0.0 : 0.05;
            
            // 4. Fade back in (Open camera aperture)
            targetExposure = 0.95;
            
            // Release lock after fade completes
            setTimeout(() => { isTransitioning = false; }, 500);
        });
    }, 400); 
}

// Initial Load
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

const controls = new PointerLockControls(camera, renderer.domElement);
const blocker = document.getElementById('blocker');
const instructions = document.getElementById('instructions');
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

document.addEventListener('keydown', (event) => {
    switch (event.code) {
        case 'KeyW': moveState.forward = true; break;
        case 'KeyA': moveState.left = true; break;
        case 'KeyS': moveState.backward = true; break;
        case 'KeyD': moveState.right = true; break;
        case 'KeyQ': switchSkybox(-1); break; // Cycle backwards
        case 'KeyE': switchSkybox(1); break;  // Cycle forwards
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

    // --- SMOOTH TRANSITION LERPING ---
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
        velocity.x -= velocity.x * 5.0 * delta; 
        velocity.z -= velocity.z * 5.0 * delta;

        direction.z = Number(moveState.forward) - Number(moveState.backward);
        direction.x = Number(moveState.right) - Number(moveState.left);
        direction.normalize();

        const speed = 700.0; 
        if (moveState.forward || moveState.backward) velocity.z -= direction.z * speed * delta;
        if (moveState.left || moveState.right) velocity.x -= direction.x * speed * delta;

        controls.moveRight(-velocity.x * delta);
        controls.moveForward(-velocity.z * delta);
    }

    composer.render();
}

requestAnimationFrame(animate);