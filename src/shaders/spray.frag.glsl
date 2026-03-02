uniform vec3 uWaterColor;
uniform vec3 uWaterDeepColor;

varying float vAlpha;
varying vec3 vWorldPos;

void main() {
    if (vAlpha <= 0.005) discard;
    
    vec2 cxy = 2.0 * gl_PointCoord - 1.0;
    float r = dot(cxy, cxy);
    if (r > 1.0) discard;
    
    // Keep the soft edges so they look like fluid mist, not hard geometric circles
    float softness = pow(1.0 - sqrt(r), 2.0); 
    
    // THE FIX: Use the exact color of the ocean. 
    // We multiply by 1.2 just to simulate a tiny bit of sunlight scattering through the drops.
    vec3 mistColor = mix(uWaterDeepColor, uWaterColor, 0.9) * 1.2;

    // Render as translucent water droplets
    gl_FragColor = vec4(mistColor, vAlpha * softness); 
}