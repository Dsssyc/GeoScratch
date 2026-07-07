import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const examplesRoot = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(examplesRoot, '..')
const examplesPublic = path.resolve(examplesRoot, 'public')

const examplePages = {
  index: path.resolve(examplesRoot, 'index.html'),
  helloTriangle: path.resolve(examplesRoot, '1_helloTriangle/index.html'),
  helloVertexBuffer: path.resolve(examplesRoot, '2_helloVertexBuffer/index.html'),
  scratchHelloTriangle: path.resolve(examplesRoot, 'scratch_helloTriangle/index.html'),
  scratchUniformTriangle: path.resolve(examplesRoot, 'scratch_uniformTriangle/index.html'),
  scratchComputeReadback: path.resolve(examplesRoot, 'scratch_computeReadback/index.html'),
  scratchHelloVertexBuffer: path.resolve(examplesRoot, 'scratch_helloVertexBuffer/index.html'),
  helloMap: path.resolve(examplesRoot, 'm_helloMap/index.html'),
  demLayer: path.resolve(examplesRoot, 'm_demLayer/index.html'),
  flowLayer: path.resolve(examplesRoot, 'm_flowLayer/index.html'),
  helloGAW: path.resolve(examplesRoot, 'x_helloGAW/index.html'),
}

// https://vitejs.dev/config/
export default defineConfig({
  root: examplesRoot,
  publicDir: examplesPublic,
  plugins: [
  ],
  build: {
    outDir: path.resolve(projectRoot, 'dist/examples'),
    emptyOutDir: true,
    rollupOptions: {
      input: examplePages,
    },
  },
  server: {
    host: '0.0.0.0',
    fs: {
      allow: [projectRoot],
    },
  }
})
