import SteadyFlowLayer from './steadyFlowLayer.js'
import { darkMatterStyle, startScratchMap } from '../shared/scratchMap.js'

startScratchMap({
    style: darkMatterStyle,
}, (map) => {

    map.addLayer(new SteadyFlowLayer())
})
