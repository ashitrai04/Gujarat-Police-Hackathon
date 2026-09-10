// Copies the ONNX Runtime WebAssembly build into public/ort so the browser
// detector loads it from this site rather than a third-party CDN.
// Generated, not committed: it comes from node_modules on every dev/build,
// so it always matches the installed onnxruntime-web version.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The package exports its wasm files directly, not its package.json.
const dist = dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm'));
const out = join(process.cwd(), 'public', 'ort');
mkdirSync(out, { recursive: true });
// The WebGPU build (onnxruntime-web/webgpu, 1.29) loads the asyncify runtime,
// not jsep — verified from its bundle; the jsep files would never be requested.
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  copyFileSync(join(dist, f), join(out, f));
}
console.log('[copy-ort] onnxruntime-web runtime -> public/ort');
