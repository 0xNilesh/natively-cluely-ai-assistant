import React, { useEffect, useState } from 'react';
import UpdateModal from './UpdateModal';

const UpdateBanner: React.FC = () => {
    const [updateInfo, setUpdateInfo] = useState<any>(null);
    const [parsedNotes, setParsedNotes] = useState<any>(null);
    const [isVisible, setIsVisible] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [status, setStatus] = useState<'idle' | 'downloading' | 'ready' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    useEffect(() => {
        // Listen for update available
        const unsubAvailable = window.electronAPI.onUpdateAvailable((info: any) => {
            console.log('[UpdateBanner] Update available:', info);
            setUpdateInfo(info);
            setErrorMessage(null);
            setStatus('idle'); // Reset from any prior error/state before showing update info
            // If parsed notes are included in the info object (from our backend change)
            if (info.parsedNotes) {
                setParsedNotes(info.parsedNotes);
            }
            setIsVisible(true);
        });

        // Listen for download progress
        const unsubProgress = window.electronAPI.onDownloadProgress((progressObj) => {
            // Ensure modal is visible if download starts
            setIsVisible(true);
            setStatus('downloading');
            setDownloadProgress(progressObj.percent);
        });

        // Listen for update-downloaded event
        const unsubDownloaded = window.electronAPI.onUpdateDownloaded((info) => {
            console.log('[UpdateBanner] Update downloaded:', info);
            setUpdateInfo(info); // Update info again just in case
            if (info.parsedNotes) setParsedNotes(info.parsedNotes);

            setStatus('ready');
            setIsVisible(true);
        });

        // Listen for update errors
        const unsubError = window.electronAPI.onUpdateError((err: string) => {
            console.error('[UpdateBanner] Update error:', err);
            setStatus('error');
            setErrorMessage(err);
        });

        return () => {
            unsubAvailable();
            unsubProgress();
            unsubDownloaded();
            unsubError();
        };
    }, []);

    // Demo/Test mode: Press Cmd+I to trigger backend test-fetch
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!import.meta.env.DEV) return;
            // The user specifically mentioned Cmd+I should be working
            // Checking: metaKey + i (case insensitive)
            if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'i') {
                e.preventDefault();
                console.log("[UpdateBanner] Cmd+I pressed: Triggering Test Release Fetch...");

                // Call the new test method
                window.electronAPI.testReleaseFetch()
                    .then((result: { success: boolean; error?: string }) => {
                        if (result.success) {
                            console.log("[UpdateBanner] Test fetch successful");
                        } else {
                            console.error("[UpdateBanner] Test fetch failed:", result.error);
                        }
                    })
                    .catch((err: any) => console.error("[UpdateBanner] Test fetch error:", err));
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    const handleInstall = () => {
        setStatus('downloading');
        // Trigger download via IPC
        window.electronAPI.downloadUpdate();
    };

    const handleDismiss = () => {
        setIsVisible(false);
        setStatus('idle'); // Reset error/downloading state so next event starts clean
    };

    if (!isVisible) return null;

    return (
        <UpdateModal
            isOpen={isVisible}
            updateInfo={updateInfo}
            parsedNotes={parsedNotes}
            onDismiss={handleDismiss}
            onInstall={handleInstall}
            downloadProgress={downloadProgress}
            status={status}
            errorMessage={errorMessage}
        />
    );
};

export default UpdateBanner;
