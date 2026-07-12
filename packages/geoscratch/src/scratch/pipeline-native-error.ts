import { serializeNativeGpuError } from './gpu-operation.js'
import {
    createPipelineSourceRedactionIndex,
    sanitizePipelineEvidenceText,
} from './pipeline-compilation.js'
import type { ScratchNativeGpuErrorFacts } from './gpu-operation.js'
import type { PipelineSourceSnapshot } from './pipeline-compilation.js'

export type PipelineNativeErrorSerializer = (error: unknown) => ScratchNativeGpuErrorFacts

export function createPipelineNativeErrorSerializer(
    sourceSnapshot: PipelineSourceSnapshot
): PipelineNativeErrorSerializer {

    let sourceIndex: ReturnType<typeof createPipelineSourceRedactionIndex> | undefined
    return (error: unknown) => {
        const facts = serializeNativeGpuError(error)
        sourceIndex ??= createPipelineSourceRedactionIndex(sourceSnapshot.combinedSource)
        const message = sanitizePipelineEvidenceText(facts.message, sourceIndex)
        const name = facts.name === undefined
            ? undefined
            : sanitizePipelineEvidenceText(facts.name, sourceIndex, 256)
        const reason = facts.reason === undefined
            ? undefined
            : sanitizePipelineEvidenceText(facts.reason, sourceIndex, 256)
        const sourceExcerptRedacted = message.sourceExcerptRedacted ||
            name?.sourceExcerptRedacted === true ||
            reason?.sourceExcerptRedacted === true
        const truncated = facts.truncated === true || message.truncated ||
            name?.truncated === true || reason?.truncated === true
        return Object.freeze({
            ...(name !== undefined ? { name: name.message } : {}),
            message: message.message,
            ...(reason !== undefined ? { reason: reason.message } : {}),
            ...(truncated ? { truncated: true } : {}),
            ...(sourceExcerptRedacted ? { sourceExcerptRedacted: true } : {}),
            ...(facts.nativeMessageOmitted === true ? { nativeMessageOmitted: true } : {}),
        })
    }
}
