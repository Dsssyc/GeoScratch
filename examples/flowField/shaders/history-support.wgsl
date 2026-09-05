fn FlowHistory_supported(texcoords: vec2f) -> bool {
    let ground = FlowScreen_ground_position(texcoords, cleanupUniform.currentInverseMatrix,
        cleanupUniform.cameraX, cleanupUniform.cameraY, cleanupUniform.cameraZ);
    if (ground.valid == 0u) { return false; }
    let currentFlow = FlowVelocity_sample(ground.position, cleanupUniform.requestedLevel,
        FlowVelocityTemporal(cleanupUniform.progress, cleanupUniform.activityKill));
    return (currentFlow.status == 1u || currentFlow.status == 2u) &&
        currentFlow.advectable && currentFlow.speed > 0.0;
}
