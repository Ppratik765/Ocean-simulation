uniform vec3 uSunPosition;
uniform vec3 uWaterColor;
uniform vec3 uWaterDeepColor;
uniform sampler2D uEnvMap;
uniform float uTime;

varying vec2 vUv;
varying vec3 vWorldPosition;
varying vec3 vNormal;
varying float vChoppiness;
varying float vElevation; // Received from vertex shader

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

float fbm(vec2 p) {
    float f = 0.0;
    float amp = 0.5;
    mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 4; i++) {
        f += amp * noise(p);
        p = rot * p * 2.0;
        amp *= 0.5;
    }
    return f;
}

void main() {
    vec3 viewVector = normalize(cameraPosition - vWorldPosition);
    vec3 lightDir = normalize(uSunPosition);
    
    // 1. CRISP, SHATTERED MICRO-RIPPLES
    vec2 uvNoise = vWorldPosition.xz * 0.1 + uTime * 0.4;
    float n1 = fbm(uvNoise);
    float n2 = fbm(uvNoise * 2.5 - uTime * 0.3);
    vec3 microNormal = normalize(vec3(n1 * 0.3, 1.0, n2 * 0.3));
    vec3 normal = normalize(vNormal + microNormal * 0.6); // Stronger influence to break up plastic look

    // 2. FRESNEL & SKY REFLECTION
    float facingRatio = max(dot(viewVector, normal), 0.0);
    float fresnel = 0.02 + 0.98 * pow(clamp(1.0 - facingRatio, 0.0, 1.0), 5.0);

    vec3 reflectionDir = reflect(-viewVector, normal);
    reflectionDir.y = max(reflectionDir.y, 0.01); 
    reflectionDir = normalize(reflectionDir);

    float phi = atan(reflectionDir.z, reflectionDir.x);
    float theta = acos(reflectionDir.y);
    vec2 envUv = vec2(phi / (2.0 * 3.14159) + 0.5, theta / 3.14159);
    vec3 skyReflection = texture2D(uEnvMap, envUv).rgb * 1.5; 

    // 3. ELEVATION-BASED TRANSPARENCY (Subsurface Volumetrics)
    // The higher the wave (vElevation), the thinner the water, the more light scatters through it.
    // This completely kills the "solid paint" feeling.
    float waterThickness = clamp(vElevation * 0.12, 0.0, 1.0); 
    
    // THE FIX: We remove the hardcoded vec3(0.0, 0.5, 0.4) green color.
    // Instead, we multiply your exact base water color by 1.8 to make it glow naturally.
    vec3 scatterColor = uWaterColor * 1.8 * waterThickness; 
    
    vec3 upwellingColor = mix(uWaterDeepColor, uWaterColor, facingRatio);
    vec3 waterSurfaceColor = mix(upwellingColor, skyReflection, fresnel) + scatterColor;

    // 4. SPECULAR GLINT (Shattered Sun Reflection)
    vec3 sunReflectionDir = reflect(-lightDir, normal);
    // We use the raw noise (n1) to violently break up the sun highlight so it sparkles
    float glint = max(0.0, dot(sunReflectionDir, viewVector));
    float specular = pow(glint, 800.0) * 20.0 * (1.0 + n1 * 5.0);

    vec3 finalColor = waterSurfaceColor + vec3(specular);

    // 5. STRUCTURED FOAM
    float foamMask = smoothstep(0.1, 0.7, vChoppiness);
    vec2 foamUv = vWorldPosition.xz * 0.05 + normal.xz * 1.5;
    foamUv.y -= uTime * 0.1; 
    
    float webNoise = abs(fbm(foamUv * 2.0) - 0.5) * 2.0; 
    float webNoise2 = abs(fbm(foamUv * 6.0) - 0.5) * 2.0;
    
    float foamTexture = 1.0 - (webNoise * 0.6 + webNoise2 * 0.4);
    foamTexture = smoothstep(0.1, 0.8, foamTexture); 
    
    float finalFoam = foamMask * foamTexture;
    vec3 foamAlbedo = vec3(0.85, 0.9, 0.95); 

    finalColor = mix(finalColor, foamAlbedo, finalFoam);

    // 6. ATMOSPHERIC FOG (Locked to your preferred 0.0003)
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