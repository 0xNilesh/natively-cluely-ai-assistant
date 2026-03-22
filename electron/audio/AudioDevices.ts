import path from 'path';

let NativeModule: any = null;

try {
    NativeModule = require('natively-audio');
} catch (e) {
    console.error('[AudioDevices] Failed to load native module:', e);
}

const { getInputDevices, getOutputDevices } = NativeModule || {};

export interface AudioDevice {
    id: string;
    name: string;
}

export class AudioDevices {
    public static getInputDevices(): AudioDevice[] {
        if (!getInputDevices) {
            console.warn('[AudioDevices] Native functionality not available');
            return [];
        }
        try {
            return getInputDevices();
        } catch (e) {
            console.error('[AudioDevices] Failed to get input devices:', e);
            return [];
        }
    }

    public static getOutputDevices(): AudioDevice[] {
        if (!getOutputDevices) {
            console.warn('[AudioDevices] Native functionality not available');
            return [];
        }
        try {
            return getOutputDevices();
        } catch (e) {
            console.error('[AudioDevices] Failed to get output devices:', e);
            return [];
        }
    }
}
