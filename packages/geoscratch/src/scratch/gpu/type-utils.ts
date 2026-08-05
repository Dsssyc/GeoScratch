import type { DiagnosticSubject } from './diagnostics.js'

export type UnknownRecord = Record<string, unknown>

export function isRecord(value: unknown): value is UnknownRecord {

    return value !== null && typeof value === 'object'
}

export function isDefined<T>(value: T | null | undefined): value is T {

    return value !== null && value !== undefined
}

export function describeValue(value: unknown): string {

    return value === null ? 'null' : typeof value
}

export function diagnosticSubjectOf(value: unknown): DiagnosticSubject | undefined {

    if (!isRecord(value)) return undefined

    const subject = value.subject
    if (!isRecord(subject) || typeof subject.kind !== 'string') return undefined

    return subject as DiagnosticSubject
}

export function getGlobalConstant(groupName: string, constantName: string, fallback: number): number {

    const globalRecord = globalThis as typeof globalThis & Record<string, unknown>
    const group = globalRecord[groupName]
    if (!isRecord(group)) return fallback

    const value = group[constantName]
    return typeof value === 'number' ? value : fallback
}
