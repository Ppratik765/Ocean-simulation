// ============================================================================
// Normal + Jacobian — Finite-Difference Computation from Displacement
// ============================================================================
// Input:  displacement texture  → vec4(Dy, Dx, Dz, 0)
// Output: vec4(Nx, Ny, Nz, Jacobian)
//
// Normals and Jacobian computed entirely via finite differences on the
// displacement field — no separate spectral Jacobian textures needed.
// ============================================================================

uniform sampler2D uDisplacementMap;
uniform float uResolution;
uniform float uPatchSize;

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float texel = 1.0 / uResolution;
    float gridSpacing = uPatchSize / uResolution;

    // Sample displacement at center and 4 neighbours (wrapping handled by RepeatWrapping)
    vec4 ctr = texture2D(uDisplacementMap, uv);
    vec4 dR  = texture2D(uDisplacementMap, uv + vec2(texel, 0.0));
    vec4 dL  = texture2D(uDisplacementMap, uv - vec2(texel, 0.0));
    vec4 dU  = texture2D(uDisplacementMap, uv + vec2(0.0, texel));
    vec4 dD  = texture2D(uDisplacementMap, uv - vec2(0.0, texel));

    // Displacement layout: (Dy, Dx, Dz, _)
    // Displaced surface point P(u,v) = (u + Dx, Dy, v + Dz)
    //
    // Tangent in u-direction: dP/du
    vec3 dPdu = vec3(
        gridSpacing + (dR.y - dL.y) * 0.5,   // d(u + Dx)/du = 1 + dDx/du
        (dR.x - dL.x) * 0.5,                  // dDy/du
        (dR.z - dL.z) * 0.5                    // dDz/du
    );

    // Tangent in v-direction: dP/dv
    vec3 dPdv = vec3(
        (dU.y - dD.y) * 0.5,                  // dDx/dv
        (dU.x - dD.x) * 0.5,                  // dDy/dv
        gridSpacing + (dU.z - dD.z) * 0.5     // d(v + Dz)/dv = 1 + dDz/dv
    );

    // Normal = cross(dP/dv, dP/du) — order gives outward (Y-up) normal
    vec3 normal = normalize(cross(dPdv, dPdu));
    if (normal.y < 0.0) normal = -normal;

    // Jacobian determinant J = (1 + dDx/dx)(1 + dDz/dz) - (dDx/dz)²
    float dDxdx = (dR.y - dL.y) / (2.0 * gridSpacing);
    float dDzdz = (dU.z - dD.z) / (2.0 * gridSpacing);
    float dDxdz = (dU.y - dD.y) / (2.0 * gridSpacing);

    float J = (1.0 + dDxdx) * (1.0 + dDzdz) - dDxdz * dDxdz;

    gl_FragColor = vec4(normal, J);
}
