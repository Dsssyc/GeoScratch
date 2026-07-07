# Repro、Tests 与 Security

状态: Vision draft  
日期: 2026-07-06

## 决策

Web 地理可视化的 bug 往往来自异步瓦片、LoD 边界、缓存淘汰、GPU device limits、shader/layout mismatch、label placement 和网络数据状态。AI 调试这些问题需要稳定复现包、语义断言和安全边界。`geo` 应把 repro/test/security 作为一等能力。

## Repro capsule

```ts
const repro = await geo.createReproCase({
    include: [
        'document',
        'viewport',
        'device-limits',
        'runtime-snapshot',
        'tile-manifest',
        'sample-tiles',
        'render-graph',
        'resource-graph',
        'layout-products',
        'diagnostics',
        'profile',
        'expected-image'
    ],
    cropToViewport: true,
    maxSizeMB: 32,
    redactSensitiveFields: true
})
```

输出 artifact 例如:

```text
case.geoscratch-repro.zip
```

建议内容:

```text
manifest.json
document.geoviz.json
viewport.json
device.json
runtime-snapshot.json
render-graph.json
resource-graph.json
tile-manifest.json
tiles/
layout-products/
diagnostics.json
profile.json
expected.png
assertions.json
README.md
```

## Repro manifest

```ts
type ReproManifest = {
    version: 1
    createdAt: string
    createdWith: string
    documentRevision: string
    browser?: BrowserInfo
    adapter?: GpuAdapterInfo
    deviceLimits?: Record<string, number>
    deviceFeatures?: string[]
    randomSeeds?: Record<string, number>
    included: string[]
    redactions: RedactionSummary[]
    entrypoint: string
}
```

## Semantic assertions

框架应提供地图语义断言，而不是只依赖 screenshot。

```ts
await expectGeo(document)
    .atView({ center: [139.7, 35.6], zoom: 14 })
    .toHaveNoGeoDiagnostics()
    .toHaveNoScratchDiagnostics()
    .toHaveVisibleLayer('buildings')
    .toRenderFeature('building_123')
    .toPlaceAtLeastLabels('station-labels', 50)
    .toStayUnderGpuMemory(512)
    .toUseNoFallbackTiles()
    .toMatchImageSnapshot('tokyo-z14')
```

断言输出必须结构化:

```ts
type GeoAssertionResult = {
    pass: boolean
    assertion: string
    subject?: GeoDiagnosticSubject
    expected?: unknown
    actual?: unknown
    diagnostics?: GeoDiagnostic[]
    artifacts?: ArtifactRef[]
}
```

## Assertion catalog

建议内置:

```text
Document assertions:
    valid schema
    no deprecated fields
    no unresolved source/layer refs

Source/tile assertions:
    required fields present
    tile request count under budget
    no failed tiles
    fallback tiles below threshold

Style assertions:
    no missing field
    no unit mismatch
    no nullable field without default
    no unexpected pipeline variant explosion

Layout assertions:
    labels accepted count
    rejected safety-critical labels == 0
    collision domain occupancy below threshold
    placement stable across small pan

Render assertions:
    visible layer exists
    feature visible / not visible reason
    pixel contributor matches expected layer
    image snapshot within tolerance

Performance assertions:
    frame cost under threshold
    GPU memory under threshold
    upload bytes under threshold
    label candidates under threshold

Security assertions:
    no literal credential
    no external URL outside allowlist
    no sensitive field exported
```

## Security policy

```ts
type SecurityPolicySpec = {
    network?: NetworkPolicy
    credentials?: CredentialPolicy
    export?: ExportPolicy
    logging?: LoggingPolicy
    agent?: AgentSecurityPolicy
}

type NetworkPolicy = {
    allowedDomains?: string[]
    blockedDomains?: string[]
    requireHttps?: boolean
    allowLocalhost?: boolean
}

type CredentialPolicy = {
    allowLiteralTokens?: boolean
    credentialRefs?: string[]
    redactInDiagnostics?: boolean
}

type ExportPolicy = {
    allowDocumentExport?: boolean
    allowTileExport?: boolean
    allowReproExport?: boolean
    sensitiveFields?: string[]
}
```

## Source security

```ts
type SourceSecurityPolicy = {
    credentialRef?: string
    allowedDomains?: string[]
    allowExport?: boolean
    allowCachePersistence?: boolean
    redactFields?: string[]
    sensitiveFields?: string[]
    license?: string
}
```

## Security diff

`planPatch` 应返回 security diff:

```ts
type SecurityDiff = {
    requiresConfirmation: boolean
    changes: SecurityChange[]
}

type SecurityChange =
    | { kind: 'external-url-added', url: string, domain: string, allowed: boolean }
    | { kind: 'credential-added', credentialRef?: string, literalDetected?: boolean }
    | { kind: 'sensitive-field-export-risk', field: string, sourceId: string }
    | { kind: 'cache-policy-changed', sourceId: string, from: string, to: string }
```

## Redaction

Repro、explain、trace、profile 和 diagnostics 都必须支持 redaction。

```ts
type RedactionSummary = {
    subject: string
    fieldsRedacted: string[]
    reason: 'sensitive-field' | 'credential' | 'network-policy' | 'user-policy'
}
```

## Diagnostics

```ts
type GeoSecurityDiagnosticCode =
    | 'GEO_SECURITY_LITERAL_CREDENTIAL_DETECTED'
    | 'GEO_SECURITY_DOMAIN_NOT_ALLOWED'
    | 'GEO_SECURITY_SENSITIVE_FIELD_EXPORT_BLOCKED'
    | 'GEO_SECURITY_REPRO_REDACTION_APPLIED'
    | 'GEO_SECURITY_AGENT_PERMISSION_REQUIRED'
```

```ts
type GeoReproDiagnosticCode =
    | 'GEO_REPRO_SIZE_BUDGET_EXCEEDED'
    | 'GEO_REPRO_TILE_SAMPLE_MISSING'
    | 'GEO_REPRO_DEVICE_INFO_UNAVAILABLE'
    | 'GEO_REPRO_EXPECTED_IMAGE_MISSING'
    | 'GEO_REPRO_REDACTION_INCOMPLETE'
```

## 非目标

- 不把 screenshot regression 当成唯一测试方式。
- 不把私有 source data 默认写进 repro。
- 不允许 agent 通过 explain/repro 绕过 field redaction。
- 不把 credential 作为 document literal 的推荐路径。
- 不依赖人手复制浏览器日志作为主要复现方式。
