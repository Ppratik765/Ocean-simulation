// ============================================================================
// Ocean Readback — Async GPU→CPU Height Sampling
// ============================================================================
// Provides non-blocking height queries from the GPGPU displacement texture.
// Used to make props bob accurately on the FFT ocean surface and to enforce
// bird altitude limits relative to actual wave height.
// ============================================================================

import * as THREE from 'three';

/**
 * OceanReadback — samples the GPGPU displacement texture at specific world
 * coordinates and returns the wave height asynchronously.
 */
export class OceanReadback {
    /**
     * @param {THREE.WebGLRenderer} renderer
     * @param {number} oceanSize - patch size for UV mapping
     */
    constructor(renderer, oceanSize) {
        this.renderer = renderer;
        this.oceanSize = oceanSize;
        this._lastHeight = 0;
        this._frameCounter = 0;
        this._pendingRead = false;

        // 1×1 pixel render target for point sampling
        this._sampleRT = new THREE.WebGLRenderTarget(1, 1, {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            format: THREE.RGBAFormat,
            type: THREE.FloatType,
        });

        // Shader that samples the displacement map at a specific UV
        this._sampleMat = new THREE.ShaderMaterial({
            vertexShader: `
                void main() {
                    gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
                    gl_PointSize = 1.0;
                }
            `,
            fragmentShader: `
                uniform sampler2D uDisplacementMap;
                uniform vec2 uSampleUV;
                void main() {
                    gl_FragColor = texture2D(uDisplacementMap, uSampleUV);
                }
            `,
            uniforms: {
                uDisplacementMap: { value: null },
                uSampleUV: { value: new THREE.Vector2() },
            },
        });

        // Use a fullscreen quad approach for reliable 1px rendering
        this._fsScene = new THREE.Scene();
        this._fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this._fsQuad = new THREE.Mesh(
            new THREE.PlaneGeometry(2, 2),
            new THREE.ShaderMaterial({
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    uniform sampler2D uDisplacementMap;
                    uniform vec2 uSampleUV;
                    varying vec2 vUv;
                    void main() {
                        gl_FragColor = texture2D(uDisplacementMap, uSampleUV);
                    }
                `,
                uniforms: {
                    uDisplacementMap: { value: null },
                    uSampleUV: { value: new THREE.Vector2() },
                },
            })
        );
        this._fsScene.add(this._fsQuad);

        // CPU-side pixel buffer
        this._pixelBuffer = new Float32Array(4);
    }

    /**
     * Converts world XZ to ocean UV coordinates.
     */
    _worldToUV(x, z) {
        // fract to handle tiling
        let u = (x / this.oceanSize) % 1.0;
        let v = (z / this.oceanSize) % 1.0;
        if (u < 0) u += 1.0;
        if (v < 0) v += 1.0;
        return new THREE.Vector2(u, v);
    }

    /**
     * Samples the ocean height at world position (x, z).
     * Throttled — only actually reads from GPU every `interval` frames.
     *
     * @param {THREE.Texture} displacementTexture - GPGPU displacement texture
     * @param {number} worldX - world X coordinate
     * @param {number} worldZ - world Z coordinate
     * @param {number} interval - read every N frames (default 3)
     * @returns {number} - the most recent Y displacement value
     */
    sample(displacementTexture, worldX, worldZ, interval = 3) {
        this._frameCounter++;

        if (this._frameCounter % interval !== 0 || this._pendingRead) {
            return this._lastHeight;
        }

        const uv = this._worldToUV(worldX, worldZ);

        // Update uniforms
        const mat = this._fsQuad.material;
        mat.uniforms.uDisplacementMap.value = displacementTexture;
        mat.uniforms.uSampleUV.value.copy(uv);

        // Render 1px sample
        const prevRT = this.renderer.getRenderTarget();
        this.renderer.setRenderTarget(this._sampleRT);
        this.renderer.render(this._fsScene, this._fsCamera);

        // Read pixels (synchronous but only 1 pixel = negligible)
        this.renderer.readRenderTargetPixels(
            this._sampleRT, 0, 0, 1, 1, this._pixelBuffer
        );
        this.renderer.setRenderTarget(prevRT);

        // pixelBuffer[0] = Dy (height displacement)
        this._lastHeight = this._pixelBuffer[0];

        return this._lastHeight;
    }

    /**
     * Async version — uses readRenderTargetPixelsAsync if available (Three.js r152+).
     * Falls back to sync read.
     */
    async sampleAsync(displacementTexture, worldX, worldZ) {
        if (this._pendingRead) return this._lastHeight;

        const uv = this._worldToUV(worldX, worldZ);
        const mat = this._fsQuad.material;
        mat.uniforms.uDisplacementMap.value = displacementTexture;
        mat.uniforms.uSampleUV.value.copy(uv);

        const prevRT = this.renderer.getRenderTarget();
        this.renderer.setRenderTarget(this._sampleRT);
        this.renderer.render(this._fsScene, this._fsCamera);

        if (this.renderer.readRenderTargetPixelsAsync) {
            this._pendingRead = true;
            try {
                const buffer = await this.renderer.readRenderTargetPixelsAsync(
                    this._sampleRT, 0, 0, 1, 1
                );
                this._lastHeight = buffer[0];
            } catch (e) {
                // Fall back to sync
                this.renderer.readRenderTargetPixels(
                    this._sampleRT, 0, 0, 1, 1, this._pixelBuffer
                );
                this._lastHeight = this._pixelBuffer[0];
            }
            this._pendingRead = false;
        } else {
            this.renderer.readRenderTargetPixels(
                this._sampleRT, 0, 0, 1, 1, this._pixelBuffer
            );
            this._lastHeight = this._pixelBuffer[0];
        }

        this.renderer.setRenderTarget(prevRT);
        return this._lastHeight;
    }

    dispose() {
        this._sampleRT.dispose();
        this._sampleMat.dispose();
        this._fsQuad.material.dispose();
        this._fsQuad.geometry.dispose();
    }
}
