import { defineWorkerModuleBuild } from 'geoscratch/scratch'
import { FLOW_FIELD_VELOCITY_TILE_WORKER } from './flowField/velocity-tile-protocol.ts'
import { DEM_TILE_WORKER } from './underwaterTerrain/dem-tile-protocol.ts'

export default defineWorkerModuleBuild({
    outDir: './public/scratch-workers',
    modules: [
        {
            contract: DEM_TILE_WORKER,
            entry: './underwaterTerrain/dem-tile-worker.ts',
        },
        {
            contract: FLOW_FIELD_VELOCITY_TILE_WORKER,
            entry: './flowField/velocity-tile-worker.ts',
        },
    ],
})
