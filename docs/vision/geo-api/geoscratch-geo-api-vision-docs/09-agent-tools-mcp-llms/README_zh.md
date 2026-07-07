# Agent Tools、MCP 与 LLM 文档入口

状态: Vision draft  
日期: 2026-07-06

## 决策

`geo` 应把 agent 操作接口作为正式开发目标。AI 不应仅靠阅读人类文档和生成任意 JS 操作框架；它应通过受限、可验证、可回滚的 tools/resources/prompts 操作 `GeoVizDocument` 和 runtime snapshot。

## Agent-facing layers

```text
Machine-readable docs
    llms.txt / schema / examples / diagnostics catalog

Agent tool protocol
    validate / plan / apply / explain / profile / repro / test

Runtime resources
    document / schema / render graph / tile cache / diagnostics / metrics

Mutation safety
    patch / transaction / checkpoint / rollback / security diff
```

## MCP resources

建议暴露:

```text
geoscratch://project/document
geoscratch://project/document-schema
geoscratch://project/source-schemas
geoscratch://project/style-schema
geoscratch://runtime/snapshot
geoscratch://runtime/render-graph
geoscratch://runtime/resource-graph
geoscratch://runtime/tile-cache
geoscratch://runtime/layout-products
geoscratch://runtime/diagnostics
geoscratch://runtime/profile/latest
geoscratch://docs/geo-api
geoscratch://docs/scratch-api
geoscratch://examples/index
```

Resources 是只读上下文。Mutation 必须走 tools。

## MCP tools

```ts
type AgentTool =
    | 'validate_document'
    | 'plan_patch'
    | 'apply_patch'
    | 'rollback'
    | 'explain_layer'
    | 'explain_source'
    | 'explain_tile'
    | 'explain_feature'
    | 'explain_pixel'
    | 'inspect_render_graph'
    | 'inspect_resource_graph'
    | 'inspect_tile_cache'
    | 'profile_frame'
    | 'create_repro_case'
    | 'run_geo_assertions'
    | 'plan_migration'
    | 'apply_migration'
    | 'suggest_visual_encoding'
```

每个 tool 的输出都应包括:

```ts
type AgentToolResult<T> = {
    ok: boolean
    result?: T
    diagnostics?: GeoDiagnosticReport
    revision?: string
    artifacts?: ArtifactRef[]
}
```

## Tool safety

Mutation tool 必须支持:

- `dryRun`。
- `baseRevision`。
- `requirePlan`。
- `securityConfirmation`。
- `rollbackToken`。
- `maxCost` 或 budget guard。

示例:

```ts
plan_patch({
    baseRevision: 'rev_123',
    patch,
    maxCost: { gpuMemoryMBDelta: 128, networkRequestsDelta: 0 },
    includeSecurityDiff: true
})
```

## Prompts

可以提供可复用 prompt templates，但 prompt 不是核心契约。示例:

```text
create_choropleth_layer
create_height_extrusion_layer
debug_missing_features
optimize_label_placement
profile_slow_view
migrate_document_version
create_repro_for_render_bug
add_s101_standard_display
```

Prompt 应引导 agent 调用 tools，而不是直接输出不可验证代码。

## llms.txt

仓库根或文档站建议提供:

```text
/llms.txt
/llms-full.txt
/docs/schema/geoviz-document.schema.json
/docs/schema/geo-diagnostics.schema.json
/docs/schema/geo-patch.schema.json
/docs/schema/source-schema.schema.json
/docs/examples/index.json
/docs/errors/index.json
```

`llms.txt` 内容应简短，指向最重要的机器可读资源:

```text
# GeoScratch

GeoScratch is a WebGPU-based geospatial visualization framework.

Core docs:
- Scratch GPU kernel vision: /docs/vision/scratch-api/
- Geo API vision: /docs/vision/geo-api/
- GeoVizDocument schema: /docs/schema/geoviz-document.schema.json
- Diagnostics catalog: /docs/errors/index.json
- Agent tools: /docs/agent-tools.json
```

## Machine-readable examples

每个示例应包含:

```text
example.geoviz.json
example.intent.json
example.assertions.json
example.expected.png
example.profile.json
example.explanation.md
example.failure-modes.md
```

AI 可以从 intent 生成 patch，从 assertions 验证结果，从 failure-modes 学会避免常见错误。

## Documentation split

```text
Human docs:
    tutorial, concept explanation, screenshots, migration narrative

Agent docs:
    schema, API contracts, diagnostic codes, examples, counterexamples, tool specs

Runtime docs:
    explain outputs, profile outputs, render graph/resource graph schemas
```

不要只提供 human tutorial。AI 最需要的是 schema、counterexample、diagnostic catalog 和 structured examples。

## Agent diagnostics

Agent tool 失败不应返回普通字符串:

```json
{
  "ok": false,
  "diagnostics": {
    "version": 1,
    "diagnostics": [
      {
        "code": "GEO_STYLE_FIELD_MISSING",
        "severity": "error",
        "phase": "style",
        "subject": { "kind": "StyleExpression", "layerId": "buildings", "path": "/style/paint/color" },
        "expected": { "field": "height" },
        "actual": { "availableFields": ["name", "class"] },
        "suggestions": []
      }
    ]
  }
}
```

## 非目标

- 不把自然语言 prompt 作为唯一 agent interface。
- 不允许 agent 直接调用内部 renderer mutation。
- 不让 tools 返回 prose-only errors。
- 不把 MCP 作为必选 runtime dependency；可以是官方 adapter。
- 不把 machine-readable docs 当成 README 的替代；两者面向不同读者。
