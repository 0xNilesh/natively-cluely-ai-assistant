// Solutions.tsx — Rolling Interview Script / Teleprompter UI
import React, { useState, useEffect, useRef } from "react"
import { useQuery, useQueryClient } from "react-query"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism"

import ScreenshotQueue from "../components/Queue/ScreenshotQueue"
import {
  Toast,
  ToastDescription,
  ToastMessage,
  ToastTitle,
  ToastVariant
} from "../components/ui/toast"
import { Solution } from "../types/solutions"
import SolutionCommands from "../components/Solutions/SolutionCommands"
import Debug from "./Debug"

// ─── Phase Card ──────────────────────────────────────────────────────────────

interface PhaseCardProps {
  phase: number
  label: string
  icon: string
  accentClass: string
  borderClass: string
  children: React.ReactNode
}

const PhaseCard: React.FC<PhaseCardProps> = ({ phase, label, icon, accentClass, borderClass, children }) => (
  <div className={`rounded-xl border ${borderClass} overflow-hidden`}>
    {/* Header */}
    <div className={`flex items-center gap-2 px-4 py-2.5 ${accentClass}`}>
      <span className="text-base">{icon}</span>
      <span className="text-[11px] font-bold uppercase tracking-widest opacity-80">Phase {phase}</span>
      <span className="text-[12px] font-semibold">{label}</span>
    </div>
    {/* Body */}
    <div className="px-4 py-3 bg-black/40">
      {children}
    </div>
  </div>
)

// ─── Spoken Script Block ──────────────────────────────────────────────────────

const SpokenScript: React.FC<{ text: string }> = ({ text }) => (
  <div className="space-y-1.5">
    <p className="text-[10px] font-semibold uppercase tracking-wider text-white/40">🎙️ Say this out loud</p>
    <p className="text-[14px] leading-relaxed text-white/90 italic font-light">
      {text}
    </p>
  </div>
)

// ─── Complexity Pill ─────────────────────────────────────────────────────────

const ComplexityRow: React.FC<{ time: string; space: string }> = ({ time, space }) => (
  <div className="flex flex-wrap gap-2 mt-3">
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-600/20 border border-blue-500/30 text-[12px] font-medium text-blue-300">
      <span className="opacity-60">⏱ Time:</span> <strong>{time}</strong>
    </span>
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-600/20 border border-emerald-500/30 text-[12px] font-medium text-emerald-300">
      <span className="opacity-60">💾 Space:</span> <strong>{space}</strong>
    </span>
  </div>
)

// ─── Loading Skeleton ─────────────────────────────────────────────────────────

const ScriptLoader: React.FC = () => (
  <div className="space-y-4 py-2">
    <p className="text-[13px] text-center bg-gradient-to-r from-violet-300 via-white to-violet-300 bg-clip-text text-transparent animate-pulse font-medium">
      ✍️ Drafting your interview script…
    </p>
    {[1, 2, 3, 4].map(i => (
      <div key={i} className="rounded-xl border border-white/10 overflow-hidden opacity-40" style={{ animation: `pulse 1.5s ease-in-out ${i * 0.15}s infinite` }}>
        <div className="h-8 bg-white/5" />
        <div className="px-4 py-3 space-y-2">
          <div className="h-3 bg-white/10 rounded w-3/4" />
          <div className="h-3 bg-white/10 rounded w-1/2" />
        </div>
      </div>
    ))}
  </div>
)

// ─── Module ───────────────────────────────────────────────────────────────────

interface SolutionsProps {
  setView: React.Dispatch<React.SetStateAction<"queue" | "solutions" | "debug">>
}

