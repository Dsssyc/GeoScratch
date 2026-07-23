export type PipelineKind = 'render' | 'compute'

export type PipelineCreationStageFact = Readonly<{
    stage: 'vertex' | 'fragment' | 'compute'
    shaderModuleId: string
    sourceHash: string
    entryPoint?: string
    constantKeys: readonly string[]
}>

export type PipelineCreationReport = Readonly<{
    version: 1
    pipelineId: string
    pipelineKind: PipelineKind
    programId: string
    contractHash: string
    stages: readonly PipelineCreationStageFact[]
}>

export const PIPELINE_COMPILATION_MAX_MODULE_FACTS = 256
export const PIPELINE_COMPILATION_MAX_MESSAGES = 64
export const PIPELINE_COMPILATION_MAX_MESSAGE_LENGTH = 4_096
export const PIPELINE_COMPILATION_MAX_EVIDENCE_BYTES = 64 * 1024

const PIPELINE_COMPILATION_SOURCE_EXCERPT_LENGTH = 8
const PIPELINE_COMPILATION_SOURCE_REDACTION = '[WGSL excerpt redacted]'
const PIPELINE_SOURCE_REDACTION_MAX_WORKSPACE_BYTES = 32 * 1024
const PIPELINE_SOURCE_REDACTION_MIN_WORKSPACE_BYTES = 128
const PIPELINE_SOURCE_REDACTION_HASH_COUNT = 3
const PIPELINE_SOURCE_NGRAM_DOMAIN = 0x6e677261
const PIPELINE_SOURCE_TOKEN_DOMAIN = 0x746f6b65
const WGSL_IDENTIFIER_PATTERN = String.raw`(?:[_\p{XID_Start}][\p{XID_Continue}]+|\p{XID_Start})`
const WGSL_DECIMAL_INTEGER_PATTERN = String.raw`(?:0[iu]?|[1-9][0-9]*[iu]?)`
const WGSL_HEXADECIMAL_INTEGER_PATTERN = String.raw`(?:0[xX][0-9A-Fa-f]+[iu]?)`
const WGSL_DECIMAL_FLOAT_PATTERN = String.raw`(?:0[fh]|[1-9][0-9]*[fh]|[0-9]*\.[0-9]+(?:[eE][+-]?[0-9]+)?[fh]?|[0-9]+\.[0-9]*(?:[eE][+-]?[0-9]+)?[fh]?|[0-9]+[eE][+-]?[0-9]+[fh]?)`
const WGSL_HEXADECIMAL_FLOAT_PATTERN = String.raw`(?:0[xX][0-9A-Fa-f]*\.[0-9A-Fa-f]+(?:[pP][+-]?[0-9]+[fh]?)?|0[xX][0-9A-Fa-f]+\.[0-9A-Fa-f]*(?:[pP][+-]?[0-9]+[fh]?)?|0[xX][0-9A-Fa-f]+[pP][+-]?[0-9]+[fh]?)`
const WGSL_SOURCE_TOKEN_PATTERN = new RegExp([
    WGSL_HEXADECIMAL_FLOAT_PATTERN,
    WGSL_HEXADECIMAL_INTEGER_PATTERN,
    WGSL_DECIMAL_FLOAT_PATTERN,
    WGSL_DECIMAL_INTEGER_PATTERN,
    WGSL_IDENTIFIER_PATTERN,
].join('|'), 'gu')

export type PipelineCompilationModuleFact = Readonly<{
    index: number
    hash: string
    startOffset: number
    endOffset: number
    startLine: number
    endLine: number
    lineCount: number
}>

export type ShaderModuleCompilationNativeLocation = Readonly<{
    offset: number
    length: number
    lineNum: number
    linePos: number
}>

export type PipelineCompilationNativeLocation = ShaderModuleCompilationNativeLocation

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
    sourceExcerptRedacted: boolean
    locationKind: 'unknown' | 'module' | 'separator' | 'unmapped'
    nativeLocation: ShaderModuleCompilationNativeLocation
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

export type ShaderModuleCompilationSourcePartFact = Readonly<{
    index: number
    label?: string
    hash: string
    startOffset: number
    endOffset: number
    startLine: number
    endLine: number
    lineCount: number
    layoutDependencies: readonly Readonly<{
        abiHash: string
        schemaHash: string
    }>[]
}>

export type ShaderModuleCompilationSourcePartLocation = Readonly<{
    sourcePartIndex: number
    offset: number
    length: number
    lineNum: number
    linePos: number
}>

export type ShaderModuleCompilationMessage = Readonly<{
    nativeIndex: number
    type: GPUCompilationMessageType
    message: string
    messageTruncated: boolean
    sourceExcerptRedacted: boolean
    locationKind: 'unknown' | 'source-part' | 'separator' | 'unmapped'
    nativeLocation: ShaderModuleCompilationNativeLocation
    sourcePartLocation?: ShaderModuleCompilationSourcePartLocation
}>

