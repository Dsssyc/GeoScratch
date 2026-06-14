import { aRef } from '../../core/data/arrayRef.js'
import { bRef } from '../../core/data/blockRef.js'
import { Node2D } from '../../core/quadTree/node2D.js'
import { plane } from '../../core/geometry/plane/plane.js'
import { binding } from '../../gpu/binding/binding.js'
import { texture } from '../../gpu/texture/texture.js'
import { sampler } from '../../gpu/sampler/sampler.js'
import imageLoader from '../../loaders/image/imageLoader.js'
import { renderPass } from '../../gpu/pass/renderPass.js'
import { boundingBox2D } from '../../core/box/boundingBox2D.js'
import shaderLoader from '../../loaders/shader/shaderLoader.js'
import { NoBlending } from '../../gpu/blending/blending.js'
import { indexBuffer } from '../../gpu/buffer/indexBuffer.js'
import { vertexBuffer } from '../../gpu/buffer/vertexBuffer.js'
import { storageBuffer } from '../../gpu/buffer/storageBuffer.js'
import { uniformBuffer } from '../../gpu/buffer/uniformBuffer.js'
import { renderPipeline } from '../../gpu/pipeline/renderPipeline.js'
import { asF32, f32, asVec2f, vec2f } from '../../core/numericType/numericType.js'

export class LocalTerrain {

    constructor(maxLevel) {

        ///////// Initialize CPU resource /////////
        this.asLine = 0
        this.bindingUsed = 0
        this.maxLevel = maxLevel
        this.maxBindingUsedNum = 5000

        this.sectorSize = f32(64)
        this.sectorRange = vec2f()
        this.exaggeration = f32(50.)
        this.tileBox = boundingBox2D()
        this.lodMapSize = vec2f(512, 256)
        this.visibleNodeLevel = vec2f(0, this.maxLevel)
        this.elevationRange = vec2f(-80.06899999999999, 4.3745)
        this.boundaryCondition = boundingBox2D(
            120.0437360613468201,
            31.1739019522094871,
            121.9662324011692220,
            32.0840108580467813,
        )

        this.nodeLevelArray = aRef(new Uint32Array(this.maxBindingUsedNum), 'Storage (Node level)')
        this.nodeBoxArray = aRef(new Float32Array(this.maxBindingUsedNum * 4), 'Storage (Node bBox)')

        ///////// Initialize GPU resource /////////

        // Buffer-released resource
        this.indexNum = 0
        this.tileBuffer = undefined
        this.indexBuffer = undefined
        this.nodeBoxBuffer = undefined
        this.gStaticBuffer = undefined
        this.positionBuffer = undefined
        this.nodeLevelBuffer = undefined

        // Texture-related resource
        this.lSampler = undefined
        this.demTexture = undefined
        this.lodMapTexture = undefined
        this.borderTexture = undefined
        this.paletteTexture = undefined

        // Binding
        this.meshBinding = undefined
        this.lodMapBinding = undefined

        // Pipeline
        this.lodMapPipeline = undefined
        this.meshRenderPipeline = undefined
        this.meshLineRenderPipeline = undefined

        // Pass
        this.lodMapPass = undefined
    }

