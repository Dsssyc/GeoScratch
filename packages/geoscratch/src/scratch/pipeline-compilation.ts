export type PipelineKind = 'render' | 'compute'

export const PIPELINE_COMPILATION_MAX_MODULE_FACTS = 256
export const PIPELINE_COMPILATION_MAX_MESSAGES = 64
export const PIPELINE_COMPILATION_MAX_MESSAGE_LENGTH = 4_096
export const PIPELINE_COMPILATION_MAX_EVIDENCE_BYTES = 64 * 1024

export type PipelineCompilationModuleFact = Readonly<{
    index: number
    hash: string
    startOffset: number
    endOffset: number
    startLine: number
    endLine: number
    lineCount: number
}>

export type PipelineCompilationNativeLocation = Readonly<{
    offset: number
    length: number
    lineNum: number
    linePos: number
}>

export type PipelineCompilationModuleLocation = Readonly<{
    moduleIndex: number
    offset: number
    length: number
    lineNum: number
    linePos: number
}>

export type PipelineCompilationMessage = Readonly<{
    nativeIndex: number
    type: GPUCompilationMessageType
    message: string
    messageTruncated: boolean
    locationKind: 'unknown' | 'module' | 'separator' | 'unmapped'
    nativeLocation: PipelineCompilationNativeLocation
    moduleLocation?: PipelineCompilationModuleLocation
}>

export type PipelineCompilationReport = Readonly<{
    version: 1
    pipelineId: string
    pipelineKind: PipelineKind
    programId: string
    combinedSourceHash: string
    moduleCount: number
    retainedModuleCount: number
    omittedModuleCount: number
    modules: readonly PipelineCompilationModuleFact[]
    errorCount: number
    warningCount: number
    infoCount: number
    nativeMessageCount: number
    retainedMessageCount: number
    omittedMessageCount: number
    retainedEvidenceBytes: number
    messages: readonly PipelineCompilationMessage[]
}>
