import { expect } from 'chai'
import {
    createPipelineCompilationReport,
    hashPipelineSource,
    snapshotPipelineSource,
} from '../packages/geoscratch/dist/scratch/pipeline-compilation.js'
import { serializedEvidenceBytes } from '../packages/geoscratch/dist/scratch/gpu-operation.js'

describe('scratch pipeline source snapshots', () => {

    it('copies modules and combines them with exactly one LF separator', () => {

        const modules = [ 'a', 'b' ]
        const snapshot = snapshotPipelineSource({
            id: 'program-1',
            modules,
        })
        modules[0] = 'changed after snapshot'
        modules.push('new module')

        expect(snapshot.programId).to.equal('program-1')
        expect(snapshot.modules).to.deep.equal([ 'a', 'b' ])
        expect(snapshot.combinedSource).to.equal('a\nb')
        expect(snapshot.combinedSourceHash).to.equal(hashPipelineSource('a\nb'))
        expect(snapshot.moduleFacts.map(module => module.hash)).to.deep.equal([
            hashPipelineSource('a'),
            hashPipelineSource('b'),
        ])
        expect(snapshot.moduleFacts).to.deep.equal([
            {
                index: 0,
                hash: hashPipelineSource('a'),
                startOffset: 0,
                endOffset: 1,
                startLine: 1,
                endLine: 1,
                lineCount: 1,
            },
            {
                index: 1,
                hash: hashPipelineSource('b'),
                startOffset: 2,
                endOffset: 3,
                startLine: 2,
                endLine: 2,
                lineCount: 1,
            },
        ])
        expect(snapshot.separatorOffsets).to.deep.equal([ 1 ])
        expect(hashPipelineSource('abc')).to.equal('fnv1a-1a47e90b')
        expect(Object.isFrozen(snapshot)).to.equal(true)
        expect(Object.isFrozen(snapshot.modules)).to.equal(true)
        expect(Object.isFrozen(snapshot.moduleFacts[0])).to.equal(true)
        expect(Object.isFrozen(snapshot.separatorOffsets)).to.equal(true)
    })

    it('measures empty, CRLF, lone newline, and non-ASCII modules in UTF-16 code units', () => {

        const snapshot = snapshotPipelineSource({
            id: 'program-lines-1',
            modules: [ '', 'α\r\nβ\rc\n', '', '😀z' ],
        })

        expect(snapshot.combinedSource).to.equal('\nα\r\nβ\rc\n\n\n😀z')
        expect(snapshot.combinedSource.length).to.equal(13)
        expect(snapshot.separatorOffsets).to.deep.equal([ 0, 8, 9 ])
        expect(snapshot.moduleFacts).to.deep.equal([
            {
                index: 0,
                hash: hashPipelineSource(''),
                startOffset: 0,
                endOffset: 0,
                startLine: 1,
                endLine: 1,
                lineCount: 1,
            },
            {
                index: 1,
                hash: hashPipelineSource('α\r\nβ\rc\n'),
                startOffset: 1,
                endOffset: 8,
                startLine: 2,
                endLine: 5,
                lineCount: 4,
            },
            {
                index: 2,
                hash: hashPipelineSource(''),
                startOffset: 9,
                endOffset: 9,
                startLine: 6,
                endLine: 6,
                lineCount: 1,
            },
            {
                index: 3,
                hash: hashPipelineSource('😀z'),
                startOffset: 10,
                endOffset: 13,
                startLine: 7,
                endLine: 7,
                lineCount: 1,
            },
        ])
        expect(snapshot.moduleLineStarts).to.deep.equal([
            [ 0 ],
            [ 0, 3, 5, 7 ],
            [ 0 ],
            [ 0 ],
        ])
    })

    it('counts a trailing module CR plus the inserted LF as one cross-boundary CRLF', () => {

        const snapshot = snapshotPipelineSource({
            id: 'program-cross-boundary-crlf',
            modules: [ 'a\r', 'b', 'c\r' ],
        })

        expect(snapshot.combinedSource).to.equal('a\r\nb\nc\r')
        expect(snapshot.separatorOffsets).to.deep.equal([ 2, 4 ])
        expect(snapshot.moduleFacts).to.deep.equal([
            {
                index: 0,
                hash: hashPipelineSource('a\r'),
                startOffset: 0,
                endOffset: 2,
                startLine: 1,
                endLine: 1,
                lineCount: 1,
            },
            {
                index: 1,
                hash: hashPipelineSource('b'),
                startOffset: 3,
                endOffset: 4,
                startLine: 2,
                endLine: 2,
                lineCount: 1,
            },
            {
                index: 2,
                hash: hashPipelineSource('c\r'),
                startOffset: 5,
                endOffset: 7,
                startLine: 3,
                endLine: 4,
                lineCount: 2,
            },
        ])
        expect(snapshot.moduleLineStarts).to.deep.equal([
            [ 0 ],
            [ 0 ],
            [ 0, 2 ],
        ])
    })

    it('counts a complete trailing CRLF before counting the inserted LF', () => {

        const snapshot = snapshotPipelineSource({
            id: 'program-complete-trailing-crlf',
            modules: [ 'a\r\n', 'b' ],
        })

        expect(snapshot.combinedSource).to.equal('a\r\n\nb')
        expect(snapshot.separatorOffsets).to.deep.equal([ 3 ])
        expect(snapshot.moduleFacts).to.deep.equal([
            {
                index: 0,
                hash: hashPipelineSource('a\r\n'),
                startOffset: 0,
                endOffset: 3,
                startLine: 1,
                endLine: 2,
                lineCount: 2,
            },
            {
                index: 1,
                hash: hashPipelineSource('b'),
                startOffset: 4,
                endOffset: 5,
                startLine: 3,
                endLine: 3,
                lineCount: 1,
            },
        ])
        expect(snapshot.moduleLineStarts).to.deep.equal([ [ 0, 3 ], [ 0 ] ])
    })
})

