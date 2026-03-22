// Solutions.tsx
import React, { useState, useEffect, useRef } from "react"
import { useQuery, useQueryClient } from "react-query"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { dracula } from "react-syntax-highlighter/dist/esm/styles/prism"

import ScreenshotQueue from "../components/Queue/ScreenshotQueue"
import {
  Toast,
  ToastDescription,
  ToastMessage,
  ToastTitle,
  ToastVariant
} from "../components/ui/toast"
import { ProblemStatementData, Solution } from "../types/solutions"
import { AudioResult } from "../types/audio"
import SolutionCommands from "../components/Solutions/SolutionCommands"
import Debug from "./Debug"

// (Using global ElectronAPI type from src/types/electron.d.ts)

// ── Phase card for spoken scripts ─────────────────────────────────────────────

const PhaseCard = ({
  phase,
  label,
  icon,
  accentClass,
  children,
  isLoading
}: {
  phase: number
  label: string
  icon: string
  accentClass: string
  children?: React.ReactNode
  isLoading: boolean
}) => (
  <div className={`rounded-lg border ${accentClass} overflow-hidden`}>
    <div className={`flex items-center gap-2 px-3 py-2 border-b ${accentClass}`}>
      <span className="text-base">{icon}</span>
      <span className="text-[11px] font-semibold uppercase tracking-widest text-white/50">
        Phase {phase}
      </span>
      <span className="text-[11px] font-bold text-white/80 ml-1">{label}</span>
    </div>
    <div className="px-4 py-3">
      {isLoading ? (
        <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
          Drafting interview script...
        </p>
      ) : (
        children
      )}
    </div>
  </div>
)

// ── Spoken script text — what the user reads aloud ────────────────────────────

const SpokenScript = ({ text }: { text: string }) => (
  <p className="text-[14px] leading-[1.65] text-white/90 italic font-light tracking-wide">
    &ldquo;{text}&rdquo;
  </p>
)

// ── Complexity pill ───────────────────────────────────────────────────────────

const ComplexityPill = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center gap-2">
    <span className="text-[11px] font-semibold text-white/40 uppercase tracking-wider">
      {label}
    </span>
    <span className="text-[13px] font-mono text-emerald-300">{value}</span>
  </div>
)

// ── Legacy components still used for non-coding views ─────────────────────────

export const ContentSection = ({
  title,
  content,
  isLoading
}: {
  title: string
  content: React.ReactNode
  isLoading: boolean
}) => (
  <div className="space-y-2">
    <h2 className="text-[13px] font-medium text-white tracking-wide">
      {title}
    </h2>
    {isLoading ? (
      <div className="mt-4 flex">
        <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
          Extracting problem statement...
        </p>
      </div>
    ) : (
      <div className="text-[13px] leading-[1.4] text-gray-100 max-w-[600px]">
        {content}
      </div>
    )}
  </div>
)

export const ComplexitySection = ({
  timeComplexity,
  spaceComplexity,
  isLoading
}: {
  timeComplexity: string | null
  spaceComplexity: string | null
  isLoading: boolean
}) => (
  <div className="space-y-2">
    <h2 className="text-[13px] font-medium text-white tracking-wide">
      Complexity
    </h2>
    {isLoading ? (
      <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
        Calculating complexity...
      </p>
    ) : (
      <div className="space-y-1">
        <div className="flex items-start gap-2 text-[13px] leading-[1.4] text-gray-100">
          <div className="w-1 h-1 rounded-full bg-blue-400/80 mt-2 shrink-0" />
          <div>
            <strong>Time:</strong> {timeComplexity}
          </div>
        </div>
        <div className="flex items-start gap-2 text-[13px] leading-[1.4] text-gray-100">
          <div className="w-1 h-1 rounded-full bg-blue-400/80 mt-2 shrink-0" />
          <div>
            <strong>Space:</strong> {spaceComplexity}
          </div>
        </div>
      </div>
    )}
  </div>
)

// ── Main component ─────────────────────────────────────────────────────────────

interface SolutionsProps {
  setView: React.Dispatch<React.SetStateAction<"queue" | "solutions" | "debug">>
}

