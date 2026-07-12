import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const pipelineFamilies = [
    {
        kind: 'render',
        createMethod: 'createRenderPipeline',
        aliasMethod: 'renderPipeline',
        intentionalPromiseFiles: new Set([
            'tests/scratch-async-pipeline-contract.test.js',
            'tests/scratch-compute-pipeline-async.test.js',
            'tests/scratch-render-pipeline-async.test.js',
            'tests/types/public-api.ts',
        ]),
        legacyFiles: new Set([
            'examples/1_helloTriangle/main.js',
            'examples/m_flowLayer/steadyFlowLayer.js',
            'examples/x_helloGAW/main.js',
            'tests/types/public-api.ts',
        ]),
    },
    {
        kind: 'compute',
        createMethod: 'createComputePipeline',
        aliasMethod: 'computePipeline',
        intentionalPromiseFiles: new Set([
            'tests/scratch-async-pipeline-contract.test.js',
            'tests/scratch-compute-pipeline-async.test.js',
            'tests/types/public-api.ts',
        ]),
        legacyFiles: new Set([
            'examples/m_flowLayer/steadyFlowLayer.js',
            'examples/x_helloGAW/main.js',
            'tests/types/public-api.ts',
        ]),
    },
]

describe('scratch async pipeline consumer audit', () => {

    for (const family of pipelineFamilies) {
        it(`awaits every ordinary Scratch ${family.kind} consumer and classifies legacy calls`, () => {

            const violations = []
            const legacyCalls = []
            for (const relativePath of sourceFiles('tests', 'examples')) {
                const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
                const sourceFile = ts.createSourceFile(
                    relativePath,
                    source,
                    ts.ScriptTarget.Latest,
                    true,
                    relativePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
                )
                visitCalls(sourceFile, (call) => {
                    const method = call.expression.name.text
                    if (method !== family.createMethod && method !== family.aliasMethod) return

                    const receiver = call.expression.expression.getText(sourceFile)
                    const location = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile))
                    const reference = `${relativePath}:${location.line + 1}`
                    if (method === family.aliasMethod && receiver === 'scr') {
                        legacyCalls.push(reference)
                        if (!family.legacyFiles.has(relativePath)) {
                            violations.push(`${reference} is an unclassified legacy ${family.kind} call`)
                        }
                        if (isAwaited(call)) {
                            violations.push(`${reference} silently rewrites a legacy ${family.kind} call`)
                        }
                        return
                    }

                    if (!isAwaited(call) && !family.intentionalPromiseFiles.has(relativePath)) {
                        violations.push(`${reference} consumes a Scratch ${family.kind} pipeline without await`)
                    }
                })
            }

            expect(legacyCalls).not.to.be.empty
            expect(violations).to.deep.equal([])
        })
    }
})

function sourceFiles(...directories) {

    const files = []
    const visit = (relativeDirectory) => {
        for (const entry of fs.readdirSync(path.join(root, relativeDirectory), { withFileTypes: true })) {
            const relativePath = path.posix.join(relativeDirectory, entry.name)
            if (entry.isDirectory()) {
                if (![ 'dist', 'node_modules' ].includes(entry.name)) visit(relativePath)
            } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
                files.push(relativePath)
            }
        }
    }
    for (const directory of directories) visit(directory)
    return files.sort()
}

function visitCalls(sourceFile, visitor) {

    const visit = (node) => {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression)
        ) {
            visitor(node)
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
}

function isAwaited(call) {

    let parent = call.parent
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent
    return ts.isAwaitExpression(parent)
}
