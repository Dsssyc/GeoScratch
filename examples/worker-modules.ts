import { defineWorkerModuleBuild } from 'geoscratch/scratch'
import { DEM_TILE_WORKER } from './underwaterTerrain/dem-tile-protocol.ts'

export default defineWorkerModuleBuild({
    outDir: './public/scratch-workers',
    modules: [
        {
            contract: DEM_TILE_WORKER,
            entry: './underwaterTerrain/dem-tile-worker.ts',
        },
    ],
})
