/**
 * @type {GPUBlendState}
 */
export const NormalBlending = {
    color: {
        operation: "add",
        srcFactor: "src-alpha",
        dstFactor: "one-minus-src-alpha"
    },
    alpha: {
        operation: "add",
        srcFactor: "one",
        dstFactor: "one-minus-src-alpha"
    }
}

/**
 * @type {GPUBlendState}
 */
export const AdditiveBlending = {
    color: {
        operation: 'add',
        srcFactor: 'src-alpha',
        dstFactor: 'one'
    },
    alpha: {
        operation: 'add',
        srcFactor: 'src-alpha',
        dstFactor: 'one'
    }
}

/**
 * @type {GPUBlendState}
 */
export const NoBlending = {
    color: {
        operation: 'add',
        srcFactor: 'one',
        dstFactor: 'zero'
    },
    alpha: {
        operation: 'add',
        srcFactor: 'one',
        dstFactor: 'zero'
    }
}

/**
 * @type {GPUBlendState}
 */
export const PremultipliedBlending = {
    color: {
        operation: 'add',
        srcFactor: 'one',
        dstFactor: 'one-minus-src-alpha'
    },
    alpha: {
        operation: 'add',
        srcFactor: 'one',
        dstFactor: 'one-minus-src-alpha'
    }
}