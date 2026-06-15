import { MapOptions } from '../../geo/tiling/geoQuadNode2D'
import { Binding } from '../../gpu/binding/binding'
import { Buffer } from '../../gpu/buffer/buffer'
import { RenderPass } from '../../gpu/pass/renderPass'
import { RenderPipeline } from '../../gpu/pipeline/renderPipeline'

export class LocalTerrain {

    constructor(maxLevel: number);

    setResource(gDynamicBuffer: Buffer): LocalTerrain;

    registerRenderableNode(options: MapOptions): void;

    set minVisibleNodeLevel (min: number);

    set maxVisibleNodeLevel (max: number);

    get minVisibleNodeLevel (): number;

    get maxVisibleNodeLevel (): number;

    get prePass(): RenderPass;

    get pipeline(): RenderPipeline;

    get binding(): Binding;
}
