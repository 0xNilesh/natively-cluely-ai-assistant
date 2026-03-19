import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Crosshair } from 'lucide-react';

/**
 * Cropper component provides a visual interface for selecting a screen area.
 * 
 * DESIGN NOTES:
 * 1. Undetectable UI: Instead of using system cursors (like cursor: crosshair), which
 *    are visible on screen shares, we use 'cursor: default' and draw custom guides
 *    on the Canvas. Since the window is protected, these guides are invisible to viewers.
 * 2. State Reset: The component listens for 'reset-cropper' IPC events because the
 *    window is reused (Windows) and doesn't unmount between captures.
 * 3. Theme-aware: Supports light/dark themes for consistent UX.
 */
const Cropper: React.FC = () => {
    const [startPos, setStartPos] = useState<{ x: number, y: number } | null>(null);
    const [currentPos, setCurrentPos] = useState<{ x: number, y: number } | null>(null);
    const [mousePos, setMousePos] = useState<{ x: number, y: number } | null>(null);
    const [hudPosition, setHudPosition] = useState<{ x: number, y: number } | null>(null);
    const [theme, setTheme] = useState<'dark' | 'light'>('dark');

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const hudRef = useRef<HTMLDivElement>(null);
    const hudWidthRef = useRef<number>(320); // Default estimate; updated after mount
    const isMountedRef = useRef(true);

    const devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const MIN_SELECTION_SIZE = 5;

    // Theme detection
    useEffect(() => {
        const detectTheme = () => {
            const currentTheme = document.documentElement.getAttribute('data-theme') as 'dark' | 'light' || 'dark';
            setTheme(currentTheme);
        };

        detectTheme();

        const observer = new MutationObserver(() => {
            detectTheme();
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

        return () => observer.disconnect();
    }, []);

    // Reset handler
    useEffect(() => {
        isMountedRef.current = true;
        
        // Measure HUD width dynamically after mount
        const measureHudWidth = () => {
            if (hudRef.current) {
                const width = hudRef.current.offsetWidth;
                if (width > 0) {
                    hudWidthRef.current = width;
                    console.log(`[Cropper] Measured HUD width: ${width}px`);
                }
            }
        };

        // Measure on mount and when HUD becomes visible
        const hudObserver = new MutationObserver(measureHudWidth);
        if (hudRef.current) {
            hudObserver.observe(hudRef.current, { childList: true, subtree: true });
        }
        
        // Initial measurement after a short delay to allow render
        const timer = setTimeout(measureHudWidth, 100);
        
        const cleanup = (window as any).electronAPI.onResetCropper((data: { hudPosition: { x: number; y: number } }) => {
            if (isMountedRef.current) {
                setStartPos(null);
                setCurrentPos(null);
                setMousePos(null);
                // Use measured HUD width for centering (subtract half = hudWidthRef.current / 2)
                const halfWidth = hudWidthRef.current / 2;
                setHudPosition({
                    x: data.hudPosition.x - halfWidth,
                    y: data.hudPosition.y
                });
            }
        });

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                (window as any).electronAPI.cropperCancelled();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        
        return () => {
            isMountedRef.current = false;
            window.removeEventListener('keydown', handleKeyDown);
            cleanup();
            hudObserver.disconnect();
            clearTimeout(timer);
        };
    }, []);

    const handleMouseDown = (e: React.MouseEvent) => {
        setStartPos({ x: e.clientX, y: e.clientY });
        setCurrentPos({ x: e.clientX, y: e.clientY });
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        setMousePos({ x: e.clientX, y: e.clientY });
        if (startPos) {
            setCurrentPos({ x: e.clientX, y: e.clientY });
        }
    };

    const handleMouseUp = useCallback(() => {
        if (startPos && currentPos) {
            const x = Math.min(startPos.x, currentPos.x);
            const y = Math.min(startPos.y, currentPos.y);
            const width = Math.abs(currentPos.x - startPos.x);
            const height = Math.abs(currentPos.y - startPos.y);

            if (width > MIN_SELECTION_SIZE && height > MIN_SELECTION_SIZE) {
                (window as any).electronAPI.cropperConfirmed({ x, y, width, height });
            } else {
                setStartPos(null);
                setCurrentPos(null);
            }
        }
    }, [startPos, currentPos]);

    // Canvas rendering
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = window.innerWidth;
        const height = window.innerHeight;
        canvas.width = width;
        canvas.height = height;

        ctx.clearRect(0, 0, width, height);

        // Background overlay
        ctx.fillStyle = theme === 'dark' ? 'rgba(0, 0, 0, 0.35)' : 'rgba(0, 0, 0, 0.12)';
        ctx.fillRect(0, 0, width, height);

        if (startPos && currentPos) {
            const x = Math.min(startPos.x, currentPos.x);
            const y = Math.min(startPos.y, currentPos.y);
            const w = Math.abs(currentPos.x - startPos.x);
            const h = Math.abs(currentPos.y - startPos.y);

            // Clear selected area
            ctx.clearRect(x, y, w, h);

            // Subtle selection border
            ctx.strokeStyle = theme === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.12)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

            // Corners
            const cornerSize = 14 * devicePixelRatio;
            
            ctx.strokeStyle = theme === 'dark' ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.4)';
            ctx.lineWidth = 1.5 * devicePixelRatio;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            const drawCorner = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.lineTo(x3, y3);
                ctx.stroke();
            };

            // Corners
            drawCorner(x, y + cornerSize, x, y, x + cornerSize, y);
            drawCorner(x + w - cornerSize, y, x + w, y, x + w, y + cornerSize);
            drawCorner(x + w, y + h - cornerSize, x + w, y + h, x + w - cornerSize, y + h);
            drawCorner(x + cornerSize, y + h, x, y + h, x, y + h - cornerSize);

            ctx.shadowBlur = 0;
        }
    }, [startPos, currentPos, theme, devicePixelRatio]);

    const isLightTheme = theme === 'light';

    return (
        <div 
            className="w-screen h-screen cursor-default overflow-hidden bg-transparent select-none"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
        >
            <canvas ref={canvasRef} className="block pointer-events-none" />

            {/* Clean HUD */}
            {!startPos && hudPosition && (
                <div 
                    ref={hudRef}
                    className="absolute pointer-events-none animate-fade-in-up"
                    style={{
                        left: hudPosition.x,
                        top: hudPosition.y
                    }}
                >
                    <div 
                        className="flex items-center gap-3 px-4 py-2 rounded-full"
                        style={{
                            background: isLightTheme 
                                ? 'rgba(255, 255, 255, 0.9)' 
                                : 'rgba(28, 28, 32, 0.92)',
                            backdropFilter: 'blur(20px)',
                            WebkitBackdropFilter: 'blur(20px)',
                            border: isLightTheme
                                ? '1px solid rgba(0, 0, 0, 0.06)'
                                : '1px solid rgba(255, 255, 255, 0.08)',
                            boxShadow: isLightTheme
                                ? '0 4px 24px -4px rgba(0, 0, 0, 0.12)'
                                : '0 4px 24px -4px rgba(0, 0, 0, 0.4)',
                        }}
                    >
                        <div 
                            className="flex items-center justify-center w-7 h-7 rounded-lg"
                            style={{ background: 'rgba(59, 130, 246, 0.15)' }}
                        >
                            <Crosshair className="w-4 h-4" style={{ color: '#3b82f6' }} />
                        </div>

                        <span 
                            className="text-sm font-medium"
                            style={{ 
                                color: isLightTheme ? '#000000' : '#ffffff',
                                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
                            }}
                        >
                            Select area
                        </span>

                        <div 
                            className="h-4 w-px mx-1"
                            style={{ 
                                background: isLightTheme 
                                    ? 'rgba(0, 0, 0, 0.1)' 
                                    : 'rgba(255, 255, 255, 0.15)' 
                            }}
                        />

                        <div className="flex items-center gap-1.5">
                            <span 
                                className="text-[10px] font-medium uppercase tracking-wider"
                                style={{ 
                                    color: isLightTheme 
                                        ? 'rgba(0, 0, 0, 0.5)' 
                                        : 'rgba(255, 255, 255, 0.5)' 
                                }}
                            >
                                Esc
                            </span>
                            <span 
                                className="text-[10px]"
                                style={{ 
                                    color: isLightTheme 
                                        ? 'rgba(0, 0, 0, 0.4)' 
                                        : 'rgba(255, 255, 255, 0.4)' 
                                }}
                            >
                                to cancel
                            </span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Cropper;
