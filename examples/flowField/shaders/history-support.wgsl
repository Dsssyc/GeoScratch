// Current hard presentation only. Never use this visibility decision to erase
// retained ink; particle death and finite trail decay own different lifetimes.
fn FlowHistory_coverage(texcoords: vec2f) -> f32 {
    let ground = FlowScreen_ground_position(texcoords, cleanupUniform.currentInverseMatrix,
        cleanupUniform.cameraX, cleanupUniform.cameraY, cleanupUniform.cameraZ);
    if (ground.valid == 0u) { return 0.0; }
    return FlowPresentation_coverage(ground.position, cleanupUniform.requestedLevel,
        cleanupUniform.progress, cleanupUniform.activityKill);
}
