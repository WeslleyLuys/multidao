import * as THREE from 'three';

export const waveTime = { value: 0 };

// Faz um plano (com x indo de 0, no mastro, até a ponta) ondular como tecido ao vento.
// A fase vem da posição no mundo, então cada bandeira balança de um jeito.
export function waving<T extends THREE.Material>(material: T, amp = 0.12): T {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWaveTime = waveTime;
    shader.vertexShader = `uniform float uWaveTime;\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        #ifdef USE_INSTANCING
          vec3 anchor = instanceMatrix[3].xyz;
        #else
          vec3 anchor = modelMatrix[3].xyz;
        #endif
        float ph = anchor.x * 0.9 + anchor.z * 1.7;
        float k = clamp(position.x, 0.0, 1.2);
        transformed.z += sin(position.x * 5.0 - uWaveTime * 6.0 + ph) * ${amp.toFixed(3)} * k;
        transformed.y += sin(position.x * 3.0 - uWaveTime * 4.0 + ph) * ${(amp * 0.3).toFixed(3)} * k;
      }`,
    );
  };
  material.customProgramCacheKey = () => `wave-${amp}`;
  return material;
}

export function flagGeometry(w = 1.1, h = 0.7) {
  return new THREE.PlaneGeometry(w, h, 12, 4).translate(w / 2, 0, 0);
}
