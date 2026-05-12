import React, { useState, useEffect, useCallback } from 'react';
import { Download, Trash2, HardDrive, Check, Loader2, Zap, AlertCircle } from 'lucide-react';

interface ModelInfo {
    id: string;
    name: string;
    sizeMb: number;
    speed: 'very-fast' | 'fast' | 'medium' | 'slow';
    accuracy: 'decent' | 'good' | 'high' | 'very-high';
    multilingual: boolean;
    status: 'available' | 'missing' | 'downloading' | 'error';
    errorMessage?: string;
    requiresAppleSilicon?: boolean;
}

interface HardwareInfo {
    arch: string;
    platform: string;
    isAppleSilicon: boolean;
    totalRamGb: number;
    tier: 'excellent' | 'good' | 'limited';
    recommendation: string;
    recommendedModel: string;
}

interface ChannelConfig {
    enabled: boolean;
    micModelId: string;
    systemModelId: string;
    globalModelId: string;
}

const electronAPI = (window as any).electronAPI;

export function LocalWhisperModelPanel() {
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [hardware, setHardware] = useState<HardwareInfo | null>(null);
    const [config, setConfig] = useState<ChannelConfig>({
        enabled: false,
        micModelId: '',
        systemModelId: '',
        globalModelId: ''
    });
    
    const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
    const [downloadingSet, setDownloadingSet] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);

    const loadData = useCallback(async () => {
        try {
            const [modelsRes, hwRes, cfgRes] = await Promise.all([
                electronAPI?.localWhisperGetModels?.(),
                electronAPI?.localWhisperGetHardware?.(),
                electronAPI?.localWhisperGetChannelConfig?.()
            ]);
            
            if (modelsRes) setModels(modelsRes.models ?? []);
            if (hwRes) setHardware(hwRes);
            if (cfgRes) setConfig(cfgRes);
            
            // Auto-select initial models if none are set
            if (cfgRes && modelsRes && modelsRes.models) {
                const list = modelsRes.models;
                const avail = list.filter((m: any) => m.status === 'available');
                if (avail.length > 0) {
                    let needsUpdate = false;
                    const newCfg = { ...cfgRes };
                    
                    if (!cfgRes.globalModelId) {
                        newCfg.globalModelId = avail[0].id;
                        electronAPI?.localWhisperSetModel?.(avail[0].id);
                        needsUpdate = true;
                    }
                    if (!cfgRes.micModelId) {
                        newCfg.micModelId = avail[0].id;
                        needsUpdate = true;
                    }
                    if (!cfgRes.systemModelId) {
                        newCfg.systemModelId = avail[0].id;
                        needsUpdate = true;
                    }
                    
                    if (needsUpdate) {
                        setConfig(newCfg);
                        electronAPI?.localWhisperSetChannelConfig?.(newCfg);
                    }
                }
            }
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadData();
    }, [loadData]);

    // Handle downloads
    useEffect(() => {
        const unsubProgress = electronAPI?.onLocalWhisperDownloadProgress?.((data: { modelId: string; progress: number }) => {
            setDownloadProgress(prev => ({ ...prev, [data.modelId]: data.progress }));
        });
        const unsubComplete = electronAPI?.onLocalWhisperDownloadComplete?.((data: { modelId: string }) => {
            setDownloadingSet(prev => { const s = new Set(prev); s.delete(data.modelId); return s; });
            setDownloadProgress(prev => { const d = { ...prev }; delete d[data.modelId]; return d; });
            loadData();
        });
        const unsubError = electronAPI?.onLocalWhisperDownloadError?.((data: { modelId: string; error: string }) => {
            setDownloadingSet(prev => { const s = new Set(prev); s.delete(data.modelId); return s; });
            setDownloadProgress(prev => { const d = { ...prev }; delete d[data.modelId]; return d; });
            setModels(prev => prev.map(m => m.id === data.modelId ? { ...m, status: 'error', errorMessage: data.error } : m));
        });
        
        return () => { unsubProgress?.(); unsubComplete?.(); unsubError?.(); };
    }, [loadData]);

    const handleDownload = async (modelId: string) => {
        if (downloadingSet.has(modelId)) return;
        setDownloadingSet(prev => new Set([...prev, modelId]));
        setModels(prev => prev.map(m => m.id === modelId ? { ...m, status: 'downloading' } : m));
        setDownloadProgress(prev => ({ ...prev, [modelId]: 0 }));
        
        const result = await electronAPI?.localWhisperStartDownload?.(modelId);
        if (!result?.success && result?.error !== 'already-downloading') {
            setDownloadingSet(prev => { const s = new Set(prev); s.delete(modelId); return s; });
            setDownloadProgress(prev => { const d = { ...prev }; delete d[modelId]; return d; });
            setModels(prev => prev.map(m => m.id === modelId
                ? { ...m, status: 'error', errorMessage: result?.error ?? 'Download failed' }
                : m
            ));
        }
    };

    const handleDelete = async (modelId: string) => {
        await electronAPI?.localWhisperDeleteModel?.(modelId);
        await loadData();
    };

    const toggleDualChannel = async (enabled: boolean) => {
        const newCfg = { ...config, enabled };
        setConfig(newCfg);
        await electronAPI?.localWhisperSetChannelConfig?.({ enabled });
    };

    const setGlobalModel = async (modelId: string) => {
        setConfig(prev => ({ ...prev, globalModelId: modelId }));
        await electronAPI?.localWhisperSetModel?.(modelId);
    };

    const setMicModel = async (modelId: string) => {
        setConfig(prev => ({ ...prev, micModelId: modelId }));
        await electronAPI?.localWhisperSetChannelConfig?.({ micModelId: modelId });
    };

    const setSystemModel = async (modelId: string) => {
        setConfig(prev => ({ ...prev, systemModelId: modelId }));
        await electronAPI?.localWhisperSetChannelConfig?.({ systemModelId: modelId });
    };

    if (loading) {
        return <div className="p-4 flex justify-center text-text-tertiary"><Loader2 className="animate-spin w-5 h-5" /></div>;
    }

    const availableModels = models.filter(m => m.status === 'available');
    
    return (
        <div className="space-y-4">
            <div className="bg-bg-card rounded-xl border border-border-subtle p-4">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h3 className="text-sm font-semibold text-text-primary">Local Models</h3>
                        <p className="text-xs text-text-secondary mt-1">Select the AI models you want to use for Speech-to-Text inference.</p>
                    </div>
                </div>

                <div className="space-y-4">
                    <label className="flex items-center gap-2 cursor-pointer group">
                        <input
                            type="checkbox"
                            className="w-4 h-4 rounded border-border-subtle text-accent-primary focus:ring-accent-primary bg-bg-input"
                            checked={config.enabled}
                            onChange={(e) => toggleDualChannel(e.target.checked)}
                        />
                        <span className="text-sm text-text-primary group-hover:text-accent-primary transition-colors">Use different models for mic and system audio</span>
                    </label>

                    {config.enabled ? (
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">Mic Audio Model</label>
                                <select
                                    className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:ring-2 focus:ring-accent-primary/20 outline-none"
                                    value={config.micModelId}
                                    onChange={(e) => setMicModel(e.target.value)}
                                >
                                    {availableModels.length === 0 && <option value="">No models installed</option>}
                                    {availableModels.map(m => (
                                        <option key={m.id} value={m.id}>{m.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">System Audio Model</label>
                                <select
                                    className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:ring-2 focus:ring-accent-primary/20 outline-none"
                                    value={config.systemModelId}
                                    onChange={(e) => setSystemModel(e.target.value)}
                                >
                                    {availableModels.length === 0 && <option value="">No models installed</option>}
                                    {availableModels.map(m => (
                                        <option key={m.id} value={m.id}>{m.name}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    ) : (
                        <div>
                            <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">Global Model</label>
                            <select
                                className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:ring-2 focus:ring-accent-primary/20 outline-none"
                                value={config.globalModelId}
                                onChange={(e) => setGlobalModel(e.target.value)}
                            >
                                {availableModels.length === 0 && <option value="">No models installed</option>}
                                {availableModels.map(m => (
                                    <option key={m.id} value={m.id}>{m.name}</option>
                                ))}
                            </select>
                        </div>
                    )}
                </div>
            </div>

            <div className="bg-bg-card rounded-xl border border-border-subtle overflow-hidden">
                <div className="px-4 py-3 bg-bg-elevated/50 border-b border-border-subtle flex justify-between items-center">
                    <h3 className="text-sm font-semibold text-text-primary">Model Manager</h3>
                    {hardware?.recommendedModel && (
                        <span className="text-xs text-text-tertiary">Recommended for your {hardware.isAppleSilicon ? 'Mac' : 'PC'}: {models.find(m => m.id === hardware.recommendedModel)?.name}</span>
                    )}
                </div>
                
                <div className="divide-y divide-border-subtle/50">
                    {models.map(model => {
                        const isDownloading = model.status === 'downloading' || downloadingSet.has(model.id);
                        const progress = downloadProgress[model.id] || 0;
                        const isAvailable = model.status === 'available';
                        const isRecommended = hardware?.recommendedModel === model.id;
                        
                        return (
                            <div key={model.id} className="p-4 flex items-center justify-between hover:bg-black/[0.02] dark:hover:bg-white/[0.01] transition-colors">
                                <div className="flex-1 min-w-0 pr-4">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-sm font-medium text-text-primary truncate">{model.name}</span>
                                        {isRecommended && (
                                            <span className="px-1.5 py-0.5 rounded-md bg-accent-primary/10 text-accent-primary text-[9px] font-bold uppercase tracking-wider">Recommended</span>
                                        )}
                                        {model.requiresAppleSilicon && (
                                            <span className="px-1.5 py-0.5 rounded-md bg-purple-500/10 text-purple-500 text-[9px] font-bold uppercase tracking-wider">Apple Silicon</span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-3 text-xs text-text-tertiary">
                                        <span className="flex items-center gap-1"><HardDrive size={12} /> {model.sizeMb} MB</span>
                                        <span className="flex items-center gap-1"><Zap size={12} /> {model.speed}</span>
                                        <span className="flex items-center gap-1"><Check size={12} /> {model.accuracy} acc</span>
                                    </div>
                                    
                                    {isDownloading && (
                                        <div className="mt-3">
                                            <div className="flex justify-between text-[10px] text-text-secondary mb-1 uppercase tracking-wider font-medium">
                                                <span>Downloading...</span>
                                                <span>{Math.round(progress)}%</span>
                                            </div>
                                            <div className="w-full h-1.5 bg-bg-input rounded-full overflow-hidden">
                                                <div 
                                                    className="h-full bg-accent-primary transition-all duration-300 ease-out"
                                                    style={{ width: `${progress}%` }}
                                                />
                                            </div>
                                        </div>
                                    )}
                                    
                                    {model.status === 'error' && (
                                        <div className="mt-2 text-xs text-red-500 flex items-center gap-1">
                                            <AlertCircle size={12} />
                                            {model.errorMessage || 'Failed to download model'}
                                        </div>
                                    )}
                                </div>
                                
                                <div className="flex-shrink-0 flex items-center gap-2">
                                    {!isAvailable && !isDownloading && (
                                        <button
                                            onClick={() => handleDownload(model.id)}
                                            className="px-3 py-1.5 rounded-lg bg-accent-primary/10 hover:bg-accent-primary/20 text-accent-primary text-xs font-medium transition-colors flex items-center gap-1.5"
                                        >
                                            <Download size={14} /> Install
                                        </button>
                                    )}
                                    
                                    {isAvailable && (
                                        <button
                                            onClick={() => handleDelete(model.id)}
                                            className="p-1.5 rounded-lg text-text-tertiary hover:bg-red-500/10 hover:text-red-500 transition-colors"
                                            title="Delete model"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
