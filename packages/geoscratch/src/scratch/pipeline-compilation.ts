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

export function hashPipelineSource(source: string): string {

    if (typeof source !== 'string') throw new TypeError('Pipeline source hash requires a string.')
    let hash = 0x811c9dc5
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
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
    let errorCount = 0
    let warningCount = 0
    let infoCount = 0

    for (let nativeIndex = 0; nativeIndex < nativeMessages.length; nativeIndex++) {
        const native = nativeCompilationMessage(nativeMessages[nativeIndex])
        if (native.type === 'error') errorCount++
        else if (native.type === 'warning') warningCount++
        else infoCount++
        if (retainedMessages.length < PIPELINE_COMPILATION_MAX_MESSAGES) {
            retainedMessages.push(mapCompilationMessage(snapshot, native, nativeIndex))
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
    nativeIndex: number
): PipelineCompilationMessage {

    const message = boundString(native.message, PIPELINE_COMPILATION_MAX_MESSAGE_LENGTH)
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
            message,
            messageTruncated: message !== native.message,
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
            message,
            messageTruncated: message !== native.message,
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
        message,
        messageTruncated: message !== native.message,
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
        locationKind,
        nativeLocation: normalizeNativeLocation(input?.nativeLocation),
        ...(locationKind === 'module' && input.moduleLocation !== undefined
            ? { moduleLocation: normalizeModuleLocation(input.moduleLocation) }
            : {}),
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