export type ShaderModuleCompilationReport = Readonly<{
    version: 1
    shaderModuleId: string
    sourceHash: string
    sourcePartCount: number
    retainedSourcePartCount: number
    omittedSourcePartCount: number
    sourceParts: readonly ShaderModuleCompilationSourcePartFact[]
    errorCount: number
    warningCount: number
    infoCount: number
    nativeMessageCount: number
    retainedMessageCount: number
    omittedMessageCount: number
    retainedEvidenceBytes: number
    messages: readonly ShaderModuleCompilationMessage[]
}>

export type ShaderModuleSourceSnapshot = Readonly<{
    shaderModuleId: string
    sourceParts: readonly Readonly<{
        label?: string
        code: string
        layoutDependencies: readonly Readonly<{
            abiHash: string
            schemaHash: string
        }>[]
    }>[]
    combinedSource: string
    sourceHash: string
    sourcePartFacts: readonly ShaderModuleCompilationSourcePartFact[]
    separatorOffsets: readonly number[]
    sourcePartLineStarts: readonly (readonly number[])[]
}>

export type PipelineSourceSnapshot = Readonly<{
    programId: string
    modules: readonly string[]
    combinedSource: string
    combinedSourceHash: string
    moduleFacts: readonly PipelineCompilationModuleFact[]
    separatorOffsets: readonly number[]
    moduleLineStarts: readonly (readonly number[])[]
}>

export type PipelineCompilationIdentity = Readonly<{
    pipelineId: string
    pipelineKind: PipelineKind
    programId: string
    combinedSourceHash: string
}>

export type PipelineCompilationReportDescriptor = Readonly<{
    pipelineId: string
    pipelineKind: PipelineKind
    sourceSnapshot: PipelineSourceSnapshot
    compilationInfo: GPUCompilationInfo
}>

export type PipelineSourceRedactionIndex = Readonly<{
    storageBytes: number
    ngramCount: number
    tokenCount: number
    hasNgram(value: string): boolean
    hasToken(value: string): boolean
}>

export function snapshotPipelineSource(program: {
    id: string
    modules: readonly string[]
}): PipelineSourceSnapshot {

    if (typeof program?.id !== 'string') {
        throw new TypeError('Pipeline source snapshot requires a Program ID.')
    }
    if (
        !Array.isArray(program.modules) ||
        program.modules.length === 0 ||
        !program.modules.every(module => typeof module === 'string')
    ) {
        throw new TypeError('Pipeline source snapshot requires a non-empty string module array.')
    }

    const modules = Object.freeze([ ...program.modules ])
    const moduleFacts: PipelineCompilationModuleFact[] = []
    const separatorOffsets: number[] = []
    const moduleLineStarts: (readonly number[])[] = []
    let combinedOffset = 0
    let combinedLine = 1

    for (let index = 0; index < modules.length; index++) {
        const source = modules[index]
        const hasSeparator = index < modules.length - 1
        const lineStarts = Object.freeze(sourceLineStarts(source, hasSeparator))
        const lineCount = lineStarts.length
        moduleLineStarts.push(lineStarts)
        moduleFacts.push(Object.freeze({
            index,
            hash: hashPipelineSource(source),
            startOffset: combinedOffset,
            endOffset: combinedOffset + source.length,
            startLine: combinedLine,
            endLine: combinedLine + lineCount - 1,
            lineCount,
        }))
        combinedOffset += source.length
        combinedLine += lineCount - 1
        if (hasSeparator) {
            separatorOffsets.push(combinedOffset)
            combinedOffset++
            combinedLine++
        }
    }

    const combinedSource = modules.join('\n')
    return Object.freeze({
        programId: program.id,
        modules,
        combinedSource,
        combinedSourceHash: hashPipelineSource(combinedSource),
        moduleFacts: Object.freeze(moduleFacts),
        separatorOffsets: Object.freeze(separatorOffsets),
        moduleLineStarts: Object.freeze(moduleLineStarts),
    })
}

