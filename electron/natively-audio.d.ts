declare module 'natively-audio' {
    export function getHardwareId(): string;
    export function verifyGumroadKey(key: string): Promise<string>;
}
