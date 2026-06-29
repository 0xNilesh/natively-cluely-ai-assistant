// src/components/ReviewModal.tsx
// In-app review + testimonial collection modal.
//
// Two-step morph:
//   Step 1: rating + 300-char review text
//   Step 2: optional name/role/company + public-testimonial permission
//
// Polished, accessible, keyboard-navigable. Re-uses the FollowUpEmailModal
// visual idiom (dark glass + framer-motion morph) so it feels native.

import React, { useEffect, useMemo, useRef, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Star, X, Lock, ShieldCheck } from "lucide-react"
import { isMac } from "../utils/platformUtils"

const MAX_CHARS = 300

export interface ReviewModalProps {
    isOpen: boolean
    onClose: () => void
    onSubmitted?: (reviewId: string) => void
    prefillName?: string
    prefillRole?: string
    prefillCompany?: string
    hardwareId?: string
    appVersion?: string
    buildChannel?: string
    platform?: "macos" | "windows" | "linux" | "other"
    submitReview: (payload: {
        rating: number
        review_text: string | null
        app_version: string
        platform: string
        build_channel: string
        hardware_id: string | null
        email: string | null
    }) => Promise<{ ok: boolean; id?: string; error?: string }>
    updateTestimonial: (id: string, payload: {
        name: string | null
        role: string | null
        company: string | null
        can_use_publicly: boolean
        display_name_publicly: boolean
        hardware_id: string | null
    }) => Promise<{ ok: boolean; error?: string }>
}

type Step = "review" | "testimonial" | "thanks"

