import { defineConfig, type Plugin } from 'vite'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const examplesRoot = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(examplesRoot, '..')
const examplesPublic = path.resolve(examplesRoot, 'public')
const packageSource = path.resolve(projectRoot, 'packages/geoscratch/src')

function sourceRuntimeUrlPlugin(): Plugin {
  return {
    name: 'geoscratch-source-runtime-urls',
    apply: 'serve' as const,
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url !== undefined) {
          request.url = sourceRuntimeRequestUrl(request.url)
        }
        next()
      })
    },
  }
}

function sourceRuntimeRequestUrl(requestUrl: string): string {
  const queryIndex = requestUrl.indexOf('?')
  const pathname = queryIndex === -1 ? requestUrl : requestUrl.slice(0, queryIndex)
  const suffix = queryIndex === -1 ? '' : requestUrl.slice(queryIndex)
  if (!pathname.startsWith('/@fs') || !pathname.endsWith('.js')) return requestUrl

  let requestedPath: string
  try {
    requestedPath = decodeURIComponent(pathname.slice('/@fs'.length))
  } catch {
    return requestUrl
  }
  const relativePath = path.relative(packageSource, requestedPath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return requestUrl

  const sourcePath = `${requestedPath.slice(0, -'.js'.length)}.ts`
  if (!existsSync(sourcePath)) return requestUrl
  return `${pathname.slice(0, -'.js'.length)}.ts${suffix}`
}

const examplePages = {
  index: path.resolve(examplesRoot, 'index.html'),
  helloTriangle: path.resolve(examplesRoot, 'helloTriangle/index.html'),
  uniformTriangle: path.resolve(examplesRoot, 'uniformTriangle/index.html'),
  computeReadback: path.resolve(examplesRoot, 'computeReadback/index.html'),
  bufferMapping: path.resolve(examplesRoot, 'bufferMapping/index.html'),
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
  underwaterTerrain: path.resolve(examplesRoot, 'underwaterTerrain/index.html'),
  flowLayer: path.resolve(examplesRoot, 'flowLayer/index.html'),
  flowField: path.resolve(examplesRoot, 'flowField/index.html'),
  helloGAW: path.resolve(examplesRoot, 'helloGAW/index.html'),
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  root: examplesRoot,
  publicDir: examplesPublic,
  // Package builds replace dist; dev serving stays on stable source entrypoints.
  ...(command === 'serve' ? {
    resolve: {
      alias: [
        {
          find: /^geoscratch\/scratch$/,
          replacement: path.resolve(packageSource, 'scratch.ts'),
        },
        {
          find: /^geoscratch\/geo$/,
          replacement: path.resolve(packageSource, 'geo/index.ts'),
        },
        {
          find: /^geoscratch$/,
          replacement: path.resolve(packageSource, 'index.ts'),
        },
      ],
    },
  } : {}),
  plugins: [
    ...(command === 'serve' ? [ sourceRuntimeUrlPlugin() ] : []),
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
}))