export function snapshotShaderModuleSource(input: {
    id: string
    sourceParts: readonly Readonly<{
        label?: string
        code: string
        layoutDependencies?: readonly Readonly<{
            abiHash: string
            schemaHash: string
        }>[]
    }>[]
}): ShaderModuleSourceSnapshot {

    if (typeof input?.id !== 'string') {
        throw new TypeError('ShaderModule source snapshot requires a ShaderModule ID.')
    }
    if (
        !Array.isArray(input.sourceParts) ||
        input.sourceParts.length === 0 ||
        !input.sourceParts.every(part =>
            isRecord(part) &&
            typeof part.code === 'string' &&
            (part.label === undefined || typeof part.label === 'string') &&
            (
                part.layoutDependencies === undefined ||
                Array.isArray(part.layoutDependencies)
            )
        )
    ) {
        throw new TypeError('ShaderModule source snapshot requires non-empty source parts.')
    }

    const sourceParts = Object.freeze(input.sourceParts.map(part => Object.freeze({
        ...(part.label !== undefined ? { label: part.label } : {}),
        code: part.code,
        layoutDependencies: Object.freeze(
            (part.layoutDependencies ?? []).map((dependency: Readonly<{
                abiHash: string
                schemaHash: string
            }>) => Object.freeze({
                abiHash: dependency.abiHash,
                schemaHash: dependency.schemaHash,
            }))
        ),
    })))
    const sourcePartFacts: ShaderModuleCompilationSourcePartFact[] = []
    const separatorOffsets: number[] = []
    const sourcePartLineStarts: (readonly number[])[] = []
    let combinedOffset = 0
    let combinedLine = 1

    for (let index = 0; index < sourceParts.length; index++) {
        const part = sourceParts[index]
        const hasSeparator = index < sourceParts.length - 1
        const lineStarts = Object.freeze(sourceLineStarts(part.code, hasSeparator))
        const lineCount = lineStarts.length
        sourcePartLineStarts.push(lineStarts)
        sourcePartFacts.push(Object.freeze({
            index,
            ...(part.label !== undefined ? { label: part.label } : {}),
            hash: hashPipelineSource(part.code),
            startOffset: combinedOffset,
            endOffset: combinedOffset + part.code.length,
            startLine: combinedLine,
            endLine: combinedLine + lineCount - 1,
            lineCount,
            layoutDependencies: part.layoutDependencies,
        }))
        combinedOffset += part.code.length
        combinedLine += lineCount - 1
        if (hasSeparator) {
            separatorOffsets.push(combinedOffset)
            combinedOffset++
            combinedLine++
        }
    }

    const combinedSource = sourceParts.map(part => part.code).join('\n')
    return Object.freeze({
        shaderModuleId: input.id,
        sourceParts,
        combinedSource,
        sourceHash: hashPipelineSource(combinedSource),
        sourcePartFacts: Object.freeze(sourcePartFacts),
        separatorOffsets: Object.freeze(separatorOffsets),
        sourcePartLineStarts: Object.freeze(sourcePartLineStarts),
    })
}

