import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ordinaryExamples = [
    'helloTriangle',
    'uniformTriangle',
    'computeReadback',
    'submissionOrder',
    'externalImageUpload',
    'textureResize',
    'helloVertexBuffer',
    'textureSampling',
    'renderToTexture',
    'indirectExecution',
    'readinessPolicies',
]
const additionalOrdinaryFiles = [
    'examples/demLayer/main.js',
    'examples/demLayer/dem-layer.js',
    'examples/demLayer/dem-map.js',
    'examples/flowLayer/main.js',
    'examples/flowLayer/flow-layer.js',
    'examples/flowLayer/flow-map.js',
]
const supportingFactories = new Set([
    'createSampler',
    'sampler',
    'createQuerySet',
    'querySet',
    'createBindLayout',
    'bindLayout',
    'createBindSet',
    'bindSet',
])

describe('ordinary Scratch example target API audit', () => {

    it('uses only persistent binding views and Promise-only supporting factories', () => {

        const violations = [
            ...ordinaryExamples.map(name => `examples/${name}/main.js`),
            ...additionalOrdinaryFiles,
        ].flatMap(relativePath => auditExample(relativePath))
        expect(violations).to.deep.equal([])
    })
})

function auditExample(relativePath) {

    const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
    const sourceFile = ts.createSourceFile(
        relativePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS
    )
    const variables = collectResourceVariables(sourceFile)
    const violations = []
    const report = (node, message) => {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        violations.push(`${relativePath}:${line + 1} ${message}`)
    }

    visit(sourceFile, (node) => {
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return

        const method = node.expression.name.text
        if (method === 'createView' || method === 'getBindGroup') {
            report(node, `uses removed ${method}()`)
        }
        if (supportingFactories.has(method) && !isAwaited(node)) {
            report(node, `${method}() is not awaited`)
        }

        const descriptor = objectArgument(node, method === 'createBindSet' || method === 'bindSet' ? 1 : 0)
        if (descriptor === undefined) return

        if (method === 'createBindSet' || method === 'bindSet') {
            for (const property of objectProperties(descriptor)) {
                const value = propertyValue(property)
                if (isTrackedIdentifier(value, variables.buffers)) {
                    report(value, 'binds a whole BufferResource instead of BufferRegion')
                }
                if (isTrackedIdentifier(value, variables.textures)) {
                    report(value, 'binds a whole TextureResource instead of TextureViewSpec')
                }
            }
        }

        if (method === 'createUploadCommand' || method === 'uploadCommand') {
            rejectTrackedProperty(descriptor, 'target', variables.buffers, report,
                'uploads to a whole BufferResource instead of BufferRegion')
            rejectProperty(descriptor, 'offset', report, 'uses removed UploadCommand offset')
        }

        if (method === 'createReadback' || method === 'readback') {
            rejectTrackedProperty(descriptor, 'source', variables.buffers, report,
                'reads a whole BufferResource instead of BufferRegion')
            rejectProperty(descriptor, 'range', report, 'uses removed readback range')
        }

        if (method === 'createReadbackCommand' || method === 'readbackCommand') {
            rejectBufferCopySource(descriptor, variables.buffers, report)
            rejectProperty(descriptor, 'sourceOffset', report, 'uses removed readback sourceOffset')
            rejectProperty(descriptor, 'byteLength', report, 'uses removed readback byteLength')
        }

        if (method === 'createCopyCommand' || method === 'copyCommand') {
            rejectTrackedProperty(descriptor, 'target', variables.buffers, report,
                'copies to a whole BufferResource instead of BufferRegion')
            rejectBufferCopySource(descriptor, variables.buffers, report)
            for (const layoutName of [ 'sourceLayout', 'targetLayout' ]) {
                const layout = objectPropertyValue(descriptor, layoutName)
                if (layout !== undefined && ts.isObjectLiteralExpression(layout)) {
                    rejectProperty(layout, 'offset', report,
                        `uses removed ${layoutName}.offset instead of a BufferRegion offset`)
                }
            }
        }

        if (method === 'createResolveQuerySetCommand' || method === 'resolveQuerySetCommand') {
            rejectTrackedProperty(descriptor, 'destination', variables.buffers, report,
                'resolves into a whole BufferResource instead of BufferRegion')
            rejectProperty(descriptor, 'destinationOffset', report,
                'uses removed query resolve destinationOffset')
        }

        if (method === 'createDrawCommand' || method === 'drawCommand') {
            rejectLegacyDrawBindings(descriptor, report)
            rejectIndirectBuffer(descriptor, variables.buffers, report)
        }
        if (method === 'createDispatchCommand' || method === 'dispatchCommand') {
            rejectIndirectBuffer(descriptor, variables.buffers, report)
        }

        if (method === 'createRenderPass' || method === 'renderPass') {
            visit(descriptor, (candidate) => {
                if (!ts.isPropertyAssignment(candidate) || propertyName(candidate) !== 'target') return
                if (isTrackedIdentifier(candidate.initializer, variables.textures)) {
                    report(candidate.initializer,
                        'uses a whole TextureResource attachment instead of TextureViewSpec')
                }
            })
        }
    })

    return violations
}