const ReviewModal: React.FC<ReviewModalProps> = ({
    isOpen,
    onClose,
    onSubmitted,
    prefillName = "",
    prefillRole = "",
    prefillCompany = "",
    hardwareId,
    appVersion = "",
    buildChannel = "",
    platform = "other",
    submitReview,
    updateTestimonial,
}) => {
    const [step, setStep] = useState<Step>("review")
    const [rating, setRating] = useState<number>(0)
    const [hoverRating, setHoverRating] = useState<number>(0)
    const [text, setText] = useState("")
    const [submitting, setSubmitting] = useState(false)
    const [submitError, setSubmitError] = useState<string | null>(null)

    // Testimonial state
    const [reviewId, setReviewId] = useState<string | null>(null)
    // CRITICAL FIX (audit HIGH #3): SOFT PREFILL only — prefilled values are
    // held in *separate* state, NOT copied into the live form fields. The user
    // must explicitly opt in to use each prefill via the chip button. This
    // prevents the previous behavior where a prefill was silently saved as
    // the testimonial identity.
    const [name, setName] = useState("")
    const [role, setRole] = useState("")
    const [company, setCompany] = useState("")
    // User hasn't acted on the prefill — true if the field is still empty AND
    // a prefill is available. Drives the (suggested) affordance.
    const [namePrefillUsed, setNamePrefillUsed] = useState(false)
    const [rolePrefillUsed, setRolePrefillUsed] = useState(false)
    const [companyPrefillUsed, setCompanyPrefillUsed] = useState(false)
    const [canUsePublicly, setCanUsePublicly] = useState(false)
    const [displayNamePublicly, setDisplayNamePublicly] = useState(false)
    const [testimonialBusy, setTestimonialBusy] = useState(false)
    const [testimonialError, setTestimonialError] = useState<string | null>(null)

    const textareaRef = useRef<HTMLTextAreaElement | null>(null)

    const namePrefillSuggested = !namePrefillUsed && !name && !!prefillName?.trim()
    const rolePrefillSuggested = !rolePrefillUsed && !role && !!prefillRole?.trim()
    const companyPrefillSuggested = !companyPrefillUsed && !company && !!prefillCompany?.trim()

    // Reset state when modal opens fresh.
    useEffect(() => {
        if (isOpen) {
            setStep("review")
            setRating(0)
            setHoverRating(0)
            setText("")
            setSubmitting(false)
            setSubmitError(null)
            setReviewId(null)
            setName("")
            setRole("")
            setCompany("")
            setNamePrefillUsed(false)
            setRolePrefillUsed(false)
            setCompanyPrefillUsed(false)
            setCanUsePublicly(false)
            setDisplayNamePublicly(false)
            setTestimonialBusy(false)
            setTestimonialError(null)
        }
    }, [isOpen])

    // ESC closes; only when not mid-submit.
    useEffect(() => {
        if (!isOpen) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !submitting && !testimonialBusy) onClose()
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [isOpen, submitting, testimonialBusy, onClose])

    const remaining = MAX_CHARS - text.length
    const textOver = remaining < 0
    const canSubmitReview = rating >= 1 && rating <= 5 && !textOver && !submitting

    const handleSubmitReview = async () => {
        if (!canSubmitReview) return
        setSubmitting(true)
        setSubmitError(null)
        try {
            const res = await submitReview({
                rating,
                review_text: text.trim().length > 0 ? text.trim() : null,
                app_version: appVersion,
                platform,
                build_channel: buildChannel,
                hardware_id: hardwareId || null,
                email: null,
            })
            if (!res.ok) {
                setSubmitError(res.error || "Couldn't submit. Try again.")
                setSubmitting(false)
                return
            }
            setReviewId(res.id || null)
            setStep("testimonial")
            setSubmitting(false)
            if (res.id) onSubmitted?.(res.id)
        } catch (err: any) {
            setSubmitError(err?.message || "Network error.")
            setSubmitting(false)
        }
    }

    const handleSaveTestimonial = async () => {
        if (!reviewId) return
        setTestimonialBusy(true)
        setTestimonialError(null)
        try {
            const res = await updateTestimonial(reviewId, {
                name: name.trim() || null,
                role: role.trim() || null,
                company: company.trim() || null,
                can_use_publicly: canUsePublicly,
                display_name_publicly: displayNamePublicly,
                hardware_id: hardwareId || null,
            })
            if (!res.ok) {
                setTestimonialError(res.error || "Couldn't save. Try again.")
                setTestimonialBusy(false)
                return
            }
            setTestimonialBusy(false)
            setStep("thanks")
        } catch (err: any) {
            setTestimonialError(err?.message || "Network error.")
            setTestimonialBusy(false)
        }
    }

    const handleSkipTestimonial = () => {
        setStep("thanks")
    }

    const ratingLabel = useMemo(() => {
        if (rating === 0) return "Tap a star to rate"
        if (rating === 1) return "Poor"
        if (rating === 2) return "Fair"
        if (rating === 3) return "Good"
        if (rating === 4) return "Great"
        return "Excellent"
    }, [rating])

    if (!isOpen) return null

    return (
        <AnimatePresence>
            <motion.div
                key="backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => !submitting && !testimonialBusy && onClose()}
                className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60] transition-opacity"
            />
            <motion.div
                key="container"
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                transition={{ duration: 0.3, type: "spring", damping: 25, stiffness: 300 }}
                className="fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none"
                role="dialog"
                aria-modal="true"
                aria-labelledby="review-modal-title"
            >
                <div className="w-full max-w-[520px] bg-[#121212]/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-white/[0.08] flex flex-col pointer-events-auto overflow-hidden ring-1 ring-white/5">
                    <AnimatePresence mode="wait">
                        {step === "review" && (
                            <StepReview
                                key="review"
                                rating={rating}
                                hoverRating={hoverRating}
                                setRating={setRating}
                                setHoverRating={setHoverRating}
                                text={text}
                                setText={setText}
                                remaining={remaining}
                                textOver={textOver}
                                submitting={submitting}
                                error={submitError}
                                ratingLabel={ratingLabel}
                                canSubmit={canSubmitReview}
                                onSubmit={handleSubmitReview}
                                onClose={onClose}
                                textareaRef={textareaRef}
                                isMac={isMac}
                            />
                        )}
                        {step === "testimonial" && (
                            <StepTestimonial
                                key="testimonial"
                                name={name}
                                setName={setName}
                                role={role}
                                setRole={setRole}
                                company={company}
                                setCompany={setCompany}
                                prefillName={prefillName}
                                prefillRole={prefillRole}
                                prefillCompany={prefillCompany}
                                namePrefillSuggested={namePrefillSuggested}
                                rolePrefillSuggested={rolePrefillSuggested}
                                companyPrefillSuggested={companyPrefillSuggested}
                                onAcceptNamePrefill={() => {
                                    if (prefillName) {
                                        setName(prefillName.trim())
                                        setNamePrefillUsed(true)
                                    }
                                }}
                                onAcceptRolePrefill={() => {
                                    if (prefillRole) {
                                        setRole(prefillRole.trim())
                                        setRolePrefillUsed(true)
                                    }
                                }}
                                onAcceptCompanyPrefill={() => {
                                    if (prefillCompany) {
                                        setCompany(prefillCompany.trim())
                                        setCompanyPrefillUsed(true)
                                    }
                                }}
                                canUsePublicly={canUsePublicly}
                                setCanUsePublicly={setCanUsePublicly}
                                displayNamePublicly={displayNamePublicly}
                                setDisplayNamePublicly={setDisplayNamePublicly}
                                busy={testimonialBusy}
                                error={testimonialError}
                                onSave={handleSaveTestimonial}
                                onSkip={handleSkipTestimonial}
                                onClose={onClose}
                            />
                        )}
                        {step === "thanks" && (
                            <StepThanks
                                key="thanks"
                                canUsePublicly={canUsePublicly}
                                displayNamePublicly={displayNamePublicly}
                                onClose={onClose}
                            />
                        )}
                    </AnimatePresence>
                </div>
            </motion.div>
        </AnimatePresence>
    )
}

