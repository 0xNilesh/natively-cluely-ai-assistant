import { useState, useEffect, useCallback } from 'react';
import { acceleratorToKeys, keysToAccelerator } from '../utils/keyboardUtils';

// Define the shape of our shortcuts configuration
export interface ShortcutConfig {
    whatToAnswer: string[];
    autoAnswerMode: string[];
    clarify: string[];
    followUp: string[];
    dynamicAction4: string[];
    answer: string[];
    codeHint: string[];
    brainstorm: string[];
    scrollUp: string[];
    scrollDown: string[];
    // Window Movement
    moveWindowUp: string[];
    moveWindowDown: string[];
    moveWindowLeft: string[];
    moveWindowRight: string[];
    // General
    toggleVisibility: string[];
    processScreenshots: string[];
    captureAndProcess: string[];
    resetCancel: string[];
    takeScreenshot: string[];
    selectiveScreenshot: string[];
}

export const DEFAULT_SHORTCUTS: ShortcutConfig = {
    whatToAnswer: ['⌘', '1'],
    autoAnswerMode: ['Command', 'f'],
    clarify: ['Command', '2'],
    followUp: ['⌘', '3'],
    dynamicAction4: ['⌘', '4'],
    answer: ['⌘', '5'],
    codeHint: ['⌘', '6'],
    brainstorm: ['⌘', '7'],
    scrollUp: ['↑'],
    scrollDown: ['↓'],
    moveWindowUp: ['⌘', 'Shift', '↑'],
    moveWindowDown: ['⌘', 'Shift', '↓'],
    moveWindowLeft: ['⌘', 'Shift', '←'],
    moveWindowRight: ['⌘', 'Shift', '→'],
    toggleVisibility: ['⌘', 'B'],
    processScreenshots: ['⌘', 'Enter'],
    captureAndProcess: ['⌘', 'Shift', 'Enter'],
    resetCancel: ['⌘', 'R'],
    takeScreenshot: ['⌘', 'H'],
    selectiveScreenshot: ['⌘', 'Shift', 'H']
};

