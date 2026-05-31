// ============================================================================
// Butterfly (Twiddle Factor) Texture — Precomputation
// ============================================================================
// Generates the butterfly texture for the Cooley-Tukey radix-2 IFFT.
// Run ONCE at init. The texture has dimensions (log₂(N), N).
//
// Each texel stores: vec4(twiddle_re, twiddle_im, index1, index2)
// where index1/index2 are the two input indices for the butterfly operation,
// and twiddle is the complex exponential weight.
// ============================================================================

uniform float uResolution; // N (must be power of 2)

#define PI 3.14159265358979

void main() {
    vec2 fragCoord = gl_FragCoord.xy;
    float stage = fragCoord.x;  // which butterfly stage (0 to log2(N)-1)
    float index = fragCoord.y;  // which element (0 to N-1)
    float N = uResolution;

    float butterflySpan = pow(2.0, stage + 1.0);
    float halfSpan      = pow(2.0, stage);

    float k = mod(index, butterflySpan);
    bool isTopWing = (k < halfSpan);

    // Twiddle factor: W_N^k = e^{-2πi·k/butterflySpan}
    // For IFFT we use +2πi (positive exponent)
    float twiddleExp = 2.0 * PI * k / butterflySpan;
    float twiddleRe = cos(twiddleExp);
    float twiddleIm = sin(twiddleExp);

    // Bit-reversal only matters for stage 0 input ordering
    // For general stages, compute the two source indices
    float idx1, idx2;

    if (stage == 0.0) {
        // Stage 0: inputs come from bit-reversed order
        // Compute bit-reversal of index
        float logN = log2(N);
        float rev = 0.0;
        float tmp = index;
        for (float i = 0.0; i < 16.0; i++) {
            if (i >= logN) break;
            rev = rev * 2.0 + mod(tmp, 2.0);
            tmp = floor(tmp / 2.0);
        }

        if (isTopWing) {
            float revPartner = 0.0;
            float tmp2 = index + halfSpan;
            for (float i = 0.0; i < 16.0; i++) {
                if (i >= logN) break;
                revPartner = revPartner * 2.0 + mod(tmp2, 2.0);
                tmp2 = floor(tmp2 / 2.0);
            }
            idx1 = rev;
            idx2 = revPartner;
        } else {
            float baseIdx = index - halfSpan;
            float revBase = 0.0;
            float tmp3 = baseIdx;
            for (float i = 0.0; i < 16.0; i++) {
                if (i >= logN) break;
                revBase = revBase * 2.0 + mod(tmp3, 2.0);
                tmp3 = floor(tmp3 / 2.0);
            }
            float revPartner2 = 0.0;
            float tmp4 = index;
            for (float i = 0.0; i < 16.0; i++) {
                if (i >= logN) break;
                revPartner2 = revPartner2 * 2.0 + mod(tmp4, 2.0);
                tmp4 = floor(tmp4 / 2.0);
            }
            idx1 = revBase;
            idx2 = revPartner2;
        }
    } else {
        // Later stages: straightforward butterfly pairs
        float base = index - k;
        if (isTopWing) {
            idx1 = base + k;
            idx2 = base + k + halfSpan;
        } else {
            idx1 = base + k - halfSpan;
            idx2 = base + k;
        }
    }

    gl_FragColor = vec4(twiddleRe, twiddleIm, idx1, idx2);
}
