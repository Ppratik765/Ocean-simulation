uniform float uTime;
attribute float aRandom;
attribute vec3 aVelocity;

varying float vAlpha;
varying vec3 vWorldPos;

// GPGPU textures for wave-driven spray
uniform sampler2D uDisplacementMap;
uniform sampler2D uNormalJacobianMap;
uniform float uOceanSize;

void main() {
    vec3 p = position;

    // Sample GPGPU ocean at particle's XZ position
    vec2 oceanUV = fract(p.xz / uOceanSize);
    vec4 disp = texture2D(uDisplacementMap, oceanUV);
    vec4 normalJac = texture2D(uNormalJacobianMap, oceanUV);

    // Get wave surface height and normal at this point
    float waveHeight = disp.x;
    vec3 waveNormal = normalize(normalJac.xyz);
    float jacobian = normalJac.w;

    // Move particle to wave surface
    p.y = waveHeight;
    p.x += disp.y;  // choppiness
    p.z += disp.z;

    // Foam/spray mask from Jacobian — lower J = more wave breaking = more spray
    float sprayMask = smoothstep(0.5, -0.2, jacobian);

    // --- SPRAY LAUNCHER ---
    float life = fract(uTime * 0.6 + aRandom);

    if (sprayMask > 0.05) {
        // 1. Eject outward along the wave normal
        p += waveNormal * (life * 20.0);
        // 2. Vertical boost
        p.y += (life * 35.0);
        // 3. Wind carrying forward
        p.x += aVelocity.x * (life * 50.0);
        p.z += aVelocity.z * (life * 50.0);
        // 4. Gravity
        p.y -= 9.8 * (life * life) * 25.0;
    }

    // Visibility
    vAlpha = sprayMask * (1.0 - life) * smoothstep(0.0, 0.05, life);

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);

    float pointSize = (800.0 / -mvPosition.z);
    gl_PointSize = clamp(pointSize, 2.0, 500.0);

    if (sprayMask < 0.05) {
        gl_PointSize = 0.0;
    }

    // Cull behind camera or too far
    if (mvPosition.z > 0.0 || -mvPosition.z > 2500.0) gl_PointSize = 0.0;

    gl_Position = projectionMatrix * mvPosition;
    vWorldPos = p;
}