export const useShortcuts = () => {
    // Initialize state with defaults
    const [shortcuts, setShortcuts] = useState<ShortcutConfig>(DEFAULT_SHORTCUTS);

    // Map backend keybinds (array of objects) to frontend state (ShortcutConfig)
    const mapBackendToFrontend = useCallback((backendKeybinds: any[]) => {
        setShortcuts(prev => {
            const newShortcuts: any = { ...prev };

            backendKeybinds.forEach(kb => {
                const keys = acceleratorToKeys(kb.accelerator);

                // Map backend IDs to frontend keys
                if (kb.id === 'chat:whatToAnswer') newShortcuts.whatToAnswer = keys;
                else if (kb.id === 'app:toggle-global-overlay') newShortcuts.toggleGlobalOverlay = keys;
                else if (kb.id === 'chat:followup') newShortcuts.followUp = keys;
                else if (kb.id === 'chat:clarify') newShortcuts.clarify = keys;
                else if (kb.id === 'chat:dynamicAction4') newShortcuts.dynamicAction4 = keys;
                else if (kb.id === 'chat:answer') newShortcuts.answer = keys;
                else if (kb.id === 'chat:codeHint') newShortcuts.codeHint = keys;
                else if (kb.id === 'chat:brainstorm') newShortcuts.brainstorm = keys;
                else if (kb.id === 'chat:scrollUp') newShortcuts.scrollUp = keys;
                else if (kb.id === 'chat:scrollDown') newShortcuts.scrollDown = keys;
                else if (kb.id === 'chat:auto-answer-mode') newShortcuts.autoAnswerMode = keys;
                // Window
                else if (kb.id === 'window:move-up') newShortcuts.moveWindowUp = keys;
                else if (kb.id === 'window:move-down') newShortcuts.moveWindowDown = keys;
                else if (kb.id === 'window:move-left') newShortcuts.moveWindowLeft = keys;
                else if (kb.id === 'window:move-right') newShortcuts.moveWindowRight = keys;
                // General
                else if (kb.id === 'general:toggle-visibility') newShortcuts.toggleVisibility = keys;
                else if (kb.id === 'general:process-screenshots') newShortcuts.processScreenshots = keys;
                else if (kb.id === 'general:capture-and-process') newShortcuts.captureAndProcess = keys;
                else if (kb.id === 'general:reset-cancel') newShortcuts.resetCancel = keys;
                else if (kb.id === 'general:take-screenshot') newShortcuts.takeScreenshot = keys;
                else if (kb.id === 'general:selective-screenshot') newShortcuts.selectiveScreenshot = keys;
            });

            return newShortcuts;
        });
    }, []);

    // Load from Main Process on mount
    useEffect(() => {
        const fetchKeybinds = async () => {
            try {
                const keybinds = await window.electronAPI.getKeybinds();
                mapBackendToFrontend(keybinds);
            } catch (error) {
                console.error('Failed to fetch keybinds:', error);
            }
        };

        fetchKeybinds();

        // Listen for updates
        const unsubscribe = window.electronAPI.onKeybindsUpdate((keybinds) => {
            mapBackendToFrontend(keybinds);
        });

        return unsubscribe;
    }, [mapBackendToFrontend]);

    // Function to update a specific shortcut
    const updateShortcut = useCallback(async (actionId: keyof ShortcutConfig, keys: string[]) => {
        // Optimistic update
        setShortcuts(prev => ({ ...prev, [actionId]: keys }));

        const accelerator = keysToAccelerator(keys);
        let backendId = '';

        // Map frontend key back to backend ID
        switch (actionId) {
            case 'whatToAnswer': backendId = 'chat:whatToAnswer'; break;
            case 'autoAnswerMode': backendId = 'chat:auto-answer-mode'; break;
            case 'clarify': backendId = 'chat:clarify'; break;
            case 'followUp': backendId = 'chat:followup'; break;
            case 'dynamicAction4': backendId = 'chat:dynamicAction4'; break;
            case 'answer': backendId = 'chat:answer'; break;
            case 'codeHint': backendId = 'chat:codeHint'; break;
            case 'brainstorm': backendId = 'chat:brainstorm'; break;
            case 'scrollUp': backendId = 'chat:scrollUp'; break;
            case 'scrollDown': backendId = 'chat:scrollDown'; break;
            // Window
            case 'moveWindowUp': backendId = 'window:move-up'; break;
            case 'moveWindowDown': backendId = 'window:move-down'; break;
            case 'moveWindowLeft': backendId = 'window:move-left'; break;
            case 'moveWindowRight': backendId = 'window:move-right'; break;
            // General
            case 'toggleVisibility': backendId = 'general:toggle-visibility'; break;
            case 'processScreenshots': backendId = 'general:process-screenshots'; break;
            case 'captureAndProcess': backendId = 'general:capture-and-process'; break;
            case 'resetCancel': backendId = 'general:reset-cancel'; break;
            case 'takeScreenshot': backendId = 'general:take-screenshot'; break;
            case 'selectiveScreenshot': backendId = 'general:selective-screenshot'; break;
            default: break;
        }

        if (backendId) {
            try {
                await window.electronAPI.setKeybind(backendId, accelerator);
            } catch (error) {
                console.error(`Failed to set keybind for ${actionId}:`, error);
            }
        }
    }, []);

    // Function to reset all shortcuts to defaults
    const resetShortcuts = useCallback(async () => {
        try {
            const defaults = await window.electronAPI.resetKeybinds();
            mapBackendToFrontend(defaults);
        } catch (error) {
            console.error('Failed to reset keybinds:', error);
        }
    }, [mapBackendToFrontend]);

    // Helper to check if a keyboard event matches a configured shortcut
    const isShortcutPressed = useCallback((event: KeyboardEvent | React.KeyboardEvent, actionId: keyof ShortcutConfig): boolean => {
        const keys = shortcuts[actionId];
        if (!keys || keys.length === 0) return false;

        // Check modifiers
        // Note: We use the symbols now in UI, but keyboard events still use standard properties
        const hasMeta = keys.some(k => ['⌘', 'Command', 'Meta'].includes(k));
        const hasCtrl = keys.some(k => ['⌃', 'Control', 'Ctrl'].includes(k));
        const hasAlt = keys.some(k => ['⌥', 'Alt', 'Option'].includes(k));
        const hasShift = keys.some(k => ['⇧', 'Shift'].includes(k));

        if (event.metaKey !== hasMeta) return false;
        if (event.ctrlKey !== hasCtrl) return false;
        if (event.altKey !== hasAlt) return false;
        if (event.shiftKey !== hasShift) return false;

        // Find the main non-modifier key
        const mainKey = keys.find(k =>
            !['⌘', 'Command', 'Meta', '⇧', 'Shift', '⌥', 'Alt', 'Option', '⌃', 'Control', 'Ctrl'].includes(k)
        );

        if (!mainKey) return false; // Modifiers only

        // Normalize checks
        const eventKey = event.key.toLowerCase();
        const configKey = mainKey.toLowerCase();

        // Handle Space specifically
        if (configKey === 'space') {
            return event.code === 'Space';
        }

        // Handle Arrow keys
        // Electron accelerator uses 'ArrowUp' (mapped from 'Up'), event.key is 'ArrowUp'
        // So direct comparison usually works

        return eventKey === configKey;
    }, [shortcuts]);

    return {
        shortcuts,
        updateShortcut,
        resetShortcuts,
        isShortcutPressed
    };
};