function collectResourceVariables(sourceFile) {

    const buffers = new Set()
    const textures = new Set()
    const bufferPromises = new Set()
    const texturePromises = new Set()

    visit(sourceFile, (node) => {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.initializer === undefined) return

        const initializer = unwrapExpression(node.initializer)
        if (ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression)) {
            const method = initializer.expression.name.text
            const directlyAwaited = ts.isAwaitExpression(unwrapParentheses(node.initializer))
            if (method === 'createBuffer' || method === 'buffer') {
                const target = directlyAwaited ? buffers : bufferPromises
                target.add(node.name.text)
            }
            if (method === 'createTexture' || method === 'texture') {
                const target = directlyAwaited ? textures : texturePromises
                target.add(node.name.text)
            }
            return
        }

        const raw = unwrapParentheses(node.initializer)
        if (ts.isAwaitExpression(raw) && ts.isIdentifier(unwrapParentheses(raw.expression))) {
            const awaitedName = unwrapParentheses(raw.expression).text
            if (bufferPromises.has(awaitedName)) buffers.add(node.name.text)
            if (texturePromises.has(awaitedName)) textures.add(node.name.text)
        }
    })

    return { buffers, textures }
}

function rejectBufferCopySource(descriptor, buffers, report) {

    const source = objectPropertyValue(descriptor, 'source')
    if (isTrackedIdentifier(source, buffers)) {
        report(source, 'reads a whole BufferResource instead of BufferRegion')
        return
    }
    if (source === undefined || !ts.isObjectLiteralExpression(source)) return

    const resource = objectPropertyValue(source, 'resource')
    if (isTrackedIdentifier(resource, buffers)) {
        report(resource, 'uses source.resource for a buffer instead of source.region')
    }
}

function rejectLegacyDrawBindings(descriptor, report) {

    const vertexBuffers = objectPropertyValue(descriptor, 'vertexBuffers')
    if (vertexBuffers !== undefined && ts.isArrayLiteralExpression(vertexBuffers)) {
        for (const element of vertexBuffers.elements) {
            if (ts.isObjectLiteralExpression(element)) {
                rejectProperty(element, 'buffer', report,
                    'uses removed vertex buffer field instead of region')
            }
        }
    }

    const indexBuffer = objectPropertyValue(descriptor, 'indexBuffer')
    if (indexBuffer !== undefined && ts.isObjectLiteralExpression(indexBuffer)) {
        rejectProperty(indexBuffer, 'buffer', report,
            'uses removed index buffer field instead of region')
        rejectProperty(indexBuffer, 'offset', report,
            'uses removed index buffer offset instead of a BufferRegion offset')
        rejectProperty(indexBuffer, 'size', report,
            'uses removed index buffer size instead of a BufferRegion size')
    }
}

function rejectIndirectBuffer(descriptor, buffers, report) {

    const count = objectPropertyValue(descriptor, 'count')
    if (count === undefined || !ts.isObjectLiteralExpression(count)) return
    rejectTrackedProperty(count, 'indirect', buffers, report,
        'uses a whole indirect BufferResource instead of BufferRegion')
}

function rejectTrackedProperty(object, name, tracked, report, message) {

    const value = objectPropertyValue(object, name)
    if (isTrackedIdentifier(value, tracked)) report(value, message)
}

function rejectProperty(object, name, report, message) {

    const property = objectProperties(object).find((candidate) => propertyName(candidate) === name)
    if (property !== undefined) report(property, message)
}

function objectArgument(call, index) {

    const argument = call.arguments[index]
    return argument !== undefined && ts.isObjectLiteralExpression(argument) ? argument : undefined
}

function objectPropertyValue(object, name) {

    const property = objectProperties(object).find((candidate) => propertyName(candidate) === name)
    return property === undefined ? undefined : propertyValue(property)
}

function objectProperties(object) {

    return object.properties.filter((property) => (
        ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
    ))
}

function propertyName(property) {

    if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text
    return undefined
}

function propertyValue(property) {

    return ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer
}

function isTrackedIdentifier(value, tracked) {

    const expression = value === undefined ? undefined : unwrapExpression(value)
    return expression !== undefined && ts.isIdentifier(expression) && tracked.has(expression.text)
}

function isAwaited(call) {

    let parent = call.parent
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent
    return ts.isAwaitExpression(parent)
}

function unwrapExpression(expression) {

    const unwrapped = unwrapParentheses(expression)
    return ts.isAwaitExpression(unwrapped) ? unwrapParentheses(unwrapped.expression) : unwrapped
}

function unwrapParentheses(expression) {

    let current = expression
    while (ts.isParenthesizedExpression(current)) current = current.expression
    return current
}

function visit(node, visitor) {

    visitor(node)
    ts.forEachChild(node, (child) => visit(child, visitor))
}