// ─── Step 1: review ────────────────────────────────────────────────────────

interface StepReviewProps {
    rating: number
    hoverRating: number
    setRating: (n: number) => void
    setHoverRating: (n: number) => void
    text: string
    setText: (s: string) => void
    remaining: number
    textOver: boolean
    submitting: boolean
    error: string | null
    ratingLabel: string
    canSubmit: boolean
    onSubmit: () => void
    onClose: () => void
    textareaRef: React.RefObject<HTMLTextAreaElement | null>
    isMac: boolean
}

const StepReview: React.FC<StepReviewProps> = ({
    rating, hoverRating, setRating, setHoverRating,
    text, setText, remaining, textOver, submitting, error,
    ratingLabel, canSubmit, onSubmit, onClose, textareaRef,
}) => {
    return (
        <motion.div
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.2 }}
        >
            <div className="flex px-6 py-4 justify-between items-center border-b border-white/[0.06]">
                <div className="flex items-center gap-2">
                    <Star size={14} className="text-amber-400" />
                    <h2 id="review-modal-title" className="text-sm font-medium text-[#E9E9E9] tracking-wide">
                        How was your experience with Natively?
                    </h2>
                </div>
                <button
                    onClick={onClose}
                    aria-label="Close"
                    className="text-[#71717A] hover:text-white transition-colors bg-white/5 hover:bg-white/10 p-1.5 rounded-full"
                >
                    <X size={14} />
                </button>
            </div>
            <div className="px-8 pt-6 pb-2 space-y-6">
                <p className="text-[#A1A1AA] text-[13px]">Your feedback helps improve Natively.</p>

                {/* Star rating */}
                <div className="flex flex-col items-center gap-2 py-2">
                    <div
                        className="flex gap-1.5"
                        role="radiogroup"
                        aria-label="Star rating"
                    >
                        {[1, 2, 3, 4, 5].map((n) => {
                            const filled = n <= (hoverRating || rating)
                            return (
                                <button
                                    key={n}
                                    role="radio"
                                    aria-checked={rating === n}
                                    aria-label={`${n} star${n > 1 ? "s" : ""}`}
                                    onMouseEnter={() => setHoverRating(n)}
                                    onMouseLeave={() => setHoverRating(0)}
                                    onClick={() => setRating(n)}
                                    className="p-1 rounded transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                                    disabled={submitting}
                                >
                                    <Star
                                        size={32}
                                        className={filled ? "text-amber-400 fill-amber-400" : "text-[#3F3F46]"}
                                        strokeWidth={1.5}
                                    />
                                </button>
                            )
                        })}
                    </div>
                    <span className="text-[12px] text-[#71717A] h-4" aria-live="polite">{ratingLabel}</span>
                </div>

                {/* Review text */}
                <div className="space-y-1.5">
                    <label htmlFor="review-text" className="block text-[12px] font-medium text-[#A1A1AA]">
                        What stood out? <span className="text-[#52525B]">(optional)</span>
                    </label>
                    <textarea
                        id="review-text"
                        ref={textareaRef}
                        value={text}
                        onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))}
                        placeholder="Tell us what worked, what didn't, what surprised you…"
                        rows={4}
                        disabled={submitting}
                        className={`w-full bg-[#0A0A0A]/60 text-[#E9E9E9] placeholder-[#52525B] text-[13px] rounded-lg border px-3 py-2 resize-none focus:outline-none focus:ring-2 transition-colors ${
                            textOver
                                ? "border-red-500/60 focus:ring-red-400/40"
                                : "border-white/10 focus:border-white/20 focus:ring-white/10"
                        }`}
                        aria-invalid={textOver}
                        aria-describedby="review-counter"
                    />
                    <div
                        id="review-counter"
                        className={`flex justify-between text-[11px] ${textOver ? "text-red-400" : remaining <= 30 ? "text-amber-400" : "text-[#52525B]"}`}
                    >
                        <span>{textOver ? "Too long by " + Math.abs(remaining) + " characters" : " "}</span>
                        <span>{text.length} / {MAX_CHARS}</span>
                    </div>
                </div>

                {/* Error */}
                {error && (
                    <div role="alert" className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
                        {error}
                    </div>
                )}

                {/* Submit */}
                <button
                    onClick={onSubmit}
                    disabled={!canSubmit}
                    className="w-full py-2.5 rounded-lg text-[13px] font-medium transition-colors bg-amber-500 hover:bg-amber-400 disabled:bg-[#27272A] disabled:text-[#52525B] disabled:cursor-not-allowed text-black"
                >
                    {submitting ? (
                        <span className="inline-flex items-center gap-2">
                            <span className="w-3.5 h-3.5 rounded-full border-2 border-black/40 border-t-black animate-spin" />
                            Submitting…
                        </span>
                    ) : (
                        "Submit feedback"
                    )}
                </button>
            </div>
            <ModalFooter />
        </motion.div>
    )
}

