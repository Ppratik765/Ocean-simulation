uniform float uTime;
varying vec2 vUv;
varying vec3 vWorldPosition;
varying vec3 vNormal;
varying float vChoppiness;
varying float vElevation;

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
    return vec3(
        d.x * (a * cos(phase)),
        a * sin(phase),
        d.y * (a * cos(phase))
    );
}

void main() {
    vUv = uv;
    vec3 p = position;
    vec3 tangent = vec3(1.0, 0.0, 0.0);
    vec3 binormal = vec3(0.0, 0.0, 1.0);
    float choppiness = 0.0;

    vec2 warpedP = position.xz;
    warpedP.x += sin(position.z * 0.02 + uTime * 0.1) * 20.0;
    warpedP.y += cos(position.x * 0.02 - uTime * 0.1) * 20.0;

    float baseWavelength = 110.0; 
    float baseSteepness = 0.29;
    float angle = 1.0; 
    
    for(int i = 0; i < 16; i++) {
        float speedMod = 0.8 + hash(float(i)) * 0.5;
        
        p += gerstnerWave(angle, baseSteepness, baseWavelength, speedMod, position, warpedP, tangent, binormal, choppiness);
        
        angle += GOLDEN_RATIO * 3.14159 * 2.0; 
        baseWavelength *= 0.74; 
        baseSteepness *= 0.82;  
    }

    vChoppiness = choppiness;
    vElevation = p.y;
    vNormal = normalize(cross(binormal, tangent));

    vec4 worldPosition = modelMatrix * vec4(p, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
