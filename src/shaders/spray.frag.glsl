uniform vec3 uWaterColor;
uniform vec3 uWaterDeepColor;

varying float vAlpha;
varying vec3 vWorldPos;

void main() {
    if (vAlpha <= 0.005) discard;
    
    vec2 cxy = 2.0 * gl_PointCoord - 1.0;
    float r = dot(cxy, cxy);
    if (r > 1.0) discard;
    
    // Soft radial falloff for volumetric gas feel
    float softness = pow(1.0 - sqrt(r), 1.5); 
    
    // AERATION FIX: Mix with 65% bright white so it pops against the dark water
    vec3 baseWaterColor = mix(uWaterDeepColor, uWaterColor, 0.8);
    vec3 mistColor = mix(baseWaterColor, vec3(0.95, 0.98, 1.0), 0.65);

    // Boosted the alpha multiplier to 1.8 to ensure it stays highly visible
    gl_FragColor = vec4(mistColor, vAlpha * softness * 1.8); 
}