// ─── Step 2: testimonial ──────────────────────────────────────────────────

interface StepTestimonialProps {
    name: string
    setName: (s: string) => void
    role: string
    setRole: (s: string) => void
    company: string
    setCompany: (s: string) => void
    prefillName?: string
    prefillRole?: string
    prefillCompany?: string
    namePrefillSuggested: boolean
    rolePrefillSuggested: boolean
    companyPrefillSuggested: boolean
    onAcceptNamePrefill: () => void
    onAcceptRolePrefill: () => void
    onAcceptCompanyPrefill: () => void
    canUsePublicly: boolean
    setCanUsePublicly: (b: boolean) => void
    displayNamePublicly: boolean
    setDisplayNamePublicly: (b: boolean) => void
    busy: boolean
    error: string | null
    onSave: () => void
    onSkip: () => void
    onClose: () => void
}

const StepTestimonial: React.FC<StepTestimonialProps> = ({
    name, setName, role, setRole, company, setCompany,
    prefillName, prefillRole, prefillCompany,
    namePrefillSuggested, rolePrefillSuggested, companyPrefillSuggested,
    onAcceptNamePrefill, onAcceptRolePrefill, onAcceptCompanyPrefill,
    canUsePublicly, setCanUsePublicly,
    displayNamePublicly, setDisplayNamePublicly,
    busy, error, onSave, onSkip, onClose,
}) => {
    return (
        <motion.div
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.25 }}
        >
            <div className="flex px-6 py-4 justify-between items-center border-b border-white/[0.06]">
                <div className="flex items-center gap-2">
                    <ShieldCheck size={14} className="text-emerald-400" />
                    <h2 id="review-modal-title" className="text-sm font-medium text-[#E9E9E9] tracking-wide">
                        Can we use this as a public testimonial?
                    </h2>
                </div>
                <button
                    onClick={onClose}
                    aria-label="Close"
                    className="text-[#71717A] hover:text-white transition-colors bg-white/5 hover:bg-white/10 p-1.5 rounded-full"
                >
                    <X size={14} />
                </button>
            </div>

            <div className="px-8 pt-6 pb-2 space-y-5">
                <p className="text-[#A1A1AA] text-[13px]">
                    Totally optional. You can stay anonymous, share just your first name, or include your full name and role.
                </p>

                <div className="space-y-3">
                    <Field
                        label="Name"
                        optional
                        placeholder="e.g. Alex Chen"
                        value={name}
                        onChange={setName}
                        maxLength={80}
                        disabled={busy}
                        suggestion={namePrefillSuggested ? prefillName : undefined}
                        onAcceptSuggestion={onAcceptNamePrefill}
                    />
                    <Field
                        label="Role / Title"
                        optional
                        placeholder="e.g. Senior Engineer"
                        value={role}
                        onChange={setRole}
                        maxLength={80}
                        disabled={busy}
                        suggestion={rolePrefillSuggested ? prefillRole : undefined}
                        onAcceptSuggestion={onAcceptRolePrefill}
                    />
                    <Field
                        label="Company"
                        optional
                        placeholder="e.g. Acme"
                        value={company}
                        onChange={setCompany}
                        maxLength={80}
                        disabled={busy}
                        suggestion={companyPrefillSuggested ? prefillCompany : undefined}
                        onAcceptSuggestion={onAcceptCompanyPrefill}
                    />
                </div>

                <div className="space-y-3 pt-2">
                    <Checkbox
                        checked={canUsePublicly}
                        onChange={setCanUsePublicly}
                        disabled={busy}
                        label="Allow Natively to use this review on the website, social posts, or marketing"
                    />
                    <Checkbox
                        checked={displayNamePublicly}
                        onChange={setDisplayNamePublicly}
                        disabled={busy || !canUsePublicly}
                        label="Show my name publicly"
                        hint={!canUsePublicly ? "Enable public use first" : (displayNamePublicly ? "Your name appears on the testimonial" : "Shown as Anonymous Natively user")}
                    />
                </div>

                {error && (
                    <div role="alert" className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
                        {error}
                    </div>
                )}

                <div className="flex gap-2 pt-1">
                    <button
                        onClick={onSave}
                        disabled={busy}
                        className="flex-1 py-2.5 rounded-lg text-[13px] font-medium transition-colors bg-emerald-500 hover:bg-emerald-400 disabled:bg-[#27272A] disabled:text-[#52525B] disabled:cursor-not-allowed text-black"
                    >
                        {busy ? "Saving…" : canUsePublicly ? "Save details" : "Save"}
                    </button>
                    <button
                        onClick={onSkip}
                        disabled={busy}
                        className="px-4 py-2.5 rounded-lg text-[13px] font-medium transition-colors bg-white/5 hover:bg-white/10 text-[#E9E9E9]"
                    >
                        Keep anonymous
                    </button>
                </div>

                <p className="text-[11px] text-[#71717A] flex items-start gap-1.5">
                    <Lock size={11} className="mt-px shrink-0" />
                    We never publish or share your review without your explicit permission. You can ask us to remove it at any time.
                </p>
            </div>
        </motion.div>
    )
}

