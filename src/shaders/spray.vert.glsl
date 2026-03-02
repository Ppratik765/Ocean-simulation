uniform float uTime;
attribute float aRandom;
attribute vec3 aVelocity;

varying float vAlpha;
varying vec3 vWorldPos;

float hash(float n) { return fract(sin(n) * 43758.5453123); }
const float GOLDEN_RATIO = 1.61803398875;

vec3 gerstnerWave(float angle, float steepness, float wavelength, float speed, vec3 p, vec2 warpedP, inout vec3 tangent, inout vec3 binormal, inout float choppiness) {
    float k = 2.0 * 3.14159 / wavelength;
    float c = sqrt(9.8 / k) * speed;
    vec2 d = vec2(cos(angle), sin(angle));
    float phase = k * (dot(d, warpedP) - c * uTime) + hash(angle) * 6.28;
    float a = steepness / k;

    choppiness += a * k * cos(phase);

    tangent += vec3(
        -d.x * d.x * (steepness * sin(phase)),
        d.x * (steepness * cos(phase)),
        -d.x * d.y * (steepness * sin(phase))
    );
    binormal += vec3(
        -d.x * d.y * (steepness * sin(phase)),
        d.y * (steepness * cos(phase)),
        -d.y * d.y * (steepness * sin(phase))
    );
    return vec3( d.x * (a * cos(phase)), a * sin(phase), d.y * (a * cos(phase)) );
}

void main() {
    vec3 p = position;
    vec3 tangent = vec3(1.0, 0.0, 0.0);
    vec3 binormal = vec3(0.0, 0.0, 1.0);
    float choppiness = 0.0;

    vec2 warpedP = position.xz;
    warpedP.x += sin(position.z * 0.02 + uTime * 0.1) * 20.0;
    warpedP.y += cos(position.x * 0.02 - uTime * 0.1) * 20.0;

    float baseWavelength = 180.0; 
    float baseSteepness = 0.25;
    float angle = 1.0; 
    
    for(int i = 0; i < 16; i++) {
        float speedMod = 0.8 + hash(float(i)) * 0.5;
        p += gerstnerWave(angle, baseSteepness, baseWavelength, speedMod, position, warpedP, tangent, binormal, choppiness);
        angle += GOLDEN_RATIO * 3.14159 * 2.0; 
        baseWavelength *= 0.74; 
        baseSteepness *= 0.82;  
    }

    vec3 normal = normalize(cross(binormal, tangent));

    // --- VIOLENT SPRAY LAUNCHER ---
    float life = fract(uTime * 0.6 + aRandom); 
    
    // Drastically lowered threshold so the mist triggers constantly
    float sprayMask = smoothstep(-0.1, 0.5, choppiness); 
    
    if (sprayMask > 0.05) {
        // 1. Eject outward along the normal
        p += normal * (life * 20.0); 
        // 2. FORCED VERTICAL BOOST: Shoot the mist high into the air
        p.y += (life * 35.0); 
        // 3. Wind carrying it forward
        p.x += aVelocity.x * (life * 50.0);
        p.z += aVelocity.z * (life * 50.0);
        // 4. Heavy gravity pulling it down
        p.y -= 9.8 * (life * life) * 25.0; 
    }

    // Keep the particles highly visible
    vAlpha = sprayMask * (1.0 - life) * smoothstep(0.0, 0.05, life); 

vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    
    // REVERTED: Scaled the particles back down to their tighter, realistic size
    float pointSize = (800.0 / -mvPosition.z);
    gl_PointSize = clamp(pointSize, 2.0, 500.0); 
    
    if (sprayMask < 0.05) {
        gl_PointSize = 0.0;
    }

    gl_Position = projectionMatrix * mvPosition;
    vWorldPos = p;
}