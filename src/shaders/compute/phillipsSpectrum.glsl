// ============================================================================
// Phillips Spectrum — h̃₀(k) initial spectrum generation
// ============================================================================
// Output: vec4(Re(h̃₀(k)), Im(h̃₀(k)), Re(h̃₀(-k)), Im(h̃₀(-k)))
//
// IMPORTANT: includes dk = 2π/L area factor so the unnormalized IFFT
// directly produces wave heights in correct physical units (meters).
// ============================================================================

uniform float uResolution;
uniform float uPatchSize;
uniform float uWindSpeed;
uniform vec2  uWindDirection;
uniform float uAmplitude;
uniform float uSeed;

#define PI  3.14159265358979
#define TAU 6.28318530717959

vec4 gaussianRandom(vec2 uv) {
    float u0 = fract(sin(dot(uv + uSeed, vec2(127.1, 311.7))) * 43758.5453123);
    float u1 = fract(sin(dot(uv + uSeed, vec2(269.5, 183.3))) * 76291.3269851);
    float u2 = fract(sin(dot(uv + uSeed, vec2(419.2, 371.9))) * 29474.8327149);
    float u3 = fract(sin(dot(uv + uSeed, vec2(523.7, 241.1))) * 63829.1742563);

    u0 = max(u0, 1e-6);
    u2 = max(u2, 1e-6);

    float mag1 = sqrt(-2.0 * log(u0));
    float mag2 = sqrt(-2.0 * log(u2));

    return vec4(
        mag1 * cos(TAU * u1),
        mag1 * sin(TAU * u1),
        mag2 * cos(TAU * u3),
        mag2 * sin(TAU * u3)
    );
}

void main() {
    vec2 fragCoord = gl_FragCoord.xy;
    float N = uResolution;
    float n = fragCoord.x;
    float m = fragCoord.y;

    // Wave vector k — centred (DC at N/2)
    vec2 k = vec2(
        TAU * (n - N * 0.5) / uPatchSize,
        TAU * (m - N * 0.5) / uPatchSize
    );

    float kLen = length(k);
    if (kLen < 1e-6) { gl_FragColor = vec4(0.0); return; }

    float kLen2 = kLen * kLen;
    float kLen4 = kLen2 * kLen2;

    float g = 9.81;
    float L = uWindSpeed * uWindSpeed / g;
    float L2 = L * L;
    float l = L * 0.001;
    float l2 = l * l;

    vec2 kNorm = k / kLen;
    float kDotW = dot(kNorm, uWindDirection);
    float directional = kDotW * kDotW;
    if (kDotW < 0.0) directional *= 0.07;

    float phillips = uAmplitude
                   * exp(-1.0 / (kLen2 * L2))
                   / kLen4
                   * directional
                   * exp(-kLen2 * l2);

    // dk area factor: converts spectral density → DFT coefficient
    float dk = TAU / uPatchSize;
    float sqrtSpectral = sqrt(phillips) * dk;
    float invSqrt2 = 0.70710678118;

    vec4 gauss = gaussianRandom(fragCoord / N);

    // h̃₀(k)
    float h0kRe = invSqrt2 * gauss.x * sqrtSpectral;
    float h0kIm = invSqrt2 * gauss.y * sqrtSpectral;

    // h̃₀(-k) — for Hermitian conjugate property
    float kNegDotW = dot(-kNorm, uWindDirection);
    float directionalNeg = kNegDotW * kNegDotW;
    if (kNegDotW < 0.0) directionalNeg *= 0.07;

    float phillipsNeg = uAmplitude
                      * exp(-1.0 / (kLen2 * L2))
                      / kLen4
                      * directionalNeg
                      * exp(-kLen2 * l2);

    float sqrtSpectralNeg = sqrt(phillipsNeg) * dk;

    float h0mkRe = invSqrt2 * gauss.z * sqrtSpectralNeg;
    float h0mkIm = invSqrt2 * gauss.w * sqrtSpectralNeg;

    gl_FragColor = vec4(h0kRe, h0kIm, h0mkRe, h0mkIm);
}
