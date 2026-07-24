import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratchRoot = path.join(root, 'packages', 'geoscratch', 'src', 'scratch')

const nativeCalls = Object.freeze([
    [ 'GPUDevice.createCommandEncoder', /\b(?:device|this\.runtime\.device)\.createCommandEncoder\(/ ],
    [ 'GPUDevice.createRenderBundleEncoder', /\bruntime\.device\.createRenderBundleEncoder\(/ ],
    [ 'GPUDevice.createBindGroup', /\b(?:this|bindSet)\.runtime\.device\.createBindGroup\(/ ],
    [ 'GPUTexture.createView', /(?:\.gpuTexture|\btexture)\.createView\(/ ],
    [ 'GPUCanvasContext.getConfiguration', /\b(?:context|state\.context)\.getConfiguration\(/ ],
    [ 'GPUCanvasContext.getCurrentTexture', /\b(?:this|identity|state|facts)\.context\.getCurrentTexture\(/ ],
    [ 'GPUDevice.importExternalTexture', /\bthis\.#runtime\.device\.importExternalTexture\(/ ],
    [ 'GPUCommandEncoder.finish', /\bencoder!?\.finish\(/ ],
    [ 'GPURenderBundleEncoder.finish', /\bbundleEncoder\.finish\(/ ],
    [ 'GPUCommandEncoder.clearBuffer', /\bcommandEncoder\.clearBuffer\(/ ],
    [ 'GPUCommandEncoder.copyBufferToBuffer', /\b(?:commandEncoder|encoder)\.copyBufferToBuffer\(/ ],
    [ 'GPUCommandEncoder.copyTextureToTexture', /\bcommandEncoder\.copyTextureToTexture\(/ ],
    [ 'GPUCommandEncoder.copyBufferToTexture', /\bcommandEncoder\.copyBufferToTexture\(/ ],
    [ 'GPUCommandEncoder.copyTextureToBuffer', /\bcommandEncoder\.copyTextureToBuffer\(/ ],
    [ 'GPUCommandEncoder.resolveQuerySet', /\bcommandEncoder\.resolveQuerySet\(/ ],
    [ 'GPUCommandEncoder.beginComputePass', /\bencoder\.beginComputePass\(/ ],
    [ 'GPUCommandEncoder.beginRenderPass', /\bencoder\.beginRenderPass\(/ ],
    [ 'GPUPassEncoder.end', /\bpassEncoder\.end\(/ ],
    [ 'GPUPassEncoder.setPipeline', /\b(?:passEncoder|bundleEncoder)\.setPipeline\(/ ],
    [ 'GPUBindingCommandsMixin.setImmediates', /\bencoder\.setImmediates\(/ ],
    [ 'GPUPassEncoder.setBindGroup', /\bpassEncoder\.setBindGroup\(/ ],
    [ 'GPURenderPassEncoder.setViewport', /\bpassEncoder\.setViewport\(/ ],
    [ 'GPURenderPassEncoder.setScissorRect', /\bpassEncoder\.setScissorRect\(/ ],
    [ 'GPURenderPassEncoder.setBlendConstant', /\bpassEncoder\.setBlendConstant\(/ ],
    [ 'GPURenderPassEncoder.setStencilReference', /\bpassEncoder\.setStencilReference\(/ ],
    [ 'GPURenderCommandsMixin.setVertexBuffer', /\b(?:passEncoder|encoder)\.setVertexBuffer\(/ ],
    [ 'GPURenderCommandsMixin.setIndexBuffer', /\b(?:passEncoder|encoder)\.setIndexBuffer\(/ ],
    [ 'GPURenderCommandsMixin.draw', /\b(?:passEncoder|encoder)\.draw\(/ ],
    [ 'GPURenderCommandsMixin.drawIndexed', /\b(?:passEncoder|encoder)\.drawIndexed\(/ ],
    [ 'GPURenderCommandsMixin.drawIndirect', /\b(?:passEncoder|encoder)\.drawIndirect\(/ ],
    [ 'GPURenderCommandsMixin.drawIndexedIndirect', /\b(?:passEncoder|encoder)\.drawIndexedIndirect\(/ ],
    [ 'GPURenderPassEncoder.executeBundles', /\bencoder\.executeBundles\(/ ],
    [ 'GPURenderPassEncoder.beginOcclusionQuery', /\bpassEncoder\.beginOcclusionQuery\(/ ],
    [ 'GPURenderPassEncoder.endOcclusionQuery', /\bpassEncoder\.endOcclusionQuery\(/ ],
    [ 'GPUComputePassEncoder.dispatchWorkgroups', /\bpassEncoder\.dispatchWorkgroups\(/ ],
    [ 'GPUComputePassEncoder.dispatchWorkgroupsIndirect', /\bpassEncoder\.dispatchWorkgroupsIndirect\(/ ],
    [ 'GPUQueue.writeBuffer', /\bqueue\.writeBuffer\(/ ],
    [ 'GPUQueue.writeTexture', /\bqueue\.writeTexture\(/ ],
    [ 'GPUQueue.copyExternalImageToTexture', /\bqueue\.copyExternalImageToTexture\(/ ],
    [ 'GPUQueue.submit', /\b(?:queue|this\.runtime\.queue)\.submit\(/ ],
    [ 'GPUDebugCommandsMixin.pushDebugGroup', /\bencoder\.pushDebugGroup!?\(/ ],
    [ 'GPUDebugCommandsMixin.popDebugGroup', /\bencoder\.popDebugGroup!?\(/ ],
    [ 'GPUDebugCommandsMixin.insertDebugMarker', /\bencoder\.insertDebugMarker\(/ ],
])

function read(...parts) {

    return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

describe('scratch submission native source audit', () => {

    it('inventories every current encoder, pass, queue, and persistent binding call site', () => {

        const audit = read(
            'docs',
            'review',
            'scratch-submission-native-provenance-audit.md'
        )
        const callSites = scanNativeCallSites(scratchRoot)
        const inventoryRows = audit.match(/^\| N\d+ \|.*\|$/gm) ?? []

        expect(callSites).to.have.length(58)
        expect(countByFile(callSites)).to.deep.equal({
            'packages/geoscratch/src/scratch/binding.ts': 4,
            'packages/geoscratch/src/scratch/command.ts': 30,
            'packages/geoscratch/src/scratch/debug-command.ts': 3,
            'packages/geoscratch/src/scratch/readback.ts': 4,
            'packages/geoscratch/src/scratch/render-bundle.ts': 3,
            'packages/geoscratch/src/scratch/submission.ts': 9,
            'packages/geoscratch/src/scratch/surface.ts': 1,
            'packages/geoscratch/src/scratch/temporal-texture.ts': 3,
            'packages/geoscratch/src/scratch/texture.ts': 1,
        })
        expect(inventoryRows).to.have.length(callSites.length)
        for (const callSite of callSites) {
            expect(audit, `${callSite.api} ${callSite.location}`)
                .to.include(`\`${callSite.location}\``)
        }
        expect(audit).to.not.match(/\| (Unresolved|Unknown|Pending) \|/)
    })

    it('keeps every submission-owned physical call under the declared observation owner', () => {

        const submission = read('packages', 'geoscratch', 'src', 'scratch', 'submission.ts')
        const pass = read('packages', 'geoscratch', 'src', 'scratch', 'pass.ts')
        const readback = read('packages', 'geoscratch', 'src', 'scratch', 'readback.ts')
        const surface = read('packages', 'geoscratch', 'src', 'scratch', 'surface.ts')
        const temporal = read('packages', 'geoscratch', 'src', 'scratch', 'temporal-texture.ts')

        for (const nativeCall of [
            'createCommandEncoder',
            'beginComputePass',
            'beginRenderPass',
            'passEncoder.end',
            'encoder!.finish',
            'this.runtime.queue.submit',
        ]) {
            expect(windowsContaining(submission, nativeCall), nativeCall)
                .to.satisfy(windows => windows.every(window => window.includes('nativeObservation.issue')))
        }
        expect(submission).to.match(
            /nativeObservation\.issue\(\s*'queue-action',[\s\S]{0,240}writeUploadCommandQueueAction/
        )
        expect(submission).to.match(
            /observation\.issue\('command-encode', location, \(\) => \{[\s\S]{0,500}issue\(\)/
        )
        expect(submission.match(/observation\.issue\(\s*'attachment-view'/g)).to.have.length(3)
        expect(submission).to.match(
            /observation\.issue\(\s*'attachment-view',[\s\S]{0,650}createNativeTextureView[\s\S]{0,500}attemptTextureAuthority\.(?:surfaceLeaseView|directSurfaceView)/
        )
        expect(submission).to.match(
            /nativeObservation\.issue\(\s*'pass-begin',[\s\S]{0,350}\(\) => encoder\.beginRenderPass\(createRenderPassDescriptor/
        )
        expect(pass).to.not.include('.getCurrentTexture()')
        expect(surface).to.not.include('.getCurrentTexture()')
        expect(temporal).to.include('this.#runtime.device.importExternalTexture({')
        expect(temporal).to.include('facts.context.getCurrentTexture()')
        expect(submission).to.match(
            /const surfaceAttachments = prepareSubmissionSurfaceAttachments\(resolvedPlan\.steps\)[\s\S]{0,450}createSubmissionNativeIssuePlan/
        )

        for (const nativeCall of [
            'device.createCommandEncoder',
            'encoder.copyBufferToBuffer',
            'encoder.finish',
            'queue.submit',
        ]) {
            expect(windowsContaining(readback, nativeCall), nativeCall)
                .to.satisfy(windows => windows.every(window => window.includes('nativeObservation.issue')))
        }
    })

    it('records direct escape paths and the acknowledged BindSet preparation boundary honestly', () => {

        const audit = read(
            'docs',
            'review',
            'scratch-submission-native-provenance-audit.md'
        )
        const command = read('packages', 'geoscratch', 'src', 'scratch', 'command.ts')
        const binding = read('packages', 'geoscratch', 'src', 'scratch', 'binding.ts')

        expect(command.match(/writeUploadCommandQueueAction\(this, queue\)/g)).to.have.length(3)
        expect(audit).to.include('direct `execute(queue)` remains explicitly deferred')
        expect(audit).to.include('manual `encode(nativeEncoder)` remains explicitly deferred')
        expect(binding).to.include('() => bindSet.runtime.device.createBindGroup(descriptor)')
        expect(audit).to.include('BindSet preparation owns persistent binding-view and bind-group creation')
        expect(audit).to.match(/independently\s+acknowledged before submission/)
        expect(audit).to.include('raw runtime.device / runtime.queue calls remain outside Scratch provenance')
    })

    it('publishes exact attribution limits for every owner class', () => {

        const audit = read(
            'docs',
            'review',
            'scratch-submission-native-provenance-audit.md'
        )
        const normalized = audit.toLowerCase().replace(/\s+/g, ' ')

        for (const marker of [
            'exact-location',
            'enclosing-submission-family',
            'temporal-correlation',
            'unknown',
            'one error per filter',
            'native prose never upgrades attribution',
            'oom does not identify one command or resource',
        ]) {
            expect(normalized).to.include(marker)
        }
    })
})

function scanNativeCallSites(directory) {

    const callSites = []
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) {
            callSites.push(...scanNativeCallSites(absolute))
            continue
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue

        const relative = path.relative(root, absolute).split(path.sep).join('/')
        for (const [ index, line ] of fs.readFileSync(absolute, 'utf8').split('\n').entries()) {
            for (const [ api, pattern ] of nativeCalls) {
                if (!pattern.test(line)) continue
                callSites.push({
                    api,
                    location: `${relative}:${index + 1}`,
                    file: relative,
                    line: index + 1,
                })
            }
        }
    }
    return callSites.sort((left, right) => (
        left.file.localeCompare(right.file) || left.line - right.line || left.api.localeCompare(right.api)
    ))
}

function countByFile(callSites) {

    return Object.fromEntries([ ...new Set(callSites.map(callSite => callSite.file)) ]
        .sort()
        .map(file => [ file, callSites.filter(callSite => callSite.file === file).length ]))
}

function windowsContaining(source, needle) {

    const lines = source.split('\n')
    return lines.flatMap((line, index) => line.includes(needle)
        ? [ lines.slice(Math.max(0, index - 8), index + 3).join('\n') ]
        : [])
}
