import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const examplesRoot = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(examplesRoot, '..')
const examplesPublic = path.resolve(examplesRoot, 'public')

const examplePages = {
  index: path.resolve(examplesRoot, 'index.html'),
  helloTriangle: path.resolve(examplesRoot, 'helloTriangle/index.html'),
  uniformTriangle: path.resolve(examplesRoot, 'uniformTriangle/index.html'),
  computeReadback: path.resolve(examplesRoot, 'computeReadback/index.html'),
  submissionOrder: path.resolve(examplesRoot, 'submissionOrder/index.html'),
  externalImageUpload: path.resolve(examplesRoot, 'externalImageUpload/index.html'),
  textureResize: path.resolve(examplesRoot, 'textureResize/index.html'),
  helloVertexBuffer: path.resolve(examplesRoot, 'helloVertexBuffer/index.html'),
  textureSampling: path.resolve(examplesRoot, 'textureSampling/index.html'),
  renderToTexture: path.resolve(examplesRoot, 'renderToTexture/index.html'),
  renderPassFeatures: path.resolve(examplesRoot, 'renderPassFeatures/index.html'),
  immediateData: path.resolve(examplesRoot, 'immediateData/index.html'),
  indirectExecution: path.resolve(examplesRoot, 'indirectExecution/index.html'),
  readinessPolicies: path.resolve(examplesRoot, 'readinessPolicies/index.html'),
  demLayer: path.resolve(examplesRoot, 'demLayer/index.html'),
  flowLayer: path.resolve(examplesRoot, 'flowLayer/index.html'),
  helloGAW: path.resolve(examplesRoot, 'helloGAW/index.html'),
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