// ─── Step 3: thanks ──────────────────────────────────────────────────────

interface StepThanksProps {
    canUsePublicly: boolean
    displayNamePublicly: boolean
    onClose: () => void
}

const StepThanks: React.FC<StepThanksProps> = ({ canUsePublicly, displayNamePublicly, onClose }) => {
    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="flex flex-col items-center text-center px-8 py-10 space-y-4"
        >
            <div className="w-14 h-14 rounded-full bg-emerald-500/20 flex items-center justify-center">
                <ShieldCheck size={28} className="text-emerald-400" />
            </div>
            <h3 className="text-lg font-medium text-[#E9E9E9]">Thank you!</h3>
            <p className="text-[13px] text-[#A1A1AA] max-w-[320px]">
                {canUsePublicly
                    ? "Your review was submitted. " + (displayNamePublicly ? "Your name will appear on the testimonial." : "It will appear as Anonymous Natively user.")
                    : "Your feedback was saved privately. We won't show it anywhere public."}
            </p>
            <button
                onClick={onClose}
                className="mt-2 px-6 py-2 rounded-lg text-[13px] font-medium bg-white/5 hover:bg-white/10 text-[#E9E9E9] transition-colors"
            >
                Close
            </button>
        </motion.div>
    )
}

// ─── Reusable bits ───────────────────────────────────────────────────────