describe('scratch pipeline compilation location mapping', () => {

    it('maps only known UTF-16 offsets inside one Program module', () => {

        const sourceSnapshot = snapshotPipelineSource({
            id: 'program-mapping-1',
            modules: [ '', 'α\r\nβ\rc\n', '', '😀z' ],
        })
        const messages = [
            compilationMessage('info', 'unknown', 0, 0, 0, 0),
            compilationMessage('warning', 'first separator', 0, 1, 1, 1),
            compilationMessage('error', 'alpha', 1, 1, 2, 1),
            compilationMessage('info', 'CRLF LF code unit', 3, 1, 2, 3),
            compilationMessage('warning', 'beta', 4, 1, 3, 1),
            compilationMessage('error', 'c after lone CR', 6, 1, 4, 1),
            compilationMessage('info', 'module newline', 7, 1, 4, 2),
            compilationMessage('warning', 'second separator', 8, 1, 6, 1),
            compilationMessage('info', 'empty module separator', 9, 1, 7, 1),
            compilationMessage('error', 'low surrogate', 11, 1, 7, 2),
            compilationMessage('info', 'one past final module', 13, 0, 7, 4),
            compilationMessage('warning', 'beyond combined source', 99, 1, 99, 1),
        ]
        const report = createPipelineCompilationReport({
            pipelineId: 'pipeline-mapping-1',
            pipelineKind: 'render',
            sourceSnapshot,
            compilationInfo: { messages },
        })

        expect(report.pipelineId).to.equal('pipeline-mapping-1')
        expect(report.pipelineKind).to.equal('render')
        expect(report.programId).to.equal(sourceSnapshot.programId)
        expect(report.combinedSourceHash).to.equal(sourceSnapshot.combinedSourceHash)
        expect(report.errorCount).to.equal(messages.filter(message => message.type === 'error').length)
        expect(report.warningCount).to.equal(messages.filter(message => message.type === 'warning').length)
        expect(report.infoCount).to.equal(messages.filter(message => message.type === 'info').length)
        expect(report.messages.map(message => message.message)).to.deep.equal(
            messages.map(message => message.message)
        )
        expect(report.messages.map(message => message.nativeIndex)).to.deep.equal(
            messages.map((_, index) => index)
        )
        expect(report.messages[0].locationKind).to.equal('unknown')
        expect(report.messages[0]).not.to.have.property('moduleLocation')
        expect(report.messages[1].locationKind).to.equal('separator')
        expect(report.messages[1]).not.to.have.property('moduleLocation')
        expect(report.messages[2].moduleLocation).to.deep.equal({
            moduleIndex: 1,
            offset: 0,
            length: 1,
            lineNum: 1,
            linePos: 1,
        })
        expect(report.messages[3].moduleLocation).to.deep.equal({
            moduleIndex: 1,
            offset: 2,
            length: 1,
            lineNum: 1,
            linePos: 3,
        })
        expect(report.messages[4].moduleLocation).to.deep.equal({
            moduleIndex: 1,
            offset: 3,
            length: 1,
            lineNum: 2,
            linePos: 1,
        })
        expect(report.messages[5].moduleLocation).to.deep.equal({
            moduleIndex: 1,
            offset: 5,
            length: 1,
            lineNum: 3,
            linePos: 1,
        })
        expect(report.messages[6].moduleLocation).to.deep.equal({
            moduleIndex: 1,
            offset: 6,
            length: 1,
            lineNum: 3,
            linePos: 2,
        })
        expect(report.messages[7].locationKind).to.equal('separator')
        expect(report.messages[8].locationKind).to.equal('separator')
        expect(report.messages[9].moduleLocation).to.deep.equal({
            moduleIndex: 3,
            offset: 1,
            length: 1,
            lineNum: 1,
            linePos: 2,
        })
        expect(report.messages[10].locationKind).to.equal('unmapped')
        expect(report.messages[11].locationKind).to.equal('unmapped')
        expect(report.messages[2].nativeLocation).to.deep.equal({
            offset: 1,
            length: 1,
            lineNum: 2,
            linePos: 1,
        })
        expect(report.retainedEvidenceBytes).to.equal(serializedEvidenceBytes(report))
        expect(Object.isFrozen(report)).to.equal(true)
        expect(Object.isFrozen(report.messages[2].moduleLocation)).to.equal(true)
        expect(JSON.parse(JSON.stringify(report))).to.deep.equal(report)
        expect(JSON.stringify(report)).not.to.include(sourceSnapshot.combinedSource)
    })

    it('bounds retained evidence while preserving complete counts and omitted-module mapping', () => {

        const sourceSentinel = 'WGSL_SOURCE_SENTINEL_MUST_NOT_BE_RETAINED'
        const sourceSnapshot = snapshotPipelineSource({
            id: 'program-bounded-report-1',
            modules: Array.from(
                { length: 300 },
                (_, index) => `fn module${index}() {} // ${sourceSentinel}-${index}`
            ),
        })
        const messages = Array.from({ length: 80 }, (_, index) => compilationMessage(
            index % 3 === 0 ? 'error' : index % 3 === 1 ? 'warning' : 'info',
            index === 0 ? '😀'.repeat(3_000) : `native-${index}-${'x'.repeat(5_000)}`,
            index === 0 ? sourceSnapshot.moduleFacts[299].startOffset : 0,
            index === 0 ? 2 : 0,
            index === 0 ? sourceSnapshot.moduleFacts[299].startLine : 0,
            index === 0 ? 1 : 0
        ))
        const report = createPipelineCompilationReport({
            pipelineId: 'pipeline-bounded-report-1',
            pipelineKind: 'compute',
            sourceSnapshot,
            compilationInfo: { messages },
        })

        expect(report.moduleCount).to.equal(300)
        expect(report.retainedModuleCount).to.be.at.most(256)
        expect(report.omittedModuleCount).to.equal(300 - report.retainedModuleCount)
        expect(report.modules.map(module => module.index)).to.deep.equal(
            Array.from({ length: report.retainedModuleCount }, (_, index) => index)
        )
        expect(report.nativeMessageCount).to.equal(80)
        expect(report.retainedMessageCount).to.be.at.most(64)
        expect(report.omittedMessageCount).to.equal(80 - report.retainedMessageCount)
        expect(report.errorCount).to.equal(messages.filter(message => message.type === 'error').length)
        expect(report.warningCount).to.equal(messages.filter(message => message.type === 'warning').length)
        expect(report.infoCount).to.equal(messages.filter(message => message.type === 'info').length)
        expect(report.messages.map(message => message.nativeIndex)).to.deep.equal(
            Array.from({ length: report.retainedMessageCount }, (_, index) => index)
        )
        expect(report.messages[0].message.length).to.be.at.most(4_096)
        expect(report.messages[0].message.endsWith('...')).to.equal(true)
        expect(report.messages[0].messageTruncated).to.equal(true)
        expect(report.messages[0].message.charCodeAt(report.messages[0].message.length - 4))
            .not.to.be.within(0xD800, 0xDBFF)
        expect(report.messages[0].moduleLocation.moduleIndex).to.equal(299)
        expect(report.modules.some(module => module.index === 299)).to.equal(false)
        expect(report.retainedEvidenceBytes).to.equal(serializedEvidenceBytes(report))
        expect(report.retainedEvidenceBytes).to.be.at.most(64 * 1024)
        expect(JSON.stringify(report)).not.to.include(sourceSentinel)
    })

    it('rejects malformed source snapshots and compilation information structurally', () => {

        expect(() => snapshotPipelineSource({ id: 'empty', modules: [] }))
            .to.throw(TypeError, 'non-empty string module array')
        expect(() => snapshotPipelineSource({ id: 'invalid', modules: [ null ] }))
            .to.throw(TypeError, 'non-empty string module array')
        expect(() => snapshotPipelineSource({ id: null, modules: [ 'x' ] }))
            .to.throw(TypeError, 'Program ID')

        const sourceSnapshot = snapshotPipelineSource({
            id: 'program-structural-1',
            modules: [ 'fn main() {}' ],
        })
        const descriptor = {
            pipelineId: 'pipeline-structural-1',
            pipelineKind: 'compute',
            sourceSnapshot,
        }
        const malformed = [
            null,
            {},
            { messages: null },
            { messages: [ null ] },
            { messages: [ compilationMessage('fatal', 'bad type', 0, 0, 0, 0) ] },
            { messages: [ { ...compilationMessage('info', 'bad text', 0, 0, 0, 0), message: 1 } ] },
            { messages: [ compilationMessage('info', 'negative offset', -1, 0, 1, 1) ] },
            { messages: [ compilationMessage('info', 'fractional length', 0, 0.5, 1, 1) ] },
        ]
        for (const compilationInfo of malformed) {
            expect(() => createPipelineCompilationReport({
                ...descriptor,
                compilationInfo,
            })).to.throw(TypeError)
        }
        expect(() => createPipelineCompilationReport({
            ...descriptor,
            pipelineKind: 'graphics',
            compilationInfo: { messages: [] },
        })).to.throw(TypeError, 'render or compute kind')
    })
})

function compilationMessage(type, message, offset, length, lineNum, linePos) {

    return { type, message, offset, length, lineNum, linePos }
}
