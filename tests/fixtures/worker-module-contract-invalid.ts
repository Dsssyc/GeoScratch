import {
    defineWorkerModuleContract,
    type WorkerModuleProtocol,
    type WorkerOperationProtocol,
} from 'geoscratch/scratch'

type InvalidFixtureProtocol = WorkerModuleProtocol<
    Readonly<{
        calculate: WorkerOperationProtocol<{ value: number }, number>
    }>,
    undefined
>

const contract = defineWorkerModuleContract<InvalidFixtureProtocol>({
    id: 'invalid-fixture',
    version: '1',
})

contract.implement({
    operations: {
        calculate(input) {

            return String(input.value)
        },
    },
})
