export type GPUFeatureDependency = Readonly<{
    feature: string
    requiredFeature: string
}>

const featureDependencies: readonly GPUFeatureDependency[] = Object.freeze([
    Object.freeze({
        feature: 'subgroup-size-control',
        requiredFeature: 'subgroups',
    }),
])

export function normalizeScratchRequiredFeatures(
    features: readonly GPUFeatureName[]
): readonly GPUFeatureName[] {

    return Object.freeze(
        [ ...new Set(features) ].sort((left, right) => left.localeCompare(right))
    )
}

export function findMissingScratchFeatureDependency(
    features: readonly GPUFeatureName[]
): GPUFeatureDependency | undefined {

    const available = new Set<string>(features)
    return featureDependencies.find(dependency => (
        available.has(dependency.feature) &&
        !available.has(dependency.requiredFeature)
    ))
}
