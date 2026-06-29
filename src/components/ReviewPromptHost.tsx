// src/components/ReviewPromptHost.tsx
// Reviews-prompt orchestration. Mounted once at the top level; checks the
// backend + local ledger for eligibility, then opens the ReviewModal.
//
// UX rules implemented here (mirrored from the backend so we don't open a
// flash-of-modal during slow networks):
//   * After 3 sessions OR 30 minutes of usage.
//   * "Maybe later" → 7 days or 3 more sessions.
//   * "Don't show again" → never.
//   * Already reviewed → never.
//
// The host defers the very first eligibility check by 15s after mount so the
// modal doesn't compete with startup toasts for attention.

import React, { useCallback, useEffect, useRef, useState } from "react"
import ReviewModal from "./ReviewModal"
import { isMac } from "../utils/platformUtils"

const PLATFORM = (() => {
    const p = (typeof navigator !== "undefined" ? navigator.platform : "")?.toLowerCase() || ""
    if (p.includes("mac")) return "macos" as const
    if (p.includes("win")) return "windows" as const
    if (p.includes("linux")) return "linux" as const
    return "other" as const
})()

const APP_VERSION = (() => {
    // Pull from window.electronAPI.getAppVersion if available; otherwise empty.
    try {
        return (window.electronAPI as any)?.appVersion || ""
    } catch {
        return ""
    }
})()

const FIRST_CHECK_DELAY_MS = 15_000
const SUBSEQUENT_CHECK_DELAY_MS = 60_000  // re-check every minute in case the user lingers

interface ReviewPromptHostProps {
    // Force the host to be hidden (e.g. when another modal is open). Defaults
    // to false — the host is invisible by default.
    paused?: boolean
}

const ReviewPromptHost: React.FC<ReviewPromptHostProps> = ({ paused }) => {
    const [isOpen, setIsOpen] = useState(false)
    const checkedRef = useRef(false)
    const isOpenRef = useRef(false)

    const check = useCallback(async () => {
        if (isOpenRef.current) return
        try {
            if (!window.electronAPI?.reviewGetPromptState) return
            const res = await window.electronAPI.reviewGetPromptState()
            if (!res?.ok) return
            if (res.eligible?.eligible) {
                isOpenRef.current = true
                setIsOpen(true)
                window.electronAPI?.reviewMarkShown?.()
            }
        } catch {
            /* noop */
        }
    }, [])

    useEffect(() => {
        if (paused) return
        let mounted = true
        const first = setTimeout(() => {
            if (!mounted || checkedRef.current) return
            checkedRef.current = true
            check()
        }, FIRST_CHECK_DELAY_MS)
        const interval = setInterval(() => {
            if (!mounted) return
            // Re-check periodically so a user who sits at the app eventually
            // crosses the threshold without us having to react to other events.
            check()
        }, SUBSEQUENT_CHECK_DELAY_MS)
        // Close the current usage session on unmount + page-hide. The main
        // process also flushes on before-quit, but the renderer may be torn
        // down first (Cmd+Q on macOS, devtools reload, route change). This
        // makes the session accounting race-free in either path.
        const flush = () => {
            try { window.electronAPI?.reviewFlushSession?.() } catch { /* noop */ }
        }
        window.addEventListener("pagehide", flush)
        window.addEventListener("beforeunload", flush)
        return () => {
            mounted = false
            clearTimeout(first)
            clearInterval(interval)
            window.removeEventListener("pagehide", flush)
            window.removeEventListener("beforeunload", flush)
            flush()
        }
    }, [paused, check])

    const onClose = useCallback(() => {
        isOpenRef.current = false
        setIsOpen(false)
    }, [])

    const handleDismissLater = useCallback(() => {
        void window.electronAPI?.reviewDismissLater?.()
    }, [])

    const handleDismissForever = useCallback(() => {
        void window.electronAPI?.reviewDismissForever?.()
    }, [])

    const handleSubmit = useCallback(async (payload: { rating: number; review_text: string | null }) => {
        const res = await window.electronAPI?.reviewSubmit?.(payload)
        return res || { ok: false, error: "no_api" }
    }, [])

    const handleTestimonial = useCallback(async (payload: any) => {
        const res = await window.electronAPI?.reviewUpdateTestimonial?.(payload)
        return res || { ok: false, error: "no_api" }
    }, [])

    return (
        <ReviewModal
            isOpen={isOpen}
            onClose={onClose}
            onDismissLater={handleDismissLater}
            onDismissForever={handleDismissForever}
            platform={PLATFORM}
            appVersion={APP_VERSION}
            hardwareId={undefined}
            submitReview={handleSubmit}
            updateTestimonial={handleTestimonial}
        />
    )
}

export default ReviewPromptHost