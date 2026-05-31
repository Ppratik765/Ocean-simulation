// ============================================================================
// Ocean Material — MeshPhysicalMaterial + onBeforeCompile Injection
// ============================================================================
// Photorealistic ocean surface extending Three.js PBR pipeline:
//   • GPGPU displacement in vertex shader
//   • Procedural small-scale ripples (replaces second FFT cascade)
//   • GPGPU normal perturbation in fragment shader
//   • Jacobian-based foam with FBM noise breakup
//   • Subsurface scattering
//   • Depth-dependent colour
// ============================================================================

import * as THREE from 'three';

/**
 * @param {object} opts
 * @param {THREE.Texture} opts.displacementMap
 * @param {THREE.Texture} opts.normalJacobianMap
 * @param {number}        opts.oceanSize
 * @param {THREE.Vector3} opts.sunDirection
 */
export function createOceanMaterial({
    displacementMap   = null,
    normalJacobianMap = null,
    oceanSize         = 1000.0,
    sunDirection      = new THREE.Vector3(0.5, 0.3, -0.5).normalize(),
} = {}) {

    const material = new THREE.MeshPhysicalMaterial({
        color:               new THREE.Color(0x004466),
        roughness:           0.12,
        metalness:           0.02,
        transmission:        0.92,
        ior:                 1.333,
        clearcoat:           0.6,
        clearcoatRoughness:  0.15,
        thickness:           4.0,
        attenuationDistance:  40.0,
        attenuationColor:    new THREE.Color(0x002233),
        envMapIntensity:     2.8,
        side:                THREE.FrontSide,
        transparent:         false,
    });

    const oceanUniforms = {
        uDisplacementMap:   { value: displacementMap },
        uNormalJacobianMap: { value: normalJacobianMap },
        uOceanSize:         { value: oceanSize },
        uTime:              { value: 0.0 },
        uSunDirection:      { value: sunDirection },
        uFoamThreshold:     { value: 0.45 },
        uFoamIntensity:     { value: 1.2 },
        uSSSIntensity:      { value: 0.4 },
        uSSSColor:          { value: new THREE.Color(0.06, 0.55, 0.45) },
        uDeepColor:         { value: new THREE.Color(0.01, 0.03, 0.07) },
        uDisplacementScale: { value: 1.0 },
    };

    material.userData.oceanUniforms = oceanUniforms;

    material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, oceanUniforms);
        material.userData.shader = shader;

        // ═══════════════════════════════════════════════════════════════
        // VERTEX SHADER
        // ═══════════════════════════════════════════════════════════════
        shader.vertexShader = shader.vertexShader.replace(
            '#include <common>',
            /* glsl */ `
            #include <common>

            uniform sampler2D uDisplacementMap;
            uniform float uOceanSize;
            uniform float uTime;
            uniform float uDisplacementScale;

            varying vec3  vOceanWorldPos;
            varying vec2  vOceanUV;
            varying float vOceanHeight;
            `
        );

        shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            /* glsl */ `
            #include <begin_vertex>

            // Compute tiling UV from world position
            vec4 wp = modelMatrix * vec4(transformed, 1.0);
            vOceanUV = wp.xz / uOceanSize;

            // ─── GPGPU Displacement ───
            vec4 disp = texture2D(uDisplacementMap, fract(vOceanUV));
            float scale = uDisplacementScale;

            transformed.y += disp.x * scale;     // Dy — vertical
            transformed.x += disp.y * scale;     // Dx — choppiness X
            transformed.z += disp.z * scale;     // Dz — choppiness Z

            // ─── Procedural Small-Scale Ripples (replaces 2nd FFT cascade) ───
            float rx = wp.x * 0.12 + uTime * 1.4;
            float rz = wp.z * 0.09 + uTime * 1.1;
            float ripple  = sin(rx) * cos(rz) * 0.35;
            float ripple2 = sin(wp.x * 0.27 + wp.z * 0.19 + uTime * 2.3) * 0.18;
            float ripple3 = sin(wp.x * 0.41 - wp.z * 0.33 + uTime * 3.1) * 0.10;
            transformed.y += (ripple + ripple2 + ripple3) * scale;

            // Updated world position
            vec4 dispWorld = modelMatrix * vec4(transformed, 1.0);
            vOceanWorldPos = dispWorld.xyz;
            vOceanHeight   = disp.x * scale + ripple + ripple2 + ripple3;
            `
        );

        // ═══════════════════════════════════════════════════════════════
        // FRAGMENT SHADER
        // ═══════════════════════════════════════════════════════════════
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <common>',
            /* glsl */ `
            #include <common>

            uniform sampler2D uNormalJacobianMap;
            uniform sampler2D uDisplacementMap;
            uniform float uOceanSize;
            uniform float uTime;
            uniform vec3  uSunDirection;
            uniform float uFoamThreshold;
            uniform float uFoamIntensity;
            uniform float uSSSIntensity;
            uniform vec3  uSSSColor;
            uniform vec3  uDeepColor;

            varying vec3  vOceanWorldPos;
            varying vec2  vOceanUV;
            varying float vOceanHeight;

            // ─── FBM noise for foam breakup ───
            float oceanHash(vec2 p) {
                return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
            }
            float oceanNoise(vec2 p) {
                vec2 i = floor(p);
                vec2 f = fract(p);
                f = f * f * (3.0 - 2.0 * f);
                return mix(
                    mix(oceanHash(i),                    oceanHash(i + vec2(1, 0)), f.x),
                    mix(oceanHash(i + vec2(0, 1)),       oceanHash(i + vec2(1, 1)), f.x),
                    f.y
                );
            }
            float oceanFBM(vec2 p) {
                float v = 0.0;
                v += 0.5000 * oceanNoise(p); p *= 2.01;
                v += 0.2500 * oceanNoise(p); p *= 2.02;
                v += 0.1250 * oceanNoise(p); p *= 2.03;
                v += 0.0625 * oceanNoise(p);
                return v;
            }
            `
        );

        // ─── Override normals after normal_fragment_maps ───
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <normal_fragment_maps>',
            /* glsl */ `
            #include <normal_fragment_maps>

            // ─── GPGPU Normal ───
            vec4 nj = texture2D(uNormalJacobianMap, fract(vOceanUV));
            vec3 gpuNormal = nj.xyz;
            float jacobian = nj.w;

            // ─── Procedural ripple normal perturbation ───
            vec2 rUV = vOceanWorldPos.xz;
            float nx = cos(rUV.x * 0.12 + uTime * 1.4) * 0.12
                      + cos(rUV.x * 0.27 + rUV.y * 0.19 + uTime * 2.3) * 0.06
                      + cos(rUV.x * 0.41 - rUV.y * 0.33 + uTime * 3.1) * 0.04;
            float nz = -sin(rUV.y * 0.09 + uTime * 1.1) * 0.12
                       + cos(rUV.x * 0.27 + rUV.y * 0.19 + uTime * 2.3) * 0.04
                       - cos(rUV.x * 0.41 - rUV.y * 0.33 + uTime * 3.1) * 0.03;

            vec3 oceanNorm = normalize(gpuNormal + vec3(nx, 0.0, nz));
            if (oceanNorm.y < 0.0) oceanNorm.y = 0.05;
            oceanNorm = normalize(oceanNorm);

            // World → view space
            normal = normalize(mat3(viewMatrix) * oceanNorm);
            `
        );

        // ─── Foam + SSS before final output ───
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <opaque_fragment>',
            /* glsl */ `
            // ─── FOAM (Jacobian-based) ───
            float foamMask = smoothstep(uFoamThreshold, uFoamThreshold - 0.35, jacobian);

            vec2 foamUV = vOceanWorldPos.xz * 0.08 + uTime * 0.02;
            float fn1 = oceanFBM(foamUV * 3.0);
            float fn2 = oceanFBM(foamUV * 7.0 - uTime * 0.05);
            float foamBreakup = smoothstep(0.28, 0.72, fn1 * 0.6 + fn2 * 0.4);
            float foam = foamMask * foamBreakup * uFoamIntensity;

            vec3 foamColor = vec3(0.92, 0.95, 0.98);
            vec3 foamEdge  = vec3(0.60, 0.75, 0.82);
            vec3 finalFoam = mix(foamEdge, foamColor, smoothstep(0.2, 0.6, foam));

            // ─── SUBSURFACE SCATTERING ───
            vec3 viewDir = normalize(cameraPosition - vOceanWorldPos);
            vec3 sunDir  = normalize(uSunDirection);
            float sssView = pow(max(0.0, dot(viewDir, -sunDir)), 4.0);
            float sssH    = smoothstep(-2.0, 6.0, vOceanHeight);
            float sss     = sssView * sssH * uSSSIntensity;

            vec3 sssContrib  = uSSSColor * sss;
            float depthFade  = smoothstep(2.0, -4.0, vOceanHeight);
            vec3 depthContrib = uDeepColor * depthFade * 0.5;

            // ─── Compose ───
            outgoingLight = mix(outgoingLight + sssContrib + depthContrib,
                                finalFoam,
                                clamp(foam, 0.0, 0.85));

            // ─── Distance fog ───
            float dist = length(vOceanWorldPos - cameraPosition);
            float fogF = 1.0 - exp(-dist * 0.00025);
            fogF = clamp(fogF, 0.0, 0.85);

            #include <opaque_fragment>
            `
        );
    };

    material.needsUpdate = true;
    return material;
}

/**
 * Updates ocean material uniforms each frame.
 */
export function updateOceanMaterial(material, { time, displacementMap, normalJacobianMap }) {
    const u = material.userData.oceanUniforms;
    if (!u) return;
    u.uTime.value = time;
    if (displacementMap)   u.uDisplacementMap.value   = displacementMap;
    if (normalJacobianMap) u.uNormalJacobianMap.value = normalJacobianMap;
}