const Field: React.FC<{
    label: string
    optional?: boolean
    placeholder?: string
    value: string
    onChange: (s: string) => void
    maxLength?: number
    disabled?: boolean
    suggestion?: string
    onAcceptSuggestion?: () => void
}> = ({ label, optional, placeholder, value, onChange, maxLength, disabled, suggestion, onAcceptSuggestion }) => (
    <div className="space-y-1">
        <label className="block text-[12px] font-medium text-[#A1A1AA]">
            {label} {optional && <span className="text-[#52525B]">(optional)</span>}
        </label>
        <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            maxLength={maxLength}
            disabled={disabled}
            className="w-full bg-[#0A0A0A]/60 text-[#E9E9E9] placeholder-[#52525B] text-[13px] rounded-lg border border-white/10 focus:border-white/20 focus:outline-none focus:ring-2 focus:ring-white/10 px-3 py-2 transition-colors"
        />
        {/* Soft-prefill (audit HIGH #3): only render the suggestion chip
            when there's an actual prefill available AND the field is still
            empty. Clicking copies the prefill into the field, otherwise it
            remains unused and is NOT persisted. */}
        {suggestion && onAcceptSuggestion && (
            <button
                type="button"
                onClick={onAcceptSuggestion}
                className="inline-flex items-center gap-1.5 text-[11px] text-[#71717A] hover:text-[#A1A1AA] bg-white/5 hover:bg-white/10 border border-white/[0.06] rounded-full px-2.5 py-1 transition-colors"
                title="Click to use this suggestion"
            >
                <span className="italic text-[#A1A1AA]">Use suggested:</span>
                <span className="truncate max-w-[180px]">{suggestion}</span>
            </button>
        )}
    </div>
)

const Checkbox: React.FC<{
    checked: boolean
    onChange: (b: boolean) => void
    label: string
    hint?: string
    disabled?: boolean
}> = ({ checked, onChange, label, hint, disabled }) => (
    <label className={`flex items-start gap-3 ${disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"} select-none`}>
        <span className={`mt-0.5 inline-flex w-4 h-4 shrink-0 rounded border ${checked ? "bg-emerald-500 border-emerald-400" : "bg-transparent border-white/20"} items-center justify-center transition-colors`}>
            {checked && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-black">
                    <polyline points="20 6 9 17 4 12" />
                </svg>
            )}
        </span>
        <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
            className="sr-only"
        />
        <span className="flex flex-col">
            <span className="text-[13px] text-[#E9E9E9]">{label}</span>
            {hint && <span className="text-[11px] text-[#71717A] mt-0.5">{hint}</span>}
        </span>
    </label>
)

const ModalFooter: React.FC = () => {
    // Used as the divider on the review step — privacy footer is rendered on
    // the testimonial step instead, since that's where the permission lives.
    return (
        <div className="px-8 py-4 mt-2 border-t border-white/[0.04]">
            <p className="text-[11px] text-[#52525B] text-center">
                Your review stays private until you give explicit permission.
            </p>
        </div>
    )
}

export default ReviewModal