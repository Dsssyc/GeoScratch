export interface DefaultDeviceSlot {
    device: GPUDevice | undefined;
    setDevice(device: GPUDevice): void;
}

export default function getDevice(): GPUDevice;

export class Device {
    device?: GPUDevice;
    isPrepared?: boolean;
    setDevice(device: GPUDevice): void;
    static Create(): Promise<Device | undefined>;
}

export function StartDash(): Promise<GPUDevice | undefined>;
export const device: DefaultDeviceSlot;