const Solutions: React.FC<SolutionsProps> = ({ setView }) => {
  const queryClient = useQueryClient()
  const contentRef = useRef<HTMLDivElement>(null)

  const [debugProcessing, setDebugProcessing] = useState(false)

  // Single state object for the structured solution
  const [solution, setSolution] = useState<Solution | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)

  const [toastOpen, setToastOpen] = useState(false)
  const [toastMessage, setToastMessage] = useState<ToastMessage>({
    title: "",
    description: "",
    variant: "neutral"
  })

  const [isTooltipVisible, setIsTooltipVisible] = useState(false)
  const [tooltipHeight, setTooltipHeight] = useState(0)
  const [isResetting, setIsResetting] = useState(false)

  const { data: extraScreenshots = [], refetch } = useQuery<Array<{ path: string; preview: string }>, Error>(
    ["extras"],
    async () => {
      try {
        return await window.electronAPI.getScreenshots()
      } catch {
        return []
      }
    },
    { staleTime: Infinity, cacheTime: Infinity }
  )

  const showToast = (title: string, description: string, variant: ToastVariant) => {
    setToastMessage({ title, description, variant })
    setToastOpen(true)
  }

  const handleDeleteExtraScreenshot = async (index: number) => {
    const s = extraScreenshots[index]
    try {
      const resp = await window.electronAPI.deleteScreenshot(s.path)
      if (resp.success) refetch()
    } catch (error) {
      console.error("Error deleting screenshot:", error)
    }
  }

  const handleTooltipVisibilityChange = (visible: boolean, height: number) => {
    setIsTooltipVisible(visible)
    setTooltipHeight(height)
  }

  // Effect 1: ResizeObserver — re-runs when tooltip geometry changes so dimensions stay accurate.
  useEffect(() => {
    const updateDimensions = () => {
      if (contentRef.current) {
        let h = contentRef.current.scrollHeight
        const w = contentRef.current.scrollWidth
        if (isTooltipVisible) h += tooltipHeight
        window.electronAPI.updateContentDimensions({ width: w, height: h })
      }
    }
    const ro = new ResizeObserver(updateDimensions)
    if (contentRef.current) ro.observe(contentRef.current)
    updateDimensions()
    return () => ro.disconnect()
  }, [isTooltipVisible, tooltipHeight])

  // Effect 2: IPC listeners — registered exactly once on mount, cleaned up on unmount.
  // FIX (P2-5): Separated from the ResizeObserver effect so that tooltip height changes
  // do NOT cause all 8 IPC listeners to be torn down and re-registered on every resize.
  useEffect(() => {
    const cleanups = [
      window.electronAPI.onScreenshotTaken(() => refetch()),

      // Reset
      window.electronAPI.onResetView(() => {
        setIsResetting(true)
        setSolution(null)
        setIsGenerating(false)
        queryClient.removeQueries(["solution"])
        queryClient.removeQueries(["new_solution"])
        refetch()
        setTimeout(() => setIsResetting(false), 0)
      }),

      // Script generation started
      window.electronAPI.onSolutionStart(() => {
        setSolution(null)
        setIsGenerating(true)
      }),

      // Script ready
      window.electronAPI.onSolutionSuccess((data: any) => {
        setIsGenerating(false)
        if (!data?.solution) {
          console.warn("[Solutions] Received empty solution data")
          return
        }
        const s = data.solution
        const parsed: Solution = {
          problem_identifier_script: s.problem_identifier_script ?? "",
          brainstorm_script: s.brainstorm_script ?? "",
          code: s.code ?? "",
          dry_run_script: s.dry_run_script ?? "",
          time_complexity: s.time_complexity ?? "",
          space_complexity: s.space_complexity ?? "",
        }
        setSolution(parsed)
        queryClient.setQueryData(["solution"], parsed)
      }),

      // Error
      window.electronAPI.onSolutionError((error: string) => {
        setIsGenerating(false)
        showToast("Generation Failed", "Couldn't generate the interview script. Try again.", "error")
        console.error("Solution error:", error)
        const cached = queryClient.getQueryData<Solution>(["solution"])
        if (!cached) setView("queue")
        else setSolution(cached)
      }),

      // Debug events
      window.electronAPI.onDebugStart(() => setDebugProcessing(true)),
      window.electronAPI.onDebugSuccess((data: any) => {
        queryClient.setQueryData(["new_solution"], data.solution)
        setDebugProcessing(false)
      }),
      window.electronAPI.onDebugError(() => {
        showToast("Debug Failed", "There was an error debugging your code.", "error")
        setDebugProcessing(false)
      }),

      window.electronAPI.onProcessingNoScreenshots(() => {
        showToast("No Screenshots", "There are no screenshots to process.", "neutral")
      }),
    ]

    return () => cleanups.forEach(fn => fn())
  }, [])

  // Hydrate from cache on mount (e.g. navigating away & back)
  useEffect(() => {
    const cached = queryClient.getQueryData<Solution>(["solution"])
    if (cached) setSolution(cached)

    const unsub = queryClient.getQueryCache().subscribe(event => {
      if (event?.query.queryKey[0] === "solution") {
        const s = queryClient.getQueryData<Solution>(["solution"])
        if (s) setSolution(s)
      }
    })
    return () => unsub()
  }, [queryClient])

  // ── Render ────────────────────────────────────────────────────────────────

  if (!isResetting && queryClient.getQueryData(["new_solution"])) {
    return (
      <Debug
        isProcessing={debugProcessing}
        setIsProcessing={setDebugProcessing}
      />
    )
  }

  return (
    <>
      <div ref={contentRef} className="relative space-y-3 px-4 py-3">
        <Toast open={toastOpen} onOpenChange={setToastOpen} variant={toastMessage.variant} duration={3000}>
          <ToastTitle>{toastMessage.title}</ToastTitle>
          <ToastDescription>{toastMessage.description}</ToastDescription>
        </Toast>

        {/* Screenshot queue strip */}
        {solution && (
          <div className="bg-transparent w-fit pb-1">
            <ScreenshotQueue
              isLoading={debugProcessing}
              screenshots={extraScreenshots}
              onDeleteScreenshot={handleDeleteExtraScreenshot}
            />
          </div>
        )}

        {/* Action bar */}
        <SolutionCommands
          extraScreenshots={extraScreenshots}
          onTooltipVisibilityChange={handleTooltipVisibilityChange}
        />

        {/* ── Main content ────────────────────────────────────────────── */}
        <div className="w-full text-sm bg-black/50 rounded-xl overflow-hidden">
          <div className="px-4 py-4 space-y-4 max-w-full">

            {/* Loading */}
            {isGenerating && !solution && <ScriptLoader />}

            {/* 4-Phase Teleprompter */}
            {solution && (
              <div className="space-y-4">

                {/* Phase 1 — Understand */}
                <PhaseCard
                  phase={1}
                  label="Understand the Problem"
                  icon="🧠"
                  accentClass="bg-sky-900/40 text-sky-200"
                  borderClass="border-sky-700/30"
                >
                  <SpokenScript text={solution.problem_identifier_script} />
                </PhaseCard>

                {/* Phase 2 — Brainstorm */}
                <PhaseCard
                  phase={2}
                  label="Brainstorm Approaches"
                  icon="💡"
                  accentClass="bg-violet-900/40 text-violet-200"
                  borderClass="border-violet-700/30"
                >
                  <SpokenScript text={solution.brainstorm_script} />
                </PhaseCard>

                {/* Phase 3 — Implement */}
                <PhaseCard
                  phase={3}
                  label="Write the Code"
                  icon="⌨️"
                  accentClass="bg-zinc-800/60 text-zinc-200"
                  borderClass="border-zinc-600/30"
                >
                  <div className="rounded-lg overflow-hidden">
                    <SyntaxHighlighter
                      language="python"
                      style={vscDarkPlus}
                      showLineNumbers
                      customStyle={{
                        margin: 0,
                        padding: "1rem",
                        fontSize: "13px",
                        lineHeight: "1.6",
                        background: "transparent",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                      lineNumberStyle={{ color: "rgba(255,255,255,0.2)", minWidth: "2.5em", paddingRight: "1.2em" }}
                      wrapLongLines
                    >
                      {solution.code}
                    </SyntaxHighlighter>
                  </div>
                </PhaseCard>

                {/* Phase 4 — Verify */}
                <PhaseCard
                  phase={4}
                  label="Dry Run & Complexity"
                  icon="✅"
                  accentClass="bg-emerald-900/40 text-emerald-200"
                  borderClass="border-emerald-700/30"
                >
                  <SpokenScript text={solution.dry_run_script} />
                  <ComplexityRow
                    time={solution.time_complexity}
                    space={solution.space_complexity}
                  />
                </PhaseCard>

              </div>
            )}

            {/* Empty — not generating and no solution yet */}
            {!isGenerating && !solution && (
              <p className="text-center text-white/30 text-[13px] py-6">
                Take a screenshot of your problem (⌘H) and press ⌘↵ to generate the script.
              </p>
            )}

          </div>
        </div>
      </div>
    </>
  )
}

export default Solutions
