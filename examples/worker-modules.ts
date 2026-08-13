import { defineWorkerModuleBuild } from 'geoscratch/scratch'
import { DEM_TILE_WORKER } from './demLayer/dem-tile-protocol.ts'

export default defineWorkerModuleBuild({
    outDir: './public/scratch-workers',
    modules: [
        {
            contract: DEM_TILE_WORKER,
            entry: './demLayer/dem-tile-worker.ts',
        },
    ],
})
