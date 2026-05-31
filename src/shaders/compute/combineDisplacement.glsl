// ============================================================================
// Combine Displacement — Multi-Cascade Merge
// ============================================================================
// Merges displacement from two cascades into a single output texture.
// Each cascade contributes at its own spatial scale (patch size).
//
// Output: vec4(Dy, Dx, Dz, 0) — combined displacement
// ============================================================================

uniform sampler2D uCascade0;     // Large scale displacement (1000m patch)
uniform sampler2D uCascade1;     // Small scale displacement (50m patch)
uniform sampler2D uNormalJac0;   // Large scale normals + Jacobian
uniform sampler2D uNormalJac1;   // Small scale normals + Jacobian
uniform float uResolution;
uniform int   uOutputMode;       // 0 = displacement, 1 = normals+jacobian

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;

    if (uOutputMode == 0) {
        // Combine displacements additively
        vec4 d0 = texture2D(uCascade0, uv);
        vec4 d1 = texture2D(uCascade1, uv);

        // Direct additive combination — the different patch sizes mean
        // the cascades already sample different frequency ranges
        gl_FragColor = vec4(
            d0.x + d1.x,   // Dy
            d0.y + d1.y,   // Dx
            d0.z + d1.z,   // Dz
            0.0
        );
    } else {
        // Combine normals via blending, combine Jacobians multiplicatively
        vec4 nj0 = texture2D(uNormalJac0, uv);
        vec4 nj1 = texture2D(uNormalJac1, uv);

        // Normal blending: add tangent-space perturbations
        vec3 n0 = nj0.xyz;
        vec3 n1 = nj1.xyz;
        vec3 combined = normalize(vec3(
            n0.x + n1.x,
            n0.y * n1.y,   // keep Y dominant
            n0.z + n1.z
        ));

        // Jacobian: multiply the two J values
        // J < 1 in either cascade should trigger foam
        float J = min(nj0.w, nj1.w);

        gl_FragColor = vec4(combined, J);
    }
}
