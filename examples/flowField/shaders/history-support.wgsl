// Current hard presentation only. Never use this visibility decision to erase
// retained ink; particle death and finite trail decay own different lifetimes.
fn FlowHistory_supported(texcoords: vec2f) -> bool {
    let ground = FlowScreen_ground_position(texcoords, cleanupUniform.currentInverseMatrix,
        cleanupUniform.cameraX, cleanupUniform.cameraY, cleanupUniform.cameraZ);
    if (ground.valid == 0u) { return false; }
    let currentFlow = FlowVelocity_sample(ground.position, cleanupUniform.requestedLevel,
        FlowVelocityTemporal(cleanupUniform.progress, cleanupUniform.activityKill));
    // Missing detail is unknown support, not a new dry boundary. Keep its ink
    // under the ordinary finite decay; never accumulate a frozen particle segment.
    if (currentFlow.status == 0u) { return FlowVelocity_source_contains(ground.position); }
    if (currentFlow.status == 3u || currentFlow.status == 2u) { return true; }
    return currentFlow.status == 1u &&
        currentFlow.advectable && currentFlow.speed > 0.0;
}
