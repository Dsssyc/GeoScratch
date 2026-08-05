import { geo, scratch } from 'geoscratch'
import * as geoEntrypoint from 'geoscratch/geo'
import * as scratchEntrypoint from 'geoscratch/scratch'

const runtime: typeof scratchEntrypoint.GPURuntime = scratch.GPURuntime
const workerSystem: typeof scratchEntrypoint.WorkerSystem = scratch.WorkerSystem
const planeGeometry: scratchEntrypoint.PlaneGeometry = scratch.plane(2)
const tileMatrixSet: geoEntrypoint.TileMatrixSet = geo.WebMercatorQuad

// @ts-expect-error The root has namespace exports only
scratchEntrypoint.GPURuntime satisfies typeof import('geoscratch').GPURuntime
// @ts-expect-error Old GPU runtime name was removed
scratchEntrypoint.ScratchRuntime
// @ts-expect-error Old pipeline name was removed
scratchEntrypoint.ScratchRenderPipeline
// @ts-expect-error Old Worker subpath was removed
await import('geoscratch/worker')
// @ts-expect-error Old geometry subpath was removed
await import('geoscratch/geometry')

void runtime
void workerSystem
void planeGeometry
void tileMatrixSet
