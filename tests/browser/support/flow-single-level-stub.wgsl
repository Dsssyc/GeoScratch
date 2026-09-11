// Parameter interface for history proofs with one z0 source and 52-bit positions.
// The owning proof separately controls sampled values, failures and visibility.
fn FlowVelocityCurrent_level_count_value() -> u32 { return 1u; }
fn FlowVelocityNext_level_count_value() -> u32 { return 1u; }
fn FlowVelocityCurrent_page_size_value() -> vec2u { return vec2u(256u); }
fn FlowVelocityNext_page_size_value() -> vec2u { return vec2u(256u); }
fn FlowVelocityCurrent_matrix_at(level: u32) -> u32 { return 0u; }
fn FlowVelocityNext_matrix_at(level: u32) -> u32 { return 0u; }
fn FlowVelocityCurrent_minimum_texel_at(level: u32) -> vec2u { return vec2u(0u); }
fn FlowVelocityNext_minimum_texel_at(level: u32) -> vec2u { return vec2u(0u); }
fn FlowVelocityCurrent_maximum_texel_at(level: u32) -> vec2u { return vec2u(255u); }
fn FlowVelocityNext_maximum_texel_at(level: u32) -> vec2u { return vec2u(255u); }
fn FlowVelocityCurrent_half_texel_at(level: u32) -> vec2u { return vec2u(0u, 2048u); }
fn FlowVelocityNext_half_texel_at(level: u32) -> vec2u { return vec2u(0u, 2048u); }