const Solutions: React.FC<SolutionsProps> = ({ setView }) => {
  const queryClient = useQueryClient()
  const contentRef = useRef<HTMLDivElement>(null)

  const [audioRecording, setAudioRecording] = useState(false)
  const [audioResult, setAudioResult] = useState<AudioResult | null>(null)

  const [debugProcessing, setDebugProcessing] = useState(false)
  const [problemStatementData, setProblemStatementData] =
    useState<ProblemStatementData | null>(null)

  // Single solution state using the new Solution type
  const [solutionData, setSolutionData] = useState<Solution | null>(null)

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
      } catch (error) {
        console.error("Error loading extra screenshots:", error)
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
    const screenshotToDelete = extraScreenshots[index]
    try {
      const response = await window.electronAPI.deleteScreenshot(screenshotToDelete.path)
      if (response.success) {
        refetch()
      } else {
        console.error("Failed to delete extra screenshot:", response.error)
      }
    } catch (error) {
      console.error("Error deleting extra screenshot:", error)
    }
  }

  useEffect(() => {
    const updateDimensions = () => {
      if (contentRef.current) {
        let contentHeight = contentRef.current.scrollHeight
        const contentWidth = contentRef.current.scrollWidth
        if (isTooltipVisible) contentHeight += tooltipHeight
        window.electronAPI.updateContentDimensions({ width: contentWidth, height: contentHeight })
      }
    }

    const resizeObserver = new ResizeObserver(updateDimensions)
    if (contentRef.current) resizeObserver.observe(contentRef.current)
    updateDimensions()

    const cleanupFunctions = [
      window.electronAPI.onScreenshotTaken(() => refetch()),
      window.electronAPI.onResetView(() => {
        setIsResetting(true)
        queryClient.removeQueries(["solution"])
        queryClient.removeQueries(["new_solution"])
        refetch()
        setTimeout(() => setIsResetting(false), 0)
      }),
      window.electronAPI.onSolutionStart(async () => {
        setSolutionData(null)
        setAudioResult(null)
        console.log('[Solutions] onSolutionStart: generating interview script...')
      }),
      window.electronAPI.onSolutionError((error: string) => {
        showToast("Processing Failed", "There was an error processing your screenshots.", "error")
        const cached = queryClient.getQueryData(["solution"]) as Solution | null
        if (!cached) setView("queue")
        setSolutionData(cached)
        console.error("Processing error:", error)
      }),
      window.electronAPI.onSolutionSuccess((data) => {
        if (!data?.solution) {
          console.warn("Received empty or invalid solution data")
          return
        }
        console.log({ solution: data.solution })
        const sol: Solution = {
          problem_identifier_script: data.solution.problem_identifier_script || "",
          brainstorm_script: data.solution.brainstorm_script || "",
          code: data.solution.code || "",
          dry_run_script: data.solution.dry_run_script || "",
          time_complexity: data.solution.time_complexity || "",
          space_complexity: data.solution.space_complexity || ""
        }
        queryClient.setQueryData(["solution"], sol)
        setSolutionData(sol)
      }),

      // ── Debug events ──────────────────────────────────────────────────────
      window.electronAPI.onDebugStart(() => setDebugProcessing(true)),
      window.electronAPI.onDebugSuccess((data) => {
        console.log({ debug_data: data })
        queryClient.setQueryData(["new_solution"], data.solution)
        setDebugProcessing(false)
      }),
      window.electronAPI.onDebugError(() => {
        showToast("Processing Failed", "There was an error debugging your code.", "error")
        setDebugProcessing(false)
      }),
      window.electronAPI.onProcessingNoScreenshots(() => {
        showToast("No Screenshots", "There are no extra screenshots to process.", "neutral")
      })
    ]

    return () => {
      resizeObserver.disconnect()
      cleanupFunctions.forEach((cleanup) => cleanup())
    }
  }, [isTooltipVisible, tooltipHeight])

  useEffect(() => {
    setProblemStatementData(queryClient.getQueryData(["problem_statement"]) || null)
    const cached = queryClient.getQueryData(["solution"]) as Solution | null
    if (cached) setSolutionData(cached)

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event?.query.queryKey[0] === "problem_statement") {
        setProblemStatementData(queryClient.getQueryData(["problem_statement"]) || null)
        const audioResult = queryClient.getQueryData(["audio_result"]) as AudioResult | undefined
        if (audioResult) {
          setProblemStatementData({
            problem_statement: audioResult.text,
            input_format: { description: "Generated from audio input", parameters: [] },
            output_format: { description: "Generated from audio input", type: "string", subtype: "text" },
            complexity: { time: "N/A", space: "N/A" },
            test_cases: [],
            validation_type: "manual",
            difficulty: "custom"
          })
          setSolutionData(null)
        }
      }
      if (event?.query.queryKey[0] === "solution") {
        const sol = queryClient.getQueryData(["solution"]) as Solution | null
        setSolutionData(sol)
      }
    })
    return () => unsubscribe()
  }, [queryClient])

  const handleTooltipVisibilityChange = (visible: boolean, height: number) => {
    setIsTooltipVisible(visible)
    setTooltipHeight(height)
  }

  const handleCodeHint = async () => {
    try {
      await window.electronAPI.generateCodeHint()
    } catch (err) {
      console.error('[Solutions] Code hint failed:', err)
    }
  }

  const handleBrainstorm = async () => {
    try {
      await window.electronAPI.generateBrainstorm()
    } catch (err) {
      console.error('[Solutions] Brainstorm failed:', err)
    }
  }

  // ── Is this a coding problem with our new interview script? ─────────────────
  const isCodingMode =
    problemStatementData?.validation_type === "coding" ||
    (solutionData && "problem_identifier_script" in solutionData)

  const scriptLoading = problemStatementData !== null && solutionData === null

  return (
    <>
      {!isResetting && queryClient.getQueryData(["new_solution"]) ? (
        <Debug isProcessing={debugProcessing} setIsProcessing={setDebugProcessing} />
      ) : (
        <div ref={contentRef} className="relative space-y-3 px-4 py-3">
          <Toast open={toastOpen} onOpenChange={setToastOpen} variant={toastMessage.variant} duration={3000}>
            <ToastTitle>{toastMessage.title}</ToastTitle>
            <ToastDescription>{toastMessage.description}</ToastDescription>
          </Toast>

          {/* Screenshot queue strip */}
          {solutionData && (
            <div className="bg-transparent w-fit">
              <div className="pb-3">
                <div className="space-y-3 w-fit">
                  <ScreenshotQueue
                    isLoading={debugProcessing}
                    screenshots={extraScreenshots}
                    onDeleteScreenshot={handleDeleteExtraScreenshot}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Commands bar */}
          <SolutionCommands
            extraScreenshots={extraScreenshots}
            onTooltipVisibilityChange={handleTooltipVisibilityChange}
            onCodeHint={handleCodeHint}
            onBrainstorm={handleBrainstorm}
          />

          {/* Main content */}
          <div className="w-full text-sm text-black bg-black/60 rounded-md">
            <div className="rounded-lg overflow-hidden">
              <div className="px-4 py-3 space-y-4 max-w-full">

                {/* ── Non-coding / manual result (audio, generic screenshot) ── */}
                {!isCodingMode && problemStatementData?.validation_type === "manual" ? (
                  <ContentSection
                    title={problemStatementData?.output_format?.subtype === "voice" ? "Audio Result" : "Screenshot Result"}
                    content={problemStatementData.problem_statement}
                    isLoading={false}
                  />
                ) : (
                  <>
                    {/* Problem statement header */}
                    {problemStatementData && (
                      <div className="space-y-1">
                        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-white/40">
                          Problem Detected
                        </h2>
                        <p className="text-[13px] leading-[1.5] text-gray-200 max-w-[600px] line-clamp-3">
                          {problemStatementData.problem_statement}
                        </p>
                      </div>
                    )}

                    {/* Loading state while script is generating */}
                    {problemStatementData && scriptLoading && (
                      <div className="mt-2 flex items-center gap-2">
                        <p className="text-xs bg-gradient-to-r from-indigo-300 via-purple-200 to-indigo-300 bg-clip-text text-transparent animate-pulse">
                          Drafting interview script...
                        </p>
                      </div>
                    )}

                    {/* Initial loading (no problem yet) */}
                    {!problemStatementData && (
                      <div className="mt-4 flex">
                        <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
                          Analyzing screenshot...
                        </p>
                      </div>
                    )}

                    {/* ── Rolling Interview Script ── */}
                    {solutionData && isCodingMode && (
                      <div className="space-y-3">

                        {/* Phase 1 — Understand */}
                        <PhaseCard
                          phase={1}
                          label="Understand"
                          icon="🎯"
                          accentClass="border-sky-500/30 bg-sky-950/30"
                          isLoading={false}
                        >
                          <SpokenScript text={solutionData.problem_identifier_script} />
                        </PhaseCard>

                        {/* Phase 2 — Brainstorm */}
                        <PhaseCard
                          phase={2}
                          label="Brainstorm"
                          icon="💡"
                          accentClass="border-violet-500/30 bg-violet-950/30"
                          isLoading={false}
                        >
                          <SpokenScript text={solutionData.brainstorm_script} />
                        </PhaseCard>

                        {/* Phase 3 — Implement */}
                        <PhaseCard
                          phase={3}
                          label="Implement"
                          icon="⌨️"
                          accentClass="border-amber-500/30 bg-amber-950/20"
                          isLoading={false}
                        >
                          <SyntaxHighlighter
                            showLineNumbers
                            language="python"
                            style={dracula}
                            customStyle={{
                              maxWidth: "100%",
                              margin: 0,
                              padding: "0.75rem",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-all",
                              borderRadius: "0.375rem",
                              fontSize: "12px"
                            }}
                            wrapLongLines={true}
                          >
                            {solutionData.code}
                          </SyntaxHighlighter>
                        </PhaseCard>

                        {/* Phase 4 — Verify */}
                        <PhaseCard
                          phase={4}
                          label="Verify"
                          icon="✅"
                          accentClass="border-emerald-500/30 bg-emerald-950/30"
                          isLoading={false}
                        >
                          <SpokenScript text={solutionData.dry_run_script} />
                          <div className="mt-3 flex flex-wrap gap-4 border-t border-white/10 pt-3">
                            <ComplexityPill label="Time" value={solutionData.time_complexity} />
                            <ComplexityPill label="Space" value={solutionData.space_complexity} />
                          </div>
                        </PhaseCard>

                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default Solutions
