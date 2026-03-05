uniform vec3 uSunPosition;
uniform vec3 uWaterColor;
uniform vec3 uWaterDeepColor;
uniform sampler2D uEnvMap;
uniform float uTime;

varying vec2 vUv;
varying vec3 vWorldPosition;
varying vec3 vNormal;
varying float vChoppiness;
varying float vElevation;

vec2 hash(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float noise(vec2 p) {
    const float K1 = 0.366025404; 
    const float K2 = 0.211324865; 
    vec2 i = floor(p + (p.x + p.y) * K1);
    vec2 a = p - i + (i.x + i.y) * K2;
    float m = step(a.y, a.x); 
    vec2 o = vec2(m, 1.0 - m);
    vec2 b = a - o + K2;
    vec2 c = a - 1.0 + 2.0 * K2;
    vec3 h = max(0.5 - vec3(dot(a, a), dot(b, b), dot(c, c)), 0.0);
    vec3 n = h * h * h * h * vec3(dot(a, hash(i + 0.0)), dot(b, hash(i + o)), dot(c, hash(i + 1.0)));
    return dot(n, vec3(70.0));
}

float ridgedNoise(vec2 p) {
    float n = noise(p);
    n = 1.0 - abs(n); 
    return n * n;
}

float capillaryWaves(vec2 p) {
    float f = 0.0; float amp = 0.5; mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 4; i++) { 
        f += amp * ridgedNoise(p);
        p = rot * p * 2.0; 
        amp *= 0.4;
    }
    return f;
}

float fbm(vec2 p) {
    float f = 0.0; float amp = 0.5; mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 4; i++) { f += amp * noise(p); p = rot * p * 2.0; amp *= 0.5; }
    return f;
}

void main() {
    vec3 viewVector = normalize(cameraPosition - vWorldPosition);
    vec3 lightDir = normalize(uSunPosition);
    
    // --- 1. CAPILLARY MICRO-RIPPLES ---
    vec2 uvNoise = vWorldPosition.xz * 0.15 + uTime * 0.3;
    float n1 = capillaryWaves(uvNoise);
    float n2 = capillaryWaves(uvNoise * 1.5 - uTime * 0.4);
    vec3 microNormal = normalize(vec3(n1 * 0.3, 1.0, n2 * 0.3));
    vec3 normal = normalize(vNormal + microNormal * 0.6); 

    // --- 2. GEOMETRIC SHADOWING ---
    float lightFacing = max(0.0, dot(normal, lightDir));
    float lightShadow = smoothstep(0.0, 0.5, lightFacing);
    float occlusion = smoothstep(-8.0, 2.0, vElevation); 
    float shadowFactor = mix(0.15, 1.0, lightShadow * occlusion); 

    // --- 3. OPTICS & REFLECTION ---
    float facingRatio = max(dot(viewVector, normal), 0.0);
    float fresnel = 0.02 + 0.98 * pow(clamp(1.0 - facingRatio, 0.0, 1.0), 5.0);

    vec3 reflectionDir = reflect(-viewVector, normal);
    reflectionDir.y = max(reflectionDir.y, 0.01); 
    reflectionDir = normalize(reflectionDir);

    float phi = atan(reflectionDir.z, reflectionDir.x);
    float theta = acos(reflectionDir.y);
    vec2 envUv = vec2(phi / (2.0 * 3.14159) + 0.5, theta / 3.14159);
    vec3 skyReflection = texture2D(uEnvMap, envUv).rgb * 1.5; 

    float waterThickness = clamp(vElevation * 0.12, 0.0, 1.0); 
    vec3 scatterColor = uWaterColor * 1.8 * waterThickness; 
    
    vec3 upwellingColor = mix(uWaterDeepColor, uWaterColor, facingRatio);
    vec3 waterSurfaceColor = mix(upwellingColor, skyReflection, fresnel) * shadowFactor + scatterColor;

    // --- 4. VOLUMETRIC FOAM ---
    float foamMask = smoothstep(-0.1, 0.5, vChoppiness);

    // Foam UV scrolls at the same rate the dominant Gerstner wave crests travel.
    // Wave phase speed ≈ sqrt(9.8/k) * uTimeScale ≈ 13 units/s world space.
    // foamUv scale = 0.03, so UV scroll = worldSpeed * 0.03 ≈ 0.04.
    // Old value was 0.12 (3× too fast) making foam race ahead of the waves.
    vec2 foamUv = vWorldPosition.xz * 0.03 + normal.xz * 2.5;
    foamUv.y -= uTime * 0.04;   // primary scroll — now matches wave crest speed

    float f1 = fbm(foamUv * 2.0);
    float f2 = fbm(foamUv * 5.0 - uTime * 0.03);  // secondary detail, same direction, slightly slower
    
    float webNoise = abs(f1 - 0.5) * 2.0; 
    float webNoise2 = abs(f2 - 0.5) * 2.0;
    
    float rawFoam = 1.0 - (webNoise * 0.6 + webNoise2 * 0.4);
    float foamThickness = smoothstep(0.1, 0.7, rawFoam) * foamMask;
    
    float foamLighting = mix(0.5, 1.1, lightShadow); 
    vec3 thickFoamColor = vec3(0.95, 0.98, 1.0) * foamLighting;
    vec3 foamEdgeColor = uWaterColor * 1.5; 
    vec3 finalFoamAlbedo = mix(foamEdgeColor, thickFoamColor, smoothstep(0.1, 0.5, foamThickness));

    // --- 5. COMPOSITION ---
    vec3 sunReflectionDir = reflect(-lightDir, normal);
    float glint = max(0.0, dot(sunReflectionDir, viewVector));
    float specular = pow(glint, 800.0) * 20.0 * (1.0 + n1 * 5.0) * (1.0 - foamThickness) * shadowFactor;

    vec3 finalColor = waterSurfaceColor + vec3(specular);
    finalColor = mix(finalColor, finalFoamAlbedo, clamp(foamThickness, 0.0, 1.0));

    // --- 6. FOG ---
    vec2 horizonUv = vec2(phi / (2.0 * 3.14159) + 0.5, 0.5); 
    vec3 horizonColor = texture2D(uEnvMap, horizonUv).rgb * 1.5;

    float dist = distance(cameraPosition, vWorldPosition);
    float fogFactor = 1.0 - exp(-dist * 0.0003); 
    fogFactor = clamp(fogFactor, 0.0, 1.0);
    
    finalColor = mix(finalColor, horizonColor, fogFactor);

    gl_FragColor = vec4(finalColor, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
