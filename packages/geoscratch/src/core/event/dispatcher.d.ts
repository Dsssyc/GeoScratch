export class EventDispatcher {

    addEventListeners(type: string, callback: Function): void;
    removeEventListeners(type: string, callback: Function): void;
    dispatchEvent(event: any): void;
    handleEvent(event: any): void;
    handleEventsSync(): void;
    handleEventsAsync(): void;
}