export function hashPipelineSource(source: string): string {

    if (typeof source !== 'string') throw new TypeError('Pipeline source hash requires a string.')
    let hash = 0x811c9dc5
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function createPipelineCreationReport(input: {
    pipelineId: string
    pipelineKind: PipelineKind
    programId: string
    stages: readonly Readonly<{
        stage: 'vertex' | 'fragment' | 'compute'
        shaderModuleId: string
        sourceHash: string
        entryPoint?: string
        constantKeys?: readonly string[]
    }>[]
}): PipelineCreationReport {

    if (
        typeof input?.pipelineId !== 'string' ||
        (input.pipelineKind !== 'render' && input.pipelineKind !== 'compute') ||
        typeof input.programId !== 'string' ||
        !Array.isArray(input.stages) ||
        input.stages.length === 0
    ) {
        throw new TypeError('Pipeline creation report identity is invalid.')
    }
    const stages = Object.freeze(input.stages.map(stage => Object.freeze({
        stage: stage.stage,
        shaderModuleId: stage.shaderModuleId,
        sourceHash: stage.sourceHash,
        ...(stage.entryPoint !== undefined ? { entryPoint: stage.entryPoint } : {}),
        constantKeys: Object.freeze([ ...(stage.constantKeys ?? []) ].sort()),
    })))
    return Object.freeze({
        version: 1,
        pipelineId: input.pipelineId,
        pipelineKind: input.pipelineKind,
        programId: input.programId,
        contractHash: hashPipelineSource(JSON.stringify(stages)),
        stages,
    })
}

export function normalizePipelineCreationReport(
    input: PipelineCreationReport,
    identity: Readonly<{
        pipelineId: string
        pipelineKind: PipelineKind
        programId: string
        contractHash: string
    }>
): PipelineCreationReport {

    if (
        input.pipelineId !== identity.pipelineId ||
        input.pipelineKind !== identity.pipelineKind ||
        input.programId !== identity.programId ||
        input.contractHash !== identity.contractHash
    ) {
        throw new TypeError('Pipeline creation report identity does not match its target.')
    }
    const normalized = createPipelineCreationReport({
        pipelineId: input.pipelineId,
        pipelineKind: input.pipelineKind,
        programId: input.programId,
        stages: input.stages,
    })
    if (normalized.contractHash !== input.contractHash) {
        throw new TypeError('Pipeline creation report contract hash is invalid.')
    }
    return normalized
}

export function createPipelineCompilationReport(
    descriptor: PipelineCompilationReportDescriptor
): PipelineCompilationReport {

    if (typeof descriptor?.pipelineId !== 'string') {
        throw new TypeError('Pipeline compilation report requires a pipeline ID.')
    }
    if (descriptor.pipelineKind !== 'render' && descriptor.pipelineKind !== 'compute') {
        throw new TypeError('Pipeline compilation report requires a render or compute kind.')
    }
    const snapshot = descriptor.sourceSnapshot
    if (
        snapshot === null ||
        typeof snapshot !== 'object' ||
        typeof snapshot.programId !== 'string' ||
        typeof snapshot.combinedSource !== 'string' ||
        typeof snapshot.combinedSourceHash !== 'string' ||
        !Array.isArray(snapshot.moduleFacts) ||
        !Array.isArray(snapshot.modules) ||
        !Array.isArray(snapshot.separatorOffsets) ||
        !Array.isArray(snapshot.moduleLineStarts)
    ) {
        throw new TypeError('Pipeline compilation report requires a valid source snapshot.')
    }
    const nativeMessages = compilationMessages(descriptor.compilationInfo)
    const retainedMessages: PipelineCompilationMessage[] = []
    let sourceRedactionIndex: PipelineSourceRedactionIndex | undefined
    let errorCount = 0
    let warningCount = 0
    let infoCount = 0

    for (let nativeIndex = 0; nativeIndex < nativeMessages.length; nativeIndex++) {
        const native = nativeCompilationMessage(nativeMessages[nativeIndex])
        if (native.type === 'error') errorCount++
        else if (native.type === 'warning') warningCount++
        else infoCount++
        if (retainedMessages.length < PIPELINE_COMPILATION_MAX_MESSAGES) {
            sourceRedactionIndex ??= createPipelineSourceRedactionIndex(snapshot.combinedSource)
            retainedMessages.push(mapCompilationMessage(
                snapshot,
                native,
                nativeIndex,
                sourceRedactionIndex
            ))
        }
    }

    const identity = {
        pipelineId: descriptor.pipelineId,
        pipelineKind: descriptor.pipelineKind,
        programId: snapshot.programId,
        combinedSourceHash: snapshot.combinedSourceHash,
    } as const
    return normalizePipelineCompilationReport({
        version: 1,
        ...identity,
        moduleCount: snapshot.moduleFacts.length,
        retainedModuleCount: snapshot.moduleFacts.length,
        omittedModuleCount: 0,
        modules: snapshot.moduleFacts,
        errorCount,
        warningCount,
        infoCount,
        nativeMessageCount: nativeMessages.length,
        retainedMessageCount: retainedMessages.length,
        omittedMessageCount: nativeMessages.length - retainedMessages.length,
        retainedEvidenceBytes: 0,
        messages: retainedMessages,
    }, identity)
}

export function createShaderModuleCompilationReport(input: {
    shaderModuleId: string
    sourceSnapshot: ShaderModuleSourceSnapshot
    compilationInfo: GPUCompilationInfo
}): ShaderModuleCompilationReport {

    if (
        typeof input?.shaderModuleId !== 'string' ||
        input.sourceSnapshot?.shaderModuleId !== input.shaderModuleId
    ) {
        throw new TypeError('ShaderModule compilation identity is invalid.')
    }

    const pipelineSnapshot: PipelineSourceSnapshot = Object.freeze({
        programId: input.shaderModuleId,
        modules: Object.freeze(input.sourceSnapshot.sourceParts.map(part => part.code)),
        combinedSource: input.sourceSnapshot.combinedSource,
        combinedSourceHash: input.sourceSnapshot.sourceHash,
        moduleFacts: Object.freeze(input.sourceSnapshot.sourcePartFacts.map(part => Object.freeze({
            index: part.index,
            hash: part.hash,
            startOffset: part.startOffset,
            endOffset: part.endOffset,
            startLine: part.startLine,
            endLine: part.endLine,
            lineCount: part.lineCount,
        }))),
        separatorOffsets: input.sourceSnapshot.separatorOffsets,
        moduleLineStarts: input.sourceSnapshot.sourcePartLineStarts,
    })
    const report = createPipelineCompilationReport({
        pipelineId: input.shaderModuleId,
        pipelineKind: 'compute',
        sourceSnapshot: pipelineSnapshot,
        compilationInfo: input.compilationInfo,
    })
    const messages = Object.freeze(report.messages.map(message => Object.freeze({
        nativeIndex: message.nativeIndex,
        type: message.type,
        message: message.message,
        messageTruncated: message.messageTruncated,
        sourceExcerptRedacted: message.sourceExcerptRedacted,
        locationKind: message.locationKind === 'module'
            ? 'source-part' as const
            : message.locationKind,
        nativeLocation: message.nativeLocation,
        ...(message.moduleLocation !== undefined ? {
            sourcePartLocation: Object.freeze({
                sourcePartIndex: message.moduleLocation.moduleIndex,
                offset: message.moduleLocation.offset,
                length: message.moduleLocation.length,
                lineNum: message.moduleLocation.lineNum,
                linePos: message.moduleLocation.linePos,
            }),
        } : {}),
    })))

    return Object.freeze({
        version: 1,
        shaderModuleId: input.shaderModuleId,
        sourceHash: input.sourceSnapshot.sourceHash,
        sourcePartCount: input.sourceSnapshot.sourcePartFacts.length,
        retainedSourcePartCount: input.sourceSnapshot.sourcePartFacts.length,
        omittedSourcePartCount: 0,
        sourceParts: input.sourceSnapshot.sourcePartFacts,
        errorCount: report.errorCount,
        warningCount: report.warningCount,
        infoCount: report.infoCount,
        nativeMessageCount: report.nativeMessageCount,
        retainedMessageCount: messages.length,
        omittedMessageCount: report.nativeMessageCount - messages.length,
        retainedEvidenceBytes: report.retainedEvidenceBytes,
        messages,
    })
}

export function normalizePipelineCompilationReport(
    input: PipelineCompilationReport,
    identity: PipelineCompilationIdentity
): PipelineCompilationReport {

    if (
        input.pipelineId !== identity.pipelineId ||
        input.pipelineKind !== identity.pipelineKind ||
        input.programId !== identity.programId ||
        input.combinedSourceHash !== identity.combinedSourceHash
    ) {
        throw new TypeError('Pipeline compilation report identity does not match its operation target.')
    }

    const sourceModules = Array.isArray(input.modules) ? input.modules : []
    const sourceMessages = Array.isArray(input.messages) ? input.messages : []
    const moduleCount = Math.max(nonNegativeInteger(input.moduleCount), sourceModules.length)
    const nativeMessageCount = Math.max(
        nonNegativeInteger(input.nativeMessageCount),
        sourceMessages.length
    )
    const modules = selectCompilationModuleFacts(sourceModules)
    const messages = sourceMessages
        .slice(0, PIPELINE_COMPILATION_MAX_MESSAGES)
        .map(normalizeCompilationMessageEvidence)
    const report: Record<string, unknown> = {
        version: 1,
        ...identity,
        moduleCount,
        retainedModuleCount: modules.length,
        omittedModuleCount: Math.max(0, moduleCount - modules.length),
        modules,
        errorCount: nonNegativeInteger(input.errorCount),
        warningCount: nonNegativeInteger(input.warningCount),
        infoCount: nonNegativeInteger(input.infoCount),
        nativeMessageCount,
        retainedMessageCount: messages.length,
        omittedMessageCount: Math.max(0, nativeMessageCount - messages.length),
        retainedEvidenceBytes: 0,
        messages,
    }

    fitCompilationReportToBudget(report, modules, messages, moduleCount, nativeMessageCount)
    return deepFreeze(report) as PipelineCompilationReport
}

type NativeCompilationMessageFacts = Readonly<{
    type: GPUCompilationMessageType
    message: string
    offset: number
    length: number
    lineNum: number
    linePos: number
}>

function compilationMessages(info: unknown): readonly unknown[] {

    if (!isRecord(info) || !Array.isArray(info.messages)) {
        throw new TypeError('GPU compilation information requires a messages array.')
    }
    return info.messages
}

function nativeCompilationMessage(value: unknown): NativeCompilationMessageFacts {

    if (!isRecord(value)) throw new TypeError('GPU compilation messages must be objects.')
    if (value.type !== 'error' && value.type !== 'warning' && value.type !== 'info') {
        throw new TypeError('GPU compilation message type is invalid.')
    }
    if (typeof value.message !== 'string') {
        throw new TypeError('GPU compilation message text must be a string.')
    }
    return {
        type: value.type,
        message: value.message,
        offset: compilationLocationInteger(value.offset, 'offset'),
        length: compilationLocationInteger(value.length, 'length'),
        lineNum: compilationLocationInteger(value.lineNum, 'lineNum'),
        linePos: compilationLocationInteger(value.linePos, 'linePos'),
    }
}

function compilationLocationInteger(value: unknown, name: string): number {

    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
    throw new TypeError(`GPU compilation message ${name} must be a non-negative safe integer.`)
}

function mapCompilationMessage(
    snapshot: PipelineSourceSnapshot,
    native: NativeCompilationMessageFacts,
    nativeIndex: number,
    sourceRedactionIndex: PipelineSourceRedactionIndex
): PipelineCompilationMessage {

    const sanitizedMessage = sanitizePipelineEvidenceText(
        native.message,
        sourceRedactionIndex
    )
    const nativeLocation = {
        offset: native.offset,
        length: native.length,
        lineNum: native.lineNum,
        linePos: native.linePos,
    }
    if (
        native.offset === 0 &&
        native.length === 0 &&
        native.lineNum === 0 &&
        native.linePos === 0
    ) {
        return {
            nativeIndex,
            type: native.type,
            message: sanitizedMessage.message,
            messageTruncated: sanitizedMessage.truncated,
            sourceExcerptRedacted: sanitizedMessage.sourceExcerptRedacted,
            locationKind: 'unknown',
            nativeLocation,
        }
    }

    const module = moduleAtOffset(snapshot.moduleFacts, native.offset)
    if (module !== undefined) {
        const relativeOffset = native.offset - module.startOffset
        const lineStarts = snapshot.moduleLineStarts[module.index]
        const lineIndex = lineIndexAtOffset(lineStarts, relativeOffset)
        return {
            nativeIndex,
            type: native.type,
            message: sanitizedMessage.message,
            messageTruncated: sanitizedMessage.truncated,
            sourceExcerptRedacted: sanitizedMessage.sourceExcerptRedacted,
            locationKind: 'module',
            nativeLocation,
            moduleLocation: {
                moduleIndex: module.index,
                offset: relativeOffset,
                length: native.length,
                lineNum: lineIndex + 1,
                linePos: relativeOffset - lineStarts[lineIndex] + 1,
            },
        }
    }

    return {
        nativeIndex,
        type: native.type,
        message: sanitizedMessage.message,
        messageTruncated: sanitizedMessage.truncated,
        sourceExcerptRedacted: sanitizedMessage.sourceExcerptRedacted,
        locationKind: hasSortedNumber(snapshot.separatorOffsets, native.offset)
            ? 'separator'
            : 'unmapped',
        nativeLocation,
    }
}

function moduleAtOffset(
    modules: readonly PipelineCompilationModuleFact[],
    offset: number
): PipelineCompilationModuleFact | undefined {

    let low = 0
    let high = modules.length
    while (low < high) {
        const middle = (low + high) >>> 1
        if (modules[middle].startOffset <= offset) low = middle + 1
        else high = middle
    }
    const candidate = modules[low - 1]
    return candidate !== undefined && offset < candidate.endOffset ? candidate : undefined
}

function lineIndexAtOffset(lineStarts: readonly number[], offset: number): number {

    let low = 0
    let high = lineStarts.length
    while (low < high) {
        const middle = (low + high) >>> 1
        if (lineStarts[middle] <= offset) low = middle + 1
        else high = middle
    }
    return Math.max(0, low - 1)
}

function hasSortedNumber(values: readonly number[], target: number): boolean {

    let low = 0
    let high = values.length
    while (low < high) {
        const middle = (low + high) >>> 1
        if (values[middle] < target) low = middle + 1
        else high = middle
    }
    return values[low] === target
}

function selectCompilationModuleFacts(
    sourceModules: readonly PipelineCompilationModuleFact[]
): PipelineCompilationModuleFact[] {

    const modules: PipelineCompilationModuleFact[] = []
    for (const module of sourceModules) {
        const fact = {
            index: nonNegativeInteger(module?.index),
            hash: boundString(String(module?.hash), 128),
            startOffset: nonNegativeInteger(module?.startOffset),
            endOffset: nonNegativeInteger(module?.endOffset),
            startLine: positiveInteger(module?.startLine),
            endLine: positiveInteger(module?.endLine),
            lineCount: positiveInteger(module?.lineCount),
        }
        let low = 0
        let high = modules.length
        while (low < high) {
            const middle = (low + high) >>> 1
            if (modules[middle].index <= fact.index) low = middle + 1
            else high = middle
        }
        modules.splice(low, 0, fact)
        if (modules.length > PIPELINE_COMPILATION_MAX_MODULE_FACTS) modules.pop()
    }
    return modules
}

function normalizeCompilationMessageEvidence(
    input: PipelineCompilationMessage
): PipelineCompilationMessage {

    const originalMessage = typeof input?.message === 'string'
        ? input.message
        : String(input?.message)
    const message = boundString(originalMessage, PIPELINE_COMPILATION_MAX_MESSAGE_LENGTH)
    const requestedLocationKind = input?.locationKind
    const hasModuleLocation = requestedLocationKind === 'module' && input.moduleLocation !== undefined
    const locationKind = requestedLocationKind === 'unknown' ||
        requestedLocationKind === 'separator' ||
        requestedLocationKind === 'unmapped'
        ? requestedLocationKind
        : hasModuleLocation
            ? 'module'
            : 'unmapped'
    return {
        nativeIndex: nonNegativeInteger(input?.nativeIndex),
        type: input?.type === 'error' || input?.type === 'warning' ? input.type : 'info',
        message,
        messageTruncated: input?.messageTruncated === true || message !== originalMessage,
        sourceExcerptRedacted: input?.sourceExcerptRedacted === true,
        locationKind,
        nativeLocation: normalizeNativeLocation(input?.nativeLocation),
        ...(locationKind === 'module' && input.moduleLocation !== undefined
            ? { moduleLocation: normalizeModuleLocation(input.moduleLocation) }
            : {}),
    }
}

export function sanitizePipelineEvidenceText(
    message: string,
    sourceIndex: PipelineSourceRedactionIndex,
    maxLength = PIPELINE_COMPILATION_MAX_MESSAGE_LENGTH
): Readonly<{
    message: string
    truncated: boolean
    sourceExcerptRedacted: boolean
}> {

    const boundedMessage = boundString(message, maxLength)
    const sourceSafeMessage = redactPipelineSourceExcerpts(boundedMessage, sourceIndex)
    const boundedSourceSafeMessage = boundString(
        sourceSafeMessage.message,
        maxLength
    )
    return {
        message: boundedSourceSafeMessage,
        truncated: boundedMessage !== message || boundedSourceSafeMessage !== sourceSafeMessage.message,
        sourceExcerptRedacted: sourceSafeMessage.redacted,
    }
}

function redactPipelineSourceExcerpts(
    message: string,
    sourceIndex: PipelineSourceRedactionIndex
): Readonly<{ message: string, redacted: boolean }> {

    if (message.length === 0 || (sourceIndex.ngramCount === 0 && sourceIndex.tokenCount === 0)) {
        return { message, redacted: false }
    }

    const covered = new Uint8Array(message.length)
    markSourceNgrams(message, sourceIndex, covered)
    markSourceTokens(message, sourceIndex, covered)
    preserveSurrogatePairs(message, covered)

    if (!covered.some(Boolean)) return { message, redacted: false }

    let redacted = ''
    for (let index = 0; index < message.length;) {
        if (covered[index] === 0) {
            redacted += message[index]
            index++
            continue
        }
        while (index < message.length && covered[index] !== 0) index++
        redacted += PIPELINE_COMPILATION_SOURCE_REDACTION
    }
    return { message: redacted, redacted: true }
}

export function createPipelineSourceRedactionIndex(source: string): PipelineSourceRedactionIndex {

    const length = PIPELINE_COMPILATION_SOURCE_EXCERPT_LENGTH
    const filter = new Uint8Array(sourceRedactionWorkspaceBytes(source.length))
    const ngramCount = Math.max(0, source.length - length + 1)
    if (source.length >= length) {
        for (let index = 0; index <= source.length - length; index++) {
            addBloomRange(filter, source, index, length, PIPELINE_SOURCE_NGRAM_DOMAIN)
        }
    }
    let tokenCount = 0
    for (const match of source.matchAll(WGSL_SOURCE_TOKEN_PATTERN)) {
        if (match[0].length < 3) continue
        tokenCount++
        addBloomRange(
            filter,
            match[0],
            0,
            match[0].length,
            PIPELINE_SOURCE_TOKEN_DOMAIN
        )
    }
    return Object.freeze({
        storageBytes: filter.byteLength,
        ngramCount,
        tokenCount,
        hasNgram: (value: string) => hasBloomValue(
            filter,
            value,
            PIPELINE_SOURCE_NGRAM_DOMAIN
        ),
        hasToken: (value: string) => hasBloomValue(
            filter,
            value,
            PIPELINE_SOURCE_TOKEN_DOMAIN
        ),
    })
}

function markSourceNgrams(
    message: string,
    sourceIndex: PipelineSourceRedactionIndex,
    covered: Uint8Array
): void {

    const length = PIPELINE_COMPILATION_SOURCE_EXCERPT_LENGTH
    if (message.length < length || sourceIndex.ngramCount === 0) return

    for (let index = 0; index <= message.length - length; index++) {
        if (!sourceIndex.hasNgram(message.slice(index, index + length))) continue
        covered.fill(1, index, index + length)
    }
}

function markSourceTokens(
    message: string,
    sourceIndex: PipelineSourceRedactionIndex,
    covered: Uint8Array
): void {

    if (sourceIndex.tokenCount === 0) return
    for (const match of message.matchAll(WGSL_SOURCE_TOKEN_PATTERN)) {
        const token = match[0]
        if (token.length < 3 || !sourceIndex.hasToken(token)) continue
        covered.fill(1, match.index, match.index + token.length)
    }
}

function sourceRedactionWorkspaceBytes(sourceLength: number): number {

    const target = Math.min(
        PIPELINE_SOURCE_REDACTION_MAX_WORKSPACE_BYTES,
        Math.max(PIPELINE_SOURCE_REDACTION_MIN_WORKSPACE_BYTES, sourceLength * 2)
    )
    let bytes = PIPELINE_SOURCE_REDACTION_MIN_WORKSPACE_BYTES
    while (bytes < target) bytes *= 2
    return bytes
}

function addBloomRange(
    filter: Uint8Array,
    value: string,
    start: number,
    length: number,
    domain: number
): void {

    const [ first, second ] = bloomHashes(value, start, length, domain)
    const bitMask = filter.byteLength * 8 - 1
    for (let index = 0; index < PIPELINE_SOURCE_REDACTION_HASH_COUNT; index++) {
        const bit = (first + Math.imul(index, second)) & bitMask
        filter[bit >>> 3] |= 1 << (bit & 7)
    }
}

function hasBloomValue(filter: Uint8Array, value: string, domain: number): boolean {

    const [ first, second ] = bloomHashes(value, 0, value.length, domain)
    const bitMask = filter.byteLength * 8 - 1
    for (let index = 0; index < PIPELINE_SOURCE_REDACTION_HASH_COUNT; index++) {
        const bit = (first + Math.imul(index, second)) & bitMask
        if ((filter[bit >>> 3] & (1 << (bit & 7))) === 0) return false
    }
    return true
}

function bloomHashes(
    value: string,
    start: number,
    length: number,
    domain: number
): readonly [ number, number ] {

    let first = (0x811c9dc5 ^ domain) >>> 0
    let second = (0x9e3779b9 ^ domain) >>> 0
    const end = start + length
    for (let index = start; index < end; index++) {
        const codeUnit = value.charCodeAt(index)
        first = Math.imul(first ^ codeUnit, 0x01000193) >>> 0
        second = Math.imul(second ^ codeUnit, 0x85ebca6b) >>> 0
    }
    return [ first, second | 1 ]
}

function preserveSurrogatePairs(value: string, covered: Uint8Array): void {

    for (let index = 0; index < value.length - 1; index++) {
        if (
            isHighSurrogate(value.charCodeAt(index)) &&
            isLowSurrogate(value.charCodeAt(index + 1)) &&
            covered[index] !== covered[index + 1]
        ) {
            covered[index] = 1
            covered[index + 1] = 1
        }
    }
}

function normalizeNativeLocation(
    location: PipelineCompilationNativeLocation | undefined
): PipelineCompilationNativeLocation {

    return {
        offset: nonNegativeInteger(location?.offset),
        length: nonNegativeInteger(location?.length),
        lineNum: nonNegativeInteger(location?.lineNum),
        linePos: nonNegativeInteger(location?.linePos),
    }
}

function normalizeModuleLocation(
    location: PipelineCompilationModuleLocation
): PipelineCompilationModuleLocation {

    return {
        moduleIndex: nonNegativeInteger(location.moduleIndex),
        offset: nonNegativeInteger(location.offset),
        length: nonNegativeInteger(location.length),
        lineNum: positiveInteger(location.lineNum),
        linePos: positiveInteger(location.linePos),
    }
}

function fitCompilationReportToBudget(
    report: Record<string, unknown>,
    modules: PipelineCompilationModuleFact[],
    messages: PipelineCompilationMessage[],
    moduleCount: number,
    nativeMessageCount: number
): void {

    const refresh = () => {
        report.retainedModuleCount = modules.length
        report.omittedModuleCount = Math.max(0, moduleCount - modules.length)
        report.retainedMessageCount = messages.length
        report.omittedMessageCount = Math.max(0, nativeMessageCount - messages.length)
        return settleRetainedEvidenceBytes(report)
    }

    while (refresh() > PIPELINE_COMPILATION_MAX_EVIDENCE_BYTES && messages.length > 0) {
        messages.pop()
    }
    while (refresh() > PIPELINE_COMPILATION_MAX_EVIDENCE_BYTES && modules.length > 0) {
        modules.pop()
    }
    if (refresh() > PIPELINE_COMPILATION_MAX_EVIDENCE_BYTES) {
        throw new TypeError('Pipeline compilation report fixed evidence exceeds its byte budget.')
    }
}

function settleRetainedEvidenceBytes(report: Record<string, unknown>): number {

    // The counter changes the serialized size through its own decimal digits.
    for (;;) {
        const bytes = serializedJsonBytes(report)
        if (report.retainedEvidenceBytes === bytes) return bytes
        report.retainedEvidenceBytes = bytes
    }
}

function serializedJsonBytes(value: unknown): number {

    const serialized = JSON.stringify(value)
    return serialized === undefined ? 0 : new TextEncoder().encode(serialized).byteLength
}

function nonNegativeInteger(value: unknown): number {

    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function positiveInteger(value: unknown): number {

    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : 1
}

function boundString(value: string, maxLength: number): string {

    if (value.length <= maxLength) return value
    let end = Math.max(0, maxLength - 3)
    if (
        end > 0 &&
        end < value.length &&
        isHighSurrogate(value.charCodeAt(end - 1)) &&
        isLowSurrogate(value.charCodeAt(end))
    ) end--
    return `${value.slice(0, end)}...`
}

function isHighSurrogate(value: number): boolean {

    return value >= 0xD800 && value <= 0xDBFF
}

function isLowSurrogate(value: number): boolean {

    return value >= 0xDC00 && value <= 0xDFFF
}

function isRecord(value: unknown): value is Record<string, unknown> {

    return value !== null && typeof value === 'object'
}

function deepFreeze<T>(value: T): T {

    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
    if (Object.isFrozen(value)) return value
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
    return Object.freeze(value)
}

function sourceLineStarts(source: string, trailingCrPairsWithSeparator = false): number[] {

    const starts = [ 0 ]
    for (let index = 0; index < source.length; index++) {
        if (source.charCodeAt(index) === 13) {
            // A complete local CRLF counts here; an inserted LF completes a trailing lone CR.
            const pairedWithLf = source.charCodeAt(index + 1) === 10
            if (pairedWithLf) {
                index++
                starts.push(index + 1)
            } else if (!(trailingCrPairsWithSeparator && index === source.length - 1)) {
                starts.push(index + 1)
            }
        } else if (source.charCodeAt(index) === 10) {
            starts.push(index + 1)
        }
    }
    return starts
}
