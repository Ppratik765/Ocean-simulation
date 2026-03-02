uniform vec3 uWaterColor;
uniform vec3 uWaterDeepColor;

varying float vAlpha;
varying vec3 vWorldPos;

void main() {
    if (vAlpha <= 0.005) discard;
    
    vec2 cxy = 2.0 * gl_PointCoord - 1.0;
    float r = dot(cxy, cxy);
    if (r > 1.0) discard;
    
    // Tighter core: creates a thick center that fades softly only at the very edges
    float softness = smoothstep(1.0, 0.1, r); 
    
    // 80% Aerated White, 20% Deep Water Blue
    vec3 baseWaterColor = mix(uWaterDeepColor, uWaterColor, 0.5);
    vec3 mistColor = mix(baseWaterColor, vec3(1.0, 1.0, 1.0), 0.8);

    // Boosted the alpha multiplier to 1.5 to make it highly pronounced
    gl_FragColor = vec4(mistColor, vAlpha * softness * 1.5); 
}