    setResource(gDynamicBuffer) {

        // Buffer-related resource
        const { positions, indices } = plane(Math.log2(this.sectorSize.n))
        this.indexNum = indices.length
        this.positionBuffer = vertexBuffer({
            name: 'Vertex Buffer (Terrain Position)',
            randomAccessible: true,
            resource: { arrayRef: aRef(new Float32Array(positions)), structure: [ { components: 2 } ] }
        })
        this.indexBuffer = indexBuffer({
            name: 'Index Buffer (Terrain Index)',
            randomAccessible: true,
            resource: { arrayRef: aRef(new Uint32Array(indices)) }
        })
        this.nodeLevelBuffer = storageBuffer({
            name: 'Storage Buffer (Node level)',
            resource: { arrayRef: this.nodeLevelArray }
        })
        this.nodeBoxBuffer = storageBuffer({
            name: 'Storage Buffer (Node bBox)',
            resource: { arrayRef: this.nodeBoxArray }
        })
        this.tileBuffer = uniformBuffer({
            name: 'Uniform Buffer (Tile global dynamic)',
            blocks: [
                bRef({
                    name: 'tileUniform',
                    dynamic: true,
                    map: {
                        tileBox: this.tileBox.boundary,
                        levelRange: this.visibleNodeLevel,
                        sectorRange: this.sectorRange,
                        sectorSize: this.sectorSize,
                        exaggeration: this.exaggeration,
                    }
                }),
            ]
        })
        this.gStaticBuffer = uniformBuffer({
            name: 'Uniform Buffer (Terrain global static status)',
            blocks: [
                bRef({
                    name: 'block',
                    map: {
                        terrainBox: this.boundaryCondition.boundary,
                        e: this.elevationRange,
                    }
                }),
            ]
        })

        // Texture-related resource
        this.lSampler = sampler({
            name: 'Sampler (linear)',
            filterMinMag: ['linear', 'linear'],
            addressModeUVW: ['clamp-to-edge', 'clamp-to-edge'],
        })
        this.demTexture = imageLoader.load('Texture (DEM)', '/images/examples/terrain/dem.png')
        this.borderTexture = imageLoader.load('Texture (DEM Border)', '/images/examples/terrain/border.png')
        this.paletteTexture = imageLoader.load('Texture (DEM Palette)', '/images/examples/terrain/demPalette10.png')
        this.lodMapTexture = texture({
            name: 'Texture (LOD Map)',
            resource: { size: () => this.lodMapSize.array }
        })

        // Binding
        this.lodMapBinding = binding({
            name: `Binding (Terrain LoDMap)`,
            range: () => [ 4, this.bindingUsed ],
            uniforms: [
                {
                    name: 'mapUniform',
                    map: {
                        dimensions: asVec2f(this.lodMapTexture.width, this.lodMapTexture.height),
                    }
                }
            ],
            sharedUniforms: [
                { buffer: this.tileBuffer },
                { buffer: this.gStaticBuffer },
            ],
            storages: [
                { buffer: this.nodeLevelBuffer },
                { buffer: this.nodeBoxBuffer },
            ],
        })
        this.meshBinding = binding({
            name: `Binding (Terrain Node)`,
            range: () => [ this.indexNum / 3 * (this.asLine ? 6 : 3), this.bindingUsed ],
            sharedUniforms: [
                { buffer: this.tileBuffer },
                { buffer: this.gStaticBuffer },
                { buffer: gDynamicBuffer }
            ],
            samplers: [ {sampler: this.lSampler} ],
            textures: [
                { texture: this.demTexture },
                { texture: this.lodMapTexture },
                { texture: this.paletteTexture },
            ],
            storages: [
                { buffer: this.indexBuffer },
                { buffer: this.positionBuffer },
                { buffer: this.nodeLevelBuffer },
                { buffer: this.nodeBoxBuffer },
            ],
        })

        // Pipeline
        this.lodMapPipeline = renderPipeline({
            name: 'Render Pipeline (LOD Map)',
            shader: { module: shaderLoader.load('Shader (Terrain Mesh)', '/shaders/examples/terrain/lodMap.wgsl') },
            primitive: { topology: 'triangle-strip' },
        })
        this.meshRenderPipeline = renderPipeline({
            name: 'Render Pipeline (Terrain Mesh)',
            shader: { module: shaderLoader.load('Shader (Terrain Mesh)', '/shaders/examples/terrain/terrainMesh.wgsl') },
            colorTargetStates: [ { blend: NoBlending } ],
            // depthTest: true,
        })
        this.meshLineRenderPipeline = renderPipeline({
            name: 'Render Pipeline (Terrain Mesh)',
            shader: { module: shaderLoader.load('Shader (Terrain Mesh Line)', '/shaders/examples/terrain/terrainMeshLine.wgsl') },
            // depthTest: true,
            primitive: { topology: 'line-list' },
        })

        // Pass
        this.lodMapPass = renderPass({
            name: 'Render Pass (LOD Map)',
            colorAttachments: [ { colorResource: this.lodMapTexture } ]
        }).add(this.lodMapPipeline, this.lodMapBinding)

        return this
    }

    set minVisibleNodeLevel (min) {
        this.visibleNodeLevel.x = min
    }

    get minVisibleNodeLevel () {
        return this.visibleNodeLevel.x
    }

    set maxVisibleNodeLevel (max) {
        this.visibleNodeLevel.y = max
    }

    get maxVisibleNodeLevel () {
        return this.visibleNodeLevel.y
    }

    get prePass() {
        
        return this.lodMapPass
    }

    get pipeline() {

        return this.asLine ? this.meshLineRenderPipeline : this.meshRenderPipeline
    }

    get binding() {

        return this.meshBinding
    }

    /**
     * @param {MapOptions} options 
     */
    registerRenderableNode(options) {
        
        // Reset uiform-related member per frame
        this.tileBox.reset()
        this.sectorRange.reset()
        this.bindingUsed = 0
        this.maxVisibleNodeLevel = 0
        this.minVisibleNodeLevel = this.maxLevel

        // Find visible terrain nodes
        /** @type { Node2D[] } */ const stack = [] 
        /** @type { Node2D[] } */ const visibleNode = []
        stack.push(new Node2D(0, 0))
        stack.push(new Node2D(0, 1))
        while(stack.length > 0) {
            
            let node = stack.pop()

            // Termination condition #1
            if (!node.bBox.overlap(this.boundaryCondition)) continue
            // Termination condition #2
            if (!node.isSubdividable(options) || node.level >= Math.min(this.maxLevel, options.zoomLevel)) {
                
                visibleNode.push(node)
                // Update the sector size used for rendering
                if (node.level > this.maxVisibleNodeLevel) {

                    this.sectorRange.x = node.bBox.size[0]
                    this.sectorRange.y = node.bBox.size[1]
                    this.maxVisibleNodeLevel = node.level
                }
                continue
            }

            // If the terrain node is subdividable
            // Create its child nodes
            for (let i = 0; i < 4; i++) {

                node.children[i] = new Node2D(node.level + 1, 4 * node.id + i, node)
                stack.push(node.children[i])
            }
        }

        // Further determinate the real visible nodes
        // Give priority to high-level ones ?
        visibleNode./*sort((a, b) => a.level - b.level).*/forEach(node => {

            if (this.bindingUsed < this.maxBindingUsedNum && node.level + 5 >= this.maxVisibleNodeLevel) {

                this.minVisibleNodeLevel = node.level < this.minVisibleNodeLevel ? node.level : this.minVisibleNodeLevel
                this.tileBox.updateByBox(node.bBox)
    
                this.nodeLevelArray.element(this.bindingUsed, node.level)
                this.nodeBoxArray.element(this.bindingUsed * 4 + 0, node.bBox.boundary.x)
                this.nodeBoxArray.element(this.bindingUsed * 4 + 1, node.bBox.boundary.y)
                this.nodeBoxArray.element(this.bindingUsed * 4 + 2, node.bBox.boundary.z)
                this.nodeBoxArray.element(this.bindingUsed * 4 + 3, node.bBox.boundary.w)
    
                this.bindingUsed++
            }

            node.release()
        })
    }
}