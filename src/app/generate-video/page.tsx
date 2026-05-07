'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'

interface VoiceOption { label: string; gender: string }

interface CaseConfig {
  id: string
  label: string
  color: string
  photo: string | null
  photoPath: string | null
  photoBase64: string | null
  voiceId: string
  clonedVoiceId: string | null
  voiceCloneStatus: 'none' | 'uploading' | 'cloned' | 'error'
  voiceCloneFileName: string | null
}

interface ListenerConfig {
  id: string
  label: string
  color: string
  photo: string | null
  photoPath: string | null
  photoBase64: string | null
  idleVideoUrl: string
}

interface ScriptLine {
  id: string
  caseId: string
  text: string
  mode: 'text' | 'audio'
  audioFileName: string | null
  audioPcmPath: string | null
  audioDuration: number | null
  audioUploading: boolean
}

interface GenStatus {
  phase: string
  current: number
  total: number
  detail: string
  log: string[]
}

const COLORS = ['#7B83EB', '#E74856', '#00A4EF', '#FFB900', '#9B59B6']

// Extract [expressions] from script text and return clean text + expression list
function parseExpressions(raw: string): { cleanText: string; expressions: string[] } {
  const expressions: string[] = []
  const cleanText = raw.replace(/\[([^\]]+)\]/g, (_match, expr) => {
    expressions.push(expr.trim())
    return '' // remove from TTS text
  }).replace(/\s{2,}/g, ' ').trim()
  return { cleanText, expressions }
}

export default function ScenarioBuilder() {
  const [voices, setVoices] = useState<Record<string, VoiceOption>>({})
  const [cases, setCases] = useState<CaseConfig[]>([
    { id: 'p1', label: 'Case 1', color: COLORS[0], photo: null, photoPath: null, photoBase64: null, voiceId: '', clonedVoiceId: null, voiceCloneStatus: 'none', voiceCloneFileName: null },
    { id: 'p2', label: 'Case 2', color: COLORS[1], photo: null, photoPath: null, photoBase64: null, voiceId: '', clonedVoiceId: null, voiceCloneStatus: 'none', voiceCloneFileName: null },
    { id: 'p3', label: 'Case 3', color: COLORS[2], photo: null, photoPath: null, photoBase64: null, voiceId: '', clonedVoiceId: null, voiceCloneStatus: 'none', voiceCloneFileName: null },
    { id: 'p4', label: 'Case 4', color: COLORS[3], photo: null, photoPath: null, photoBase64: null, voiceId: '', clonedVoiceId: null, voiceCloneStatus: 'none', voiceCloneFileName: null },
  ])
  const [lines, setLines] = useState<ScriptLine[]>([
    { id: 'l1', caseId: 'p1', text: '', mode: 'text', audioFileName: null, audioPcmPath: null, audioDuration: null, audioUploading: false },
  ])
  const lineAudioRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const [genStatus, setGenStatus] = useState<GenStatus | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [scenarioReady, setScenarioReady] = useState(false)
  const [participantVideos, setParticipantVideos] = useState<Record<string, string>>({})
  const [participantIdleVideos, setParticipantIdleVideos] = useState<Record<string, string>>({})
  const [meetingTimeline, setMeetingTimeline] = useState<{ participantId: string; startTime: number; endTime: number }[]>([])
  const [meetingDuration, setMeetingDuration] = useState(0)
  const [launched, setLaunched] = useState(false)
  const [meetingLinks, setMeetingLinks] = useState<string[]>([])
  const [adminLink, setAdminLink] = useState<string | null>(null)
  const [listeners, setListeners] = useState<ListenerConfig[]>([])
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const voiceFileRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const listenerFileRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const [activePredictions, setActivePredictions] = useState<string[]>([])
  const cancelledRef = useRef(false)
  const [historyList, setHistoryList] = useState<{ id: string; name: string; createdAt: number; casesCount: number; duration: number }[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [swapCaseId, setSwapCaseId] = useState<string | null>(null)
  const [swapGenerating, setSwapGenerating] = useState(false)
  const [wanModel, setWanModel] = useState<'wan-2.5' | 'wan-2.7' | 'wan-2.6' | 'wan-2.2'>('wan-2.5')
  const [useLipsync, setUseLipsync] = useState(true) // Use WAN 2.7 + lipsync-2-pro pipeline (no cuts)

  // Load voices
  useEffect(() => {
    fetch('/api/generate-video').then(r => r.json()).then(d => {
      setVoices(d.voices || {})
      const keys = Object.keys(d.voices || {})
      if (keys.length >= 4) {
        setCases(prev => prev.map((c, i) => ({ ...c, voiceId: c.voiceId || keys[i] || keys[0] })))
      }
    })
  }, [])

  // Load history list
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/meeting-history')
      const data = await res.json()
      if (data.success) setHistoryList(data.meetings || [])
    } catch {}
  }, [])

  useEffect(() => { loadHistory() }, [loadHistory])

  // Save current meeting to history
  const saveToHistory = useCallback(async () => {
    try {
      await fetch('/api/meeting-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cases: cases.map(c => ({ id: c.id, label: c.label, color: c.color, photoBase64: c.photoBase64, voiceId: c.voiceId, clonedVoiceId: c.clonedVoiceId })),
          listeners: listeners.map(l => ({ id: l.id, label: l.label, color: l.color, photoBase64: l.photoBase64 })),
          script: lines.map(l => ({ id: l.id, caseId: l.caseId, text: l.text, mode: l.mode })),
          participantVideos,
          participantIdleVideos,
          timeline: meetingTimeline,
          duration: meetingDuration,
        }),
      })
      loadHistory()
    } catch {}
  }, [cases, listeners, lines, participantVideos, participantIdleVideos, meetingTimeline, meetingDuration, loadHistory])

  // Load a meeting from history
  const loadFromHistory = useCallback(async (meetingId: string) => {
    try {
      const res = await fetch(`/api/meeting-history/${meetingId}`)
      const data = await res.json()
      if (!data.success || !data.meeting) return
      const m = data.meeting
      // Restore cases with full config
      if (m.cases) {
        setCases(prev => m.cases.map((mc: any, i: number) => ({
          ...prev[i] || { id: mc.id, voiceCloneStatus: 'none' as const, voiceCloneFileName: null, photo: null, photoPath: null },
          id: mc.id, label: mc.label, color: mc.color, photoBase64: mc.photoBase64,
          voiceId: mc.voiceId || '', clonedVoiceId: mc.clonedVoiceId || null,
          photo: mc.photoBase64 ? 'loaded' : null, photoPath: mc.id,
        })))
      }
      if (m.listeners) {
        setListeners(m.listeners.map((ml: any) => ({
          id: ml.id, label: ml.label, color: ml.color, photoBase64: ml.photoBase64,
          photo: ml.photoBase64 ? 'loaded' : null, photoPath: ml.id,
          idleVideoUrl: m.participantIdleVideos?.[ml.id] || '',
        })))
      }
      if (m.script) {
        setLines(m.script.map((ms: any) => ({
          id: ms.id, caseId: ms.caseId, text: ms.text, mode: ms.mode || 'text',
          audioFileName: null, audioPcmPath: null, audioDuration: null, audioUploading: false,
        })))
      }
      if (m.participantVideos) setParticipantVideos(m.participantVideos)
      if (m.participantIdleVideos) setParticipantIdleVideos(m.participantIdleVideos)
      if (m.timeline) setMeetingTimeline(m.timeline)
      if (m.duration) setMeetingDuration(m.duration)
      if (m.participantVideos && Object.keys(m.participantVideos).length > 0) setScenarioReady(true)
      setShowHistory(false)
      setMeetingLinks([])
      setLaunched(false)
    } catch {}
  }, [])

  const handlePhoto = async (caseId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Resize client-side to max 1024px
    const preview = URL.createObjectURL(file)
    const resized = await resizeImage(file, 1024)
    // Convert to base64 data URI (stored in memory — survives redeploys)
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = reader.result as string
      setCases(prev => prev.map(c => c.id === caseId ? { ...c, photo: preview, photoBase64: base64, photoPath: caseId } : c))
    }
    reader.readAsDataURL(resized)
  }

  async function resizeImage(file: File, maxSize: number): Promise<Blob> {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        let w = img.width, h = img.height
        if (w > maxSize || h > maxSize) {
          const r = Math.min(maxSize / w, maxSize / h)
          w = Math.round(w * r); h = Math.round(h * r)
        }
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
        canvas.toBlob(blob => resolve(blob!), 'image/jpeg', 0.85)
      }
      img.src = URL.createObjectURL(file)
    })
  }

  const addLine = () => {
    setLines(prev => [...prev, { id: `l${Date.now()}`, caseId: cases[0]?.id || 'p1', text: '', mode: 'text', audioFileName: null, audioPcmPath: null, audioDuration: null, audioUploading: false }])
  }

  const removeLine = (id: string) => {
    if (lines.length <= 1) return
    setLines(prev => prev.filter(l => l.id !== id))
  }

  const updateLine = (id: string, field: 'caseId' | 'text' | 'mode', value: string) => {
    setLines(prev => prev.map(l => l.id === id ? { ...l, [field]: value } : l))
  }

  const handleLineAudioUpload = async (lineId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setLines(prev => prev.map(l => l.id === lineId ? { ...l, audioUploading: true, audioFileName: file.name } : l))

    try {
      const formData = new FormData()
      formData.append('audio', file)
      formData.append('filename', `line-${lineId}-${Date.now()}`)

      const res = await fetch('/api/upload-audio', { method: 'POST', body: formData })
      const data = await res.json()

      if (data.success) {
        setLines(prev => prev.map(l => l.id === lineId ? {
          ...l, audioUploading: false, audioPcmPath: data.pcmPath, audioDuration: data.duration,
        } : l))
        console.log(`[AUDIO] Line ${lineId}: uploaded ${file.name} → ${data.pcmPath} (${data.duration.toFixed(1)}s)`)
      } else {
        setLines(prev => prev.map(l => l.id === lineId ? { ...l, audioUploading: false, audioFileName: null } : l))
        alert(`Erreur upload audio: ${data.error}`)
      }
    } catch (err) {
      setLines(prev => prev.map(l => l.id === lineId ? { ...l, audioUploading: false, audioFileName: null } : l))
      alert(`Erreur: ${err instanceof Error ? err.message : 'inconnue'}`)
    }
  }

  const addCase = () => {
    if (cases.length >= 5) return
    const idx = cases.length
    const keys = Object.keys(voices)
    setCases(prev => [...prev, {
      id: `p${idx + 1}`, label: `Case ${idx + 1}`, color: COLORS[idx],
      photo: null, photoPath: null, photoBase64: null, voiceId: keys[idx] || keys[0] || '',
      clonedVoiceId: null, voiceCloneStatus: 'none' as const, voiceCloneFileName: null,
    }])
  }

  const removeCase = (id: string) => {
    if (cases.length <= 2) return
    setCases(prev => prev.filter(c => c.id !== id))
    setLines(prev => prev.map(l => l.caseId === id ? { ...l, caseId: cases[0].id } : l))
  }

  const LISTENER_COLORS = ['#6B7280', '#9CA3AF', '#78716C', '#A3A3A3', '#71717A', '#D4D4D8', '#94A3B8']

  const addListener = () => {
    if (listeners.length >= 7) return
    const idx = listeners.length
    setListeners(prev => [...prev, {
      id: `listener_${Date.now()}`, label: `Observateur ${idx + 1}`, color: LISTENER_COLORS[idx % LISTENER_COLORS.length],
      photo: null, photoPath: null, photoBase64: null, idleVideoUrl: '',
    }])
  }

  const removeListener = (id: string) => {
    setListeners(prev => prev.filter(l => l.id !== id))
  }

  const handleListenerPhoto = async (listenerId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const preview = URL.createObjectURL(file)
    const resized = await resizeImage(file, 1024)
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = reader.result as string
      setListeners(prev => prev.map(l => l.id === listenerId ? { ...l, photo: preview, photoBase64: base64, photoPath: listenerId } : l))
    }
    reader.readAsDataURL(resized)
  }

  const handleVoiceClone = async (caseId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const c = cases.find(cc => cc.id === caseId)
    if (!c) return

    setCases(prev => prev.map(cc => cc.id === caseId ? { ...cc, voiceCloneStatus: 'uploading', voiceCloneFileName: file.name } : cc))

    try {
      const formData = new FormData()
      formData.append('audio', file)
      formData.append('name', c.label || caseId)

      const res = await fetch('/api/clone-voice', { method: 'POST', body: formData })
      const data = await res.json()

      if (data.success && data.voiceId) {
        setCases(prev => prev.map(cc => cc.id === caseId ? {
          ...cc,
          clonedVoiceId: data.voiceId,
          voiceCloneStatus: 'cloned',
        } : cc))
        console.log(`[CLONE] ${c.label}: voice cloned → ${data.voiceId}`)
      } else {
        setCases(prev => prev.map(cc => cc.id === caseId ? { ...cc, voiceCloneStatus: 'error' } : cc))
        console.error(`[CLONE] ${c.label}: failed -`, data.error)
      }
    } catch (err) {
      setCases(prev => prev.map(cc => cc.id === caseId ? { ...cc, voiceCloneStatus: 'error' } : cc))
      console.error(`[CLONE] ${c.label}: error -`, err)
    }
  }

  const removeVoiceClone = (caseId: string) => {
    const c = cases.find(cc => cc.id === caseId)
    if (c?.clonedVoiceId) {
      fetch('/api/clone-voice', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: c.clonedVoiceId }),
      }).catch(() => {})
    }
    setCases(prev => prev.map(cc => cc.id === caseId ? { ...cc, clonedVoiceId: null, voiceCloneStatus: 'none', voiceCloneFileName: null } : cc))
  }

  // Helper: poll a prediction until done — supports both Replicate and AtlasCloud
  const pollPrediction = async (
    predictionId: string,
    filename: string,
    onProgress?: (msg: string) => void
  ): Promise<{ status: string; videoUrl?: string; replicateUrl?: string; error?: string }> => {
    setActivePredictions(prev => [...prev, predictionId])
    const MAX_POLLS = 720 // 720 × 5s = 1h max
    const checkEndpoint = '/api/check-prediction'
    try {
      for (let i = 0; i < MAX_POLLS; i++) {
        if (cancelledRef.current) {
          return { status: 'failed', error: 'Annulé par l\'utilisateur' }
        }
        await new Promise(r => setTimeout(r, 5000))
        if (cancelledRef.current) {
          return { status: 'failed', error: 'Annulé par l\'utilisateur' }
        }
        try {
          const res = await fetch(`${checkEndpoint}?id=${predictionId}&filename=${encodeURIComponent(filename)}`)
          const data = await res.json()
          if (data.status === 'succeeded') {
            return { status: 'succeeded', videoUrl: data.videoUrl, replicateUrl: data.replicateUrl }
          }
          if (data.status === 'failed') {
            return { status: 'failed', error: data.error }
          }
          if (onProgress && i % 3 === 0) {
            onProgress(`${data.status}... (${i * 5}s)`)
          }
        } catch {
          // Network hiccup — continue polling
        }
      }
      return { status: 'failed', error: 'Timeout (1h)' }
    } finally {
      setActivePredictions(prev => prev.filter(id => id !== predictionId))
    }
  }

  // Stop all running generations — cancel predictions on Replicate
  const handleStopGeneration = async () => {
    cancelledRef.current = true
    setGenStatus(prev => prev ? { ...prev, detail: 'Annulation en cours...' } : null)

    // Cancel all active predictions on Replicate
    if (activePredictions.length > 0) {
      try {
        await fetch('/api/cancel-prediction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ predictionIds: activePredictions }),
        })
      } catch {}
    }

    setActivePredictions([])
    setIsGenerating(false)
    setGenStatus(prev => prev ? { ...prev, phase: 'error', detail: 'Génération arrêtée' } : null)
  }

  // Generate everything — 3-phase continuous video approach
  const handleGenerateAll = useCallback(async () => {
    cancelledRef.current = false // reset cancellation flag
    // Validate — a line is valid if it has text (text mode) or uploaded audio (audio mode)
    const validLines = lines.filter(l => (l.mode === 'text' && l.text.trim()) || (l.mode === 'audio' && l.audioPcmPath))
    const usedCases = validLines.map(l => l.caseId).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
    const missingPhoto = usedCases.filter((cid: string) => !cases.find(c => c.id === cid)?.photoBase64)
    if (missingPhoto.length > 0) {
      setGenStatus({ phase: 'error', current: 0, total: 0, detail: `Photo manquante pour: ${missingPhoto.join(', ')}`, log: [] })
      return
    }
    if (validLines.length === 0) {
      setGenStatus({ phase: 'error', current: 0, total: 0, detail: 'Ajoute au moins une replique (texte ou audio)', log: [] })
      return
    }

    setIsGenerating(true)
    setScenarioReady(false)
    setMeetingLinks([])
    const log: string[] = []
    // Total steps: TTS per line + 1 combine + 1 video per participant
    const totalSteps = validLines.length + 1 + usedCases.length
    let currentStep = 0

    const addLog = (msg: string) => {
      log.push(msg)
      setGenStatus(prev => prev ? { ...prev, log: [...log] } : null)
    }

    // ==============================================
    // PHASE 1: Generate TTS or use uploaded audio
    // ==============================================
    setGenStatus({ phase: 'tts', current: 0, total: totalSteps, detail: 'Phase 1: Preparation audio...', log })

    const ttsSegments: { participantId: string; pcmPath: string; duration: number; index: number; expressions: string[] }[] = []
    for (let i = 0; i < validLines.length; i++) {
      const line = validLines[i]
      const c = cases.find(cc => cc.id === line.caseId)!
      currentStep++

      // Parse expressions [sourire] [colère] etc from text
      const { cleanText, expressions } = line.mode === 'text' ? parseExpressions(line.text) : { cleanText: '', expressions: [] as string[] }
      if (expressions.length > 0) {
        addLog(`[EXPR ${i + 1}] ${c.label}: expressions detectees: ${expressions.join(', ')}`)
      }

      if (line.mode === 'audio' && line.audioPcmPath && line.audioDuration) {
        // Audio already uploaded — use directly
        setGenStatus({ phase: 'tts', current: currentStep, total: totalSteps, detail: `Audio ${i + 1}/${validLines.length} (${c.label}) — fichier pre-enregistre`, log })
        addLog(`[AUDIO ${i + 1}] ${c.label}: ${line.audioFileName} (${line.audioDuration.toFixed(1)}s)`)
        ttsSegments.push({ participantId: line.caseId, pcmPath: line.audioPcmPath, duration: line.audioDuration, index: i, expressions })
      } else {
        // Text mode — generate TTS (with [expressions] stripped)
        setGenStatus({ phase: 'tts', current: currentStep, total: totalSteps, detail: `TTS ${i + 1}/${validLines.length} (${c.label})...`, log })
        addLog(`[TTS ${i + 1}] ${c.label}: "${cleanText.slice(0, 40)}..."`)

        try {
          const res = await fetch('/api/generate-tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: cleanText,
              voiceId: c.clonedVoiceId || c.voiceId,
              filename: `tts-${i + 1}-${line.caseId}-${Date.now()}.pcm`,
            }),
          })
          const data = await res.json()
          if (data.success) {
            ttsSegments.push({ participantId: line.caseId, pcmPath: data.pcmPath, duration: data.duration, index: i, expressions })
            addLog(`[TTS ${i + 1}] ${c.label}: OK (${data.duration.toFixed(1)}s)`)
          } else {
            addLog(`[TTS ${i + 1}] ${c.label}: ERREUR - ${data.error}`)
          }
        } catch (err) {
          addLog(`[TTS ${i + 1}] ${c.label}: ERREUR - ${err instanceof Error ? err.message : 'inconnue'}`)
        }
      }
    }

    if (ttsSegments.length === 0) {
      addLog(`[ERREUR] Aucun audio genere`)
      setIsGenerating(false)
      setGenStatus({ phase: 'error', current: 0, total: 0, detail: 'Aucun audio genere', log })
      return
    }

    // ==================================================
    // PHASE 2: Calculate timeline + combine audio tracks
    // ==================================================
    currentStep++
    setGenStatus({ phase: 'combine', current: currentStep, total: totalSteps, detail: 'Phase 2: Construction des pistes audio...', log })
    addLog(`[TIMELINE] Calcul du timing...`)

    const GAP = 1.5 // seconds gap between speakers
    const LEADING = 0.5 // silence at start
    const TRAILING = 1.0 // silence at end

    const timeline: { participantId: string; startTime: number; endTime: number }[] = []
    let cursor = LEADING

    for (const seg of ttsSegments) {
      const startTime = cursor
      const endTime = cursor + seg.duration
      timeline.push({ participantId: seg.participantId, startTime, endTime })
      const cLabel = cases.find(c => c.id === seg.participantId)?.label || seg.participantId
      addLog(`[TIMELINE] #${seg.index + 1} ${cLabel}: ${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s`)
      cursor = endTime + GAP
    }

    const totalMeetingDuration = cursor - GAP + TRAILING
    addLog(`[TIMELINE] Duree totale reunion: ${totalMeetingDuration.toFixed(1)}s`)

    // Build combined audio per participant
    const combineSegments = ttsSegments.map((seg, i) => ({
      participantId: seg.participantId,
      pcmPath: seg.pcmPath,
      startTime: timeline[i].startTime,
      duration: seg.duration,
    }))

    const videoResults: Record<string, string> = {}
    const idleResults: Record<string, string> = {}
    let allIdleTargets: { id: string; label: string; photoBase64: string | null }[] = []

    try {
      const combRes = await fetch('/api/combine-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantIds: usedCases,
          segments: combineSegments,
          totalDuration: totalMeetingDuration,
        }),
      })
      const combData = await combRes.json()
      if (!combData.success) {
        addLog(`[COMBINE] ERREUR: ${combData.error}`)
        setIsGenerating(false)
        setGenStatus({ phase: 'error', current: 0, total: 0, detail: 'Erreur construction audio', log })
        return
      }
      addLog(`[COMBINE] ${Object.keys(combData.audioTracks).length} pistes audio creees`)

      // ================================================
      // PHASE 3+4: Generate speaking videos + idle videos IN PARALLEL
      // Idle videos don't depend on speaking results — start them immediately
      // ================================================
      const MAX_CHUNK_SEC = wanModel === 'wan-2.5' ? 9 : 14 // WAN 2.5 video max 10s, WAN 2.7 max 15s
      const genEndpoint = '/api/generate-video'
      const BASE_VIDEO_PROMPT = 'A person speaking in a video call. Natural lip sync with the audio. Webcam framing, fixed camera, photorealistic.'
      // Build per-participant prompt enriched with their [expressions]
      const buildParticipantPrompt = (pid: string): string => {
        const participantExpressions = ttsSegments
          .filter(s => s.participantId === pid && s.expressions.length > 0)
          .flatMap(s => s.expressions)
        if (participantExpressions.length === 0) return BASE_VIDEO_PROMPT
        const exprStr = Array.from(new Set(participantExpressions)).join(', ')
        return `${BASE_VIDEO_PROMPT} During speech, the person expresses these emotions/actions: ${exprStr}.`
      }

      // --- LAUNCH IDLE GENERATION IN PARALLEL (non-blocking) ---
      const IDLE_PROMPT = 'A person in a professional video conference call, webcam framing head and shoulders, fixed camera. The person is actively listening to others speaking. Mouth fully closed at all times, no lip movement. Natural micro-movements: eye movements, subtle head tilts, slow blinks, gentle breathing, occasional nods. Continuous realistic human behavior throughout. Photorealistic quality, soft office lighting.'
      const IDLE_DURATION = 30 // single idle clip
      const IDLE_CLIPS = 1 // back to 1 clip for speed
      allIdleTargets = [
        ...usedCases.map(pid => {
          const c = cases.find(cc => cc.id === pid)!
          return { id: pid, label: c.label, photoBase64: c.photoBase64 }
        }),
        ...listeners.filter(l => l.photoBase64).map(l => ({
          id: l.id, label: l.label, photoBase64: l.photoBase64,
        })),
      ]

      addLog(`[IDLE] Lancement: ${allIdleTargets.length} personnes × ${IDLE_CLIPS} clips sequentiels (${IDLE_DURATION}s chacun)...`)

      // Generate 1 idle clip per person — all in parallel for speed
      const idlePromises = allIdleTargets.map(async (target) => {
        if (cancelledRef.current) return

        for (let retry = 0; retry < 3; retry++) {
          if (cancelledRef.current) return
          if (retry > 0) await new Promise(r => setTimeout(r, retry * 10000))

          try {
            const idleFilename = `idle-${target.id}-${Date.now()}.mp4`
            const vRes = await fetch(genEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                photoBase64: target.photoBase64,
                silent: true,
                silentDuration: wanModel === 'wan-2.5' ? 10 : (wanModel === 'wan-2.2' ? 10 : Math.min(IDLE_DURATION, 14)),
                wanModel,
                prompt: IDLE_PROMPT,
                filename: idleFilename,
              }),
            })
            const vData = await vRes.json()
            if (!vData.success || !vData.predictionId) {
              addLog(`[IDLE] ${target.label}: ERREUR - ${vData.error || 'unknown'}`)
              continue
            }

            const pollResult = await pollPrediction(vData.predictionId, idleFilename, (msg: string) => {
              addLog(`[IDLE] ${target.label}: ${msg}`)
            })
            if (pollResult.status === 'succeeded' && pollResult.videoUrl) {
              idleResults[target.id] = pollResult.videoUrl
              addLog(`[IDLE] ${target.label}: OK`)
              return
            }
            addLog(`[IDLE] ${target.label}: ERREUR - ${pollResult.error || 'echec'}`)
          } catch (err) {
            addLog(`[IDLE] ${target.label}: ERREUR - ${err instanceof Error ? err.message : 'inconnue'}`)
          }
        }
      })

      // --- PHASE 3: Generate ALL speaking videos in FULL PARALLEL ---
      // Step A: Split audio for ALL participants at once
      addLog(`[VIDEO] Decoupage audio pour ${usedCases.length} participants...`)
      setGenStatus({ phase: 'video', current: currentStep, total: totalSteps, detail: 'Phase 3: Decoupage audio...', log })

      // ========== LIPSYNC PIPELINE (no cuts) ==========
      if (useLipsync) {
        addLog(`[VIDEO] Pipeline Lipsync: WAN 2.7 + lipsync-2-pro (pas de coupure)`)
        const lipsyncResults: Record<string, string> = {}

        const lipsyncPromises = usedCases.map(async (pid) => {
          if (cancelledRef.current) return
          const c = cases.find(cc => cc.id === pid)!
          const audioB64 = combData.audioBase64?.[pid] || null
          const fname = `meeting-${pid}-${Date.now()}.mp4`

          addLog(`[VIDEO] ${c.label}: Generation lipsync en cours...`)
          setGenStatus(prev => prev ? { ...prev, detail: `Phase 3: ${c.label} — WAN 2.7 + lipsync-2-pro...` } : null)

          try {
            const res = await fetch('/api/generate-video-lipsync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                photoBase64: c.photoBase64,
                audioBase64: audioB64,
                filename: fname,
                silent: false,
              }),
            })
            const data = await res.json()
            if (data.success && data.videoUrl) {
              lipsyncResults[pid] = data.videoUrl
              addLog(`[VIDEO] ${c.label}: OK — ${data.method}`)
            } else {
              addLog(`[VIDEO] ${c.label}: ERREUR - ${data.error || 'inconnue'}`)
            }
          } catch (err) {
            addLog(`[VIDEO] ${c.label}: ERREUR - ${err instanceof Error ? err.message : 'inconnue'}`)
          }
        })

        await Promise.all(lipsyncPromises)

        // Build participant videos map
        const participantVideos_: Record<string, string> = {}
        for (const pid of usedCases) {
          if (lipsyncResults[pid]) participantVideos_[pid] = lipsyncResults[pid]
        }

        if (Object.keys(participantVideos_).length === 0) {
          addLog('[VIDEO] Aucune video generee')
          setGenStatus({ phase: 'error', current: 0, total: 1, detail: 'Aucune video', log })
          setIsGenerating(false)
          return
        }

        setParticipantVideos(participantVideos_)
        setMeetingTimeline(timeline)
        setMeetingDuration(totalMeetingDuration)
        setParticipantIdleVideos(idleResults)
        setScenarioReady(true)
        addLog(`[VIDEO] ${Object.keys(participantVideos_).length} videos lipsync generees`)

        // Skip concat — each participant has ONE continuous video
        // Go directly to saving meeting
        setGenStatus({ phase: 'done', current: 4, total: 4, detail: 'Sauvegarde...', log })

        // Build meeting data and save
        const meetingParticipants = usedCases.map(pid => {
          const c = cases.find(cc => cc.id === pid)!
          return {
            id: pid,
            name: c.label,
            role: 'speaker',
            videoUrl: participantVideos_[pid] || '',
            idleVideoUrl: idleResults[pid] || '',
            color: ['#4A90D9', '#D94A4A', '#4AD97A', '#D9A84A', '#9B4AD9'][usedCases.indexOf(pid) % 5],
          }
        })

        try {
          const historyRes = await fetch('/api/meeting-history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: `Réunion ${new Date().toLocaleDateString('fr-FR')} ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`,
              cases: cases.filter(c => usedCases.includes(c.id)).map(c => ({ id: c.id, label: c.label, color: c.color, photoBase64: c.photoBase64, voiceId: c.voiceId, clonedVoiceId: c.clonedVoiceId || null })),
              listeners: listeners.map(l => ({ id: l.id, label: l.label, color: l.color, photoBase64: l.photoBase64 })),
              script: lines.map(l => ({ id: l.id, caseId: l.caseId, text: l.text, mode: l.mode })),
              participants: meetingParticipants,
              timeline,
              duration: totalMeetingDuration,
              participantVideos: participantVideos_,
              participantIdleVideos: idleResults,
            }),
          })
          const historyData = await historyRes.json()
          if (historyData.id) {
            addLog(`[SAVE] Meeting sauvegardee: ${historyData.id}`)
          }
        } catch (err) {
          addLog(`[SAVE] Erreur sauvegarde: ${err instanceof Error ? err.message : 'inconnue'}`)
        }

        setGenStatus({ phase: 'done', current: 4, total: 4, detail: 'Termine!', log })
        setIsGenerating(false)
        return
      }

      // ========== LEGACY CHUNK PIPELINE (splits + concat) ==========
      type ChunkJob = {
        pid: string; label: string; chunkIndex: number; totalChunks: number;
        audioB64: string | null; audioPath: string; photoBase64: string | null;
        prompt: string; filename: string;
      }
      const allJobs: ChunkJob[] = []
      const participantChunkCounts: Record<string, number> = {}

      for (const pid of usedCases) {
        const c = cases.find(cc => cc.id === pid)!
        const VIDEO_PROMPT = buildParticipantPrompt(pid)
        const audioTrack = combData.audioTracks[pid]
        const audioB64 = combData.audioBase64?.[pid] || null

        if (totalMeetingDuration > MAX_CHUNK_SEC) {
          try {
            const splitRes = await fetch('/api/split-audio', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ wavPath: audioTrack, wavBase64: audioB64, maxChunkSeconds: MAX_CHUNK_SEC }),
            })
            const splitData = await splitRes.json()
            if (!splitData.success) {
              addLog(`[VIDEO] ${c.label}: ERREUR split - ${splitData.error}`)
              continue
            }
            const chunks = splitData.chunks as { wavPath: string; duration: number; audioBase64?: string }[]
            participantChunkCounts[pid] = chunks.length
            addLog(`[VIDEO] ${c.label}: ${chunks.length} chunks`)
            for (let ci = 0; ci < chunks.length; ci++) {
              allJobs.push({
                pid, label: c.label, chunkIndex: ci, totalChunks: chunks.length,
                audioB64: chunks[ci].audioBase64 || null, audioPath: chunks[ci].wavPath,
                photoBase64: c.photoBase64, prompt: VIDEO_PROMPT,
                filename: `chunk-${pid}-${ci}-${Date.now()}.mp4`,
              })
            }
          } catch (err) {
            addLog(`[VIDEO] ${c.label}: ERREUR split - ${err instanceof Error ? err.message : 'inconnue'}`)
          }
        } else {
          participantChunkCounts[pid] = 1
          allJobs.push({
            pid, label: c.label, chunkIndex: 0, totalChunks: 1,
            audioB64, audioPath: audioTrack, photoBase64: c.photoBase64,
            prompt: VIDEO_PROMPT, filename: `meeting-${pid}-${Date.now()}.mp4`,
          })
        }
      }

      const totalJobs = allJobs.length
      addLog(`[VIDEO] ${totalJobs} videos a generer en parallele...`)

      // Step B: Generate ALL chunks in FULL PARALLEL (fast)
      let completedJobs = 0
      const jobResults: Record<string, { videoUrl: string; replicateUrl: string; chunkIndex: number }[]> = {}
      for (const pid of usedCases) jobResults[pid] = []

      const generateOneChunk = async (job: ChunkJob): Promise<{ videoUrl: string; replicateUrl: string } | null> => {
        const MAX_RETRIES = 3
        for (let retry = 0; retry < MAX_RETRIES; retry++) {
          if (cancelledRef.current) return null
          if (retry > 0) {
            const wait = retry * 15
            addLog(`[VIDEO] ${job.label}: chunk ${job.chunkIndex + 1} retry ${retry}/${MAX_RETRIES} dans ${wait}s...`)
            await new Promise(r => setTimeout(r, wait * 1000))
          }

          try {
            const vRes = await fetch(genEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                audioBase64: job.audioB64,
                audioPath: job.audioPath,
                photoBase64: job.photoBase64,
                prompt: job.prompt,
                filename: job.filename,
                wanModel,
              }),
            })
            const vData = await vRes.json()
            if (!vData.success || !vData.predictionId) {
              const errMsg = vData.error || 'unknown'
              addLog(`[VIDEO] ${job.label}: chunk ${job.chunkIndex + 1} ERREUR - ${errMsg}`)
              if (errMsg.includes('temporarily') || errMsg.includes('503') || errMsg.includes('E004') || errMsg.includes('E003') || errMsg.includes('unavailable') || errMsg.includes('high demand')) continue
              return null
            }

            const pollResult = await pollPrediction(vData.predictionId, job.filename, (msg: string) => {
              setGenStatus(prev => prev ? { ...prev, detail: `Phase 3: ${completedJobs}/${totalJobs} OK — ${job.label} chunk ${job.chunkIndex + 1}: ${msg}` } : null)
            })
            if (pollResult.status === 'succeeded' && pollResult.videoUrl) {
              completedJobs++
              addLog(`[VIDEO] ${job.label}: chunk ${job.chunkIndex + 1} OK (${completedJobs}/${totalJobs})`)
              setGenStatus(prev => prev ? { ...prev, detail: `Phase 3: ${completedJobs}/${totalJobs} videos generees...` } : null)
              return { videoUrl: pollResult.videoUrl, replicateUrl: pollResult.replicateUrl || '' }
            }
            const errMsg = pollResult.error || 'echec'
            addLog(`[VIDEO] ${job.label}: chunk ${job.chunkIndex + 1} ERREUR - ${errMsg}`)
            if (errMsg.includes('temporarily') || errMsg.includes('503') || errMsg.includes('E004') || errMsg.includes('E003') || errMsg.includes('unavailable') || errMsg.includes('high demand')) continue
            return null
          } catch (err) {
            addLog(`[VIDEO] ${job.label}: chunk ${job.chunkIndex + 1} ERREUR - ${err instanceof Error ? err.message : 'inconnue'}`)
          }
        }
        return null
      }

      // ALL chunks in parallel — maximum speed
      const chunkPromises = allJobs.map(async (job) => {
        const result = await generateOneChunk(job)
        if (result) {
          jobResults[job.pid].push({ ...result, chunkIndex: job.chunkIndex })
        }
      })
      await Promise.all(chunkPromises)
      addLog(`[VIDEO] ${completedJobs}/${totalJobs} chunks generes`)

      // Step C: Concat chunks per participant (parallel)
      const concatPromises = usedCases.map(async (pid) => {
        const c = cases.find(cc => cc.id === pid)!
        const results = jobResults[pid].sort((a, b) => a.chunkIndex - b.chunkIndex)
        if (results.length === 0) {
          addLog(`[VIDEO] ${c.label}: aucun chunk reussi`)
          return
        }

        if (results.length === 1 || participantChunkCounts[pid] === 1) {
          videoResults[pid] = results[0].videoUrl
          return
        }

        // Need to concat
        addLog(`[VIDEO] ${c.label}: concatenation ${results.length} chunks...`)
        try {
          const concatRes = await fetch('/api/concat-videos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              videoPaths: results.map(r => r.videoUrl),
              remoteUrls: results.map(r => r.replicateUrl),
              outputFilename: `meeting-${pid}-${Date.now()}.mp4`,
            }),
          })
          const concatData = await concatRes.json()
          if (concatData.success) {
            videoResults[pid] = concatData.videoUrl
            addLog(`[VIDEO] ${c.label}: concat OK (${(concatData.size / 1024 / 1024).toFixed(1)} MB)`)
          } else {
            addLog(`[VIDEO] ${c.label}: ERREUR concat — utilisation du 1er chunk`)
            videoResults[pid] = results[0].videoUrl
          }
        } catch (err) {
          addLog(`[VIDEO] ${c.label}: ERREUR concat — utilisation du 1er chunk`)
          videoResults[pid] = results[0].videoUrl
        }
      })
      await Promise.all(concatPromises)

      // ALWAYS save talking video results — even if later steps fail
      setParticipantVideos(videoResults)
      setMeetingTimeline(timeline)
      setMeetingDuration(totalMeetingDuration)

      const totalGenerated = Object.keys(videoResults).length
      addLog(`[OK] ${totalGenerated} videos continues generees (${totalMeetingDuration.toFixed(1)}s chacune)`)

      // If we have at least 1 video, mark as ready NOW (before idle finishes)
      if (totalGenerated > 0) {
        setScenarioReady(true)
      }

      // ================================================
      // Wait for idle videos (launched in parallel with PHASE 3)
      // ================================================
      try {
        addLog(`[IDLE] Attente des videos d'ecoute en parallele...`)
        setGenStatus({ phase: 'idle', current: currentStep, total: totalSteps, detail: 'Finalisation videos ecoute...', log })
        await Promise.all(idlePromises)

        // Store idle results: update participant idle videos + observer idle videos
        setParticipantIdleVideos(idleResults)
        setListeners(prev => prev.map(l => idleResults[l.id] ? { ...l, idleVideoUrl: idleResults[l.id] } : l))
        addLog(`[IDLE] ${Object.keys(idleResults).length}/${allIdleTargets.length} videos idle generees`)
      } catch (idleErr) {
        addLog(`[IDLE] ERREUR (non bloquante): ${idleErr instanceof Error ? idleErr.message : 'inconnue'}`)
      }

      setIsGenerating(false)
      setGenStatus({ phase: 'done', current: totalSteps, total: totalSteps, detail: `Pret ! ${totalGenerated} videos + ${Object.keys(idleResults).length} idle`, log })

      // Auto-save to history
      try {
        await fetch('/api/meeting-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cases: cases.map(c => ({ id: c.id, label: c.label, color: c.color, photoBase64: c.photoBase64, voiceId: c.voiceId, clonedVoiceId: c.clonedVoiceId })),
            listeners: listeners.map(l => ({ id: l.id, label: l.label, color: l.color, photoBase64: l.photoBase64 })),
            script: lines.map(l => ({ id: l.id, caseId: l.caseId, text: l.text, mode: l.mode })),
            participantVideos: videoResults,
            participantIdleVideos: idleResults,
            timeline,
            duration: totalMeetingDuration,
          }),
        })
        loadHistory()
        addLog(`[HISTORY] Reunion sauvegardee dans l'historique`)
      } catch {}
    } catch (err) {
      // CRITICAL: Save whatever we have even on error
      if (Object.keys(videoResults).length > 0) {
        setParticipantVideos(videoResults)
        setScenarioReady(true)
        addLog(`[ERREUR] ${err instanceof Error ? err.message : 'inconnue'} — ${Object.keys(videoResults).length} videos sauvees malgre l'erreur`)
      } else {
        addLog(`[ERREUR] ${err instanceof Error ? err.message : 'inconnue'}`)
      }
      setIsGenerating(false)
      const saved = Object.keys(videoResults).length
      setGenStatus({ phase: saved > 0 ? 'done' : 'error', current: currentStep, total: totalSteps, detail: saved > 0 ? `${saved} videos sauvees (erreur partielle)` : 'Erreur construction audio', log })
    }
  }, [cases, lines, listeners])

  // Swap: re-generate only ONE participant's video, keep all others
  const handleSwapCase = useCallback(async (caseId: string) => {
    const c = cases.find(cc => cc.id === caseId)
    if (!c) return
    setSwapGenerating(true)
    setSwapCaseId(null)
    const log: string[] = []
    const addLog = (msg: string) => { log.push(msg); setGenStatus({ phase: 'video', current: 0, total: 1, detail: msg, log }) }

    try {
      addLog(`[SWAP] Re-generation de ${c.label}...`)

      // Step 1: Re-build TTS for this participant
      const participantLines = lines.filter(l => l.caseId === caseId)
      if (participantLines.length === 0) {
        addLog(`[SWAP] Aucune replique pour ${c.label}`)
        setSwapGenerating(false)
        return
      }

      // Step 2: Generate TTS + combine audio for this participant
      const ttsSegments: { participantId: string; pcmPath: string; duration: number; expressions: string[] }[] = []
      for (const line of participantLines) {
        if (line.mode === 'audio' && line.audioPcmPath) {
          ttsSegments.push({ participantId: caseId, pcmPath: line.audioPcmPath, duration: line.audioDuration || 0, expressions: [] })
          continue
        }
        const { cleanText, expressions } = parseExpressions(line.text)
        if (!cleanText) continue
        const voiceId = c.clonedVoiceId || c.voiceId
        addLog(`[SWAP] TTS: ${cleanText.slice(0, 40)}...`)
        const ttsRes = await fetch('/api/generate-tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: cleanText, voiceId }),
        })
        const ttsData = await ttsRes.json()
        if (ttsData.success) {
          ttsSegments.push({ participantId: caseId, pcmPath: ttsData.pcmPath, duration: ttsData.duration, expressions })
        }
      }

      // Step 3: Combine audio for this participant
      addLog(`[SWAP] Construction piste audio...`)
      const timeline = meetingTimeline.filter(t => t.participantId === caseId)
      const combRes = await fetch('/api/combine-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ttsSegments: ttsSegments.map(s => ({ participantId: s.participantId, pcmPath: s.pcmPath, duration: s.duration })),
          timeline,
          totalDuration: meetingDuration,
          participantIds: [caseId],
        }),
      })
      const combData = await combRes.json()
      if (!combData.success) {
        addLog(`[SWAP] ERREUR combine audio: ${combData.error}`)
        setSwapGenerating(false)
        return
      }

      const audioTrack = combData.audioTracks[caseId]
      const audioB64 = combData.audioBase64?.[caseId] || null

      // Step 4: Split audio + generate video chunks sequentially
      const MAX_CHUNK_SEC = wanModel === 'wan-2.5' ? 9 : 14 // WAN 2.5 max 10s video, WAN 2.7 max 15s
      const VIDEO_PROMPT = (() => {
        const BASE = 'A person in a professional video conference call, webcam framing head and shoulders, fixed camera. When audio plays, the person speaks with natural lip sync. When audio is silent, the person is actively listening: mouth fully closed, natural eye movements, subtle head tilts, slow blinks, gentle breathing, occasional nods. The person never stops moving naturally — continuous realistic human micro-movements throughout. Photorealistic quality, soft office lighting.'
        const exprs = ttsSegments.flatMap(s => s.expressions).filter(Boolean)
        if (exprs.length === 0) return BASE
        return `${BASE} During speech, the person expresses these emotions/actions: ${Array.from(new Set(exprs)).join(', ')}.`
      })()
      const CONT_SUFFIX = ' CRITICAL: This is a continuation of the same video. The person MUST start in the EXACT same position, pose, head angle, and expression as shown in the reference image. No sudden movement, no position reset, no initial adjustment. Seamless continuation from the previous moment.'

      let chunks: { wavPath: string; duration: number; audioBase64?: string }[] = []
      if (meetingDuration > MAX_CHUNK_SEC) {
        const splitRes = await fetch('/api/split-audio', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wavPath: audioTrack, wavBase64: audioB64, maxChunkSeconds: MAX_CHUNK_SEC }),
        })
        const splitData = await splitRes.json()
        if (splitData.success) chunks = splitData.chunks
      }
      if (chunks.length === 0) {
        chunks = [{ wavPath: audioTrack, duration: meetingDuration, audioBase64: audioB64 || undefined }]
      }

      addLog(`[SWAP] ${chunks.length} chunks a generer sequentiellement...`)
      const chunkResults: { videoUrl: string; replicateUrl: string }[] = []
      let currentPhoto = c.photoBase64

      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci]
        const prompt = ci > 0 ? VIDEO_PROMPT + CONT_SUFFIX : VIDEO_PROMPT
        const filename = `swap-${caseId}-${ci}-${Date.now()}.mp4`

        addLog(`[SWAP] ${c.label} chunk ${ci + 1}/${chunks.length}...`)
        const vRes = await fetch('/api/generate-video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audioBase64: chunk.audioBase64 || null,
            audioPath: chunk.wavPath,
            photoBase64: currentPhoto,
            prompt,
            filename,
          }),
        })
        const vData = await vRes.json()
        if (!vData.success || !vData.predictionId) {
          addLog(`[SWAP] ERREUR chunk ${ci + 1}: ${vData.error || 'unknown'}`)
          continue
        }

        const pollResult = await pollPrediction(vData.predictionId, filename, (msg: string) => {
          addLog(`[SWAP] ${c.label} chunk ${ci + 1}: ${msg}`)
        })
        if (pollResult.status === 'succeeded' && pollResult.videoUrl) {
          chunkResults.push({ videoUrl: pollResult.videoUrl, replicateUrl: pollResult.replicateUrl || '' })
          addLog(`[SWAP] ${c.label} chunk ${ci + 1}/${chunks.length} OK`)

          // Extract last frame for next chunk
          if (ci < chunks.length - 1) {
            try {
              const frameRes = await fetch('/api/extract-frame', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoUrl: pollResult.videoUrl, remoteUrl: pollResult.replicateUrl }),
              })
              const frameData = await frameRes.json()
              if (frameData.success && frameData.frameBase64) {
                currentPhoto = frameData.frameBase64
              }
            } catch {}
          }
        }
      }

      // Step 5: Concat if multiple chunks
      let finalVideoUrl = ''
      if (chunkResults.length > 1) {
        const concatRes = await fetch('/api/concat-videos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoPaths: chunkResults.map(r => r.videoUrl),
            remoteUrls: chunkResults.map(r => r.replicateUrl),
            outputFilename: `swap-${caseId}-${Date.now()}.mp4`,
          }),
        })
        const concatData = await concatRes.json()
        finalVideoUrl = concatData.success ? concatData.videoUrl : chunkResults[0]?.videoUrl || ''
      } else {
        finalVideoUrl = chunkResults[0]?.videoUrl || ''
      }

      if (finalVideoUrl) {
        setParticipantVideos(prev => ({ ...prev, [caseId]: finalVideoUrl }))
        addLog(`[SWAP] ${c.label} re-generee avec succes !`)
        setGenStatus({ phase: 'done', current: 1, total: 1, detail: `${c.label} swappee !`, log })
        // Auto-save updated meeting
        saveToHistory()
      } else {
        addLog(`[SWAP] ERREUR: aucun chunk reussi`)
        setGenStatus({ phase: 'error', current: 0, total: 1, detail: 'Swap echoue', log })
      }
    } catch (err) {
      addLog(`[SWAP] ERREUR: ${err instanceof Error ? err.message : 'inconnue'}`)
      setGenStatus({ phase: 'error', current: 0, total: 1, detail: 'Swap echoue', log })
    }
    setSwapGenerating(false)
  }, [cases, lines, meetingTimeline, meetingDuration, participantVideos, pollPrediction, saveToHistory])

  // Launch — create meeting room with continuous videos + timeline
  const launchInMeeting = async () => {
    if (Object.keys(participantVideos).length === 0) {
      console.warn('No videos to launch')
      return
    }
    try {
      const speakerList = Object.keys(participantVideos).map(pid => {
        const c = cases.find(cc => cc.id === pid)
        return {
          id: pid,
          name: c?.label || pid,
          color: c?.color || '#5b5fc7',
          videoUrl: participantVideos[pid],
          idleVideoUrl: participantIdleVideos[pid] || undefined,
          role: 'speaker' as const,
        }
      })
      const listenerList = listeners.filter(l => l.photoBase64).map(l => ({
        id: l.id,
        name: l.label,
        color: l.color,
        videoUrl: '',
        idleVideoUrl: l.idleVideoUrl || participantIdleVideos[l.id] || '',
        role: 'listener' as const,
      }))
      // Interleave speakers and listeners so tiles alternate in the grid
      // (looks like a real meeting — you look around, not just one zone)
      const participantList: Array<{ id: string; name: string; color: string; videoUrl: string; idleVideoUrl?: string; role: 'speaker' | 'listener' }> = []
      const s = [...speakerList]
      const l = [...listenerList]
      while (s.length > 0 || l.length > 0) {
        if (s.length > 0) participantList.push(s.shift()!)
        if (l.length > 0) participantList.push(l.shift()!)
      }

      const res = await fetch('/api/meeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'ACQ MEETING',
          participants: participantList,
          timeline: meetingTimeline,
          totalDuration: meetingDuration,
        }),
      })
      const data = await res.json()
      if (data.success && data.meetingId) {
        // Generate 5 single-use session links from the template
        const bulkRes = await fetch('/api/meeting', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: data.meetingId, action: 'bulkClone', count: 5 }),
        })
        const bulkData = await bulkRes.json()
        if (bulkData.success && bulkData.sessionIds) {
          const links = bulkData.sessionIds.map((sid: string) => `${window.location.origin}/meeting/${sid}`)
          setMeetingLinks(links)
          setGenStatus(prev => prev ? { ...prev, detail: `${links.length} liens single-use generes !` } : null)
        } else {
          // Fallback: use template link directly
          setMeetingLinks([`${window.location.origin}/meeting/${data.meetingId}`])
        }
      } else {
        console.error('Failed to create meeting:', data.error)
      }
    } catch (err) {
      console.error('Launch failed:', err)
    }
  }

  const usedCaseIds = lines.map(l => l.caseId).filter((v, i, a) => a.indexOf(v) === i)
  const progress = genStatus ? Math.round((genStatus.current / Math.max(genStatus.total, 1)) * 100) : 0

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: 'white', fontFamily: 'system-ui, sans-serif' }}>
      {/* Header */}
      <div style={{ background: '#111', borderBottom: '1px solid #333', padding: '10px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 17, fontWeight: 700 }}>Scenario Builder</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {launched && <span style={{ fontSize: 11, color: '#4ade80', fontWeight: 600 }}>● Reunion en cours</span>}
          <select
            value={wanModel}
            onChange={e => setWanModel(e.target.value as 'wan-2.5' | 'wan-2.7' | 'wan-2.6' | 'wan-2.2')}
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #444', background: '#1a1a1a', color: wanModel === 'wan-2.5' ? '#4ade80' : '#f59e0b', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
          >
            <option value="wan-2.5">WAN 2.5 (recommande - lip-sync)</option>
            <option value="wan-2.7">WAN 2.7</option>
            <option value="wan-2.6">WAN 2.6</option>
            <option value="wan-2.2">WAN 2.2 (ancien)</option>
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 10, fontWeight: 700, color: useLipsync ? '#4ade80' : '#888' }}>
            <input type="checkbox" checked={useLipsync} onChange={e => setUseLipsync(e.target.checked)} style={{ accentColor: '#4ade80' }} />
            Lipsync Pro (pas de coupure)
          </label>
          <button onClick={() => { setShowHistory(!showHistory); if (!showHistory) loadHistory() }} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #444', background: showHistory ? '#2a2a4a' : 'none', color: '#a5b4fc', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
            Historique ({historyList.length})
          </button>
          <a href="/" style={{ color: '#818cf8', fontSize: 12, textDecoration: 'none' }}>Aller a la reunion</a>
        </div>
      </div>

      {/* History panel */}
      {showHistory && (
        <div style={{ background: '#151525', borderBottom: '1px solid #333', padding: '12px 20px', maxHeight: 250, overflowY: 'auto' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#a5b4fc', marginBottom: 8 }}>Historique des reunions</div>
          {historyList.length === 0 ? (
            <div style={{ color: '#555', fontSize: 11 }}>Aucune reunion sauvegardee</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {historyList.map(h => (
                <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#1a1a2e', borderRadius: 8, padding: '8px 12px' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e0e7ff' }}>{h.name}</div>
                    <div style={{ fontSize: 10, color: '#666' }}>{h.casesCount} participants · {h.duration.toFixed(0)}s · {new Date(h.createdAt).toLocaleString('fr-FR')}</div>
                  </div>
                  <button onClick={() => loadFromHistory(h.id)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: '#6366f1', color: 'white', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
                    Charger
                  </button>
                  <button onClick={async () => { await fetch('/api/meeting-history', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: h.id }) }); loadHistory() }} style={{ padding: '4px 8px', borderRadius: 6, border: 'none', background: '#333', color: '#f87171', fontSize: 10, cursor: 'pointer' }}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', height: 'calc(100vh - 45px)' }}>
        {/* Left: Cases config */}
        <div style={{ width: 280, background: '#111', borderRight: '1px solid #2a2a2a', padding: 14, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#a5b4fc' }}>Participants</div>
            {cases.length < 5 && (
              <button onClick={addCase} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, border: '1px solid #444', background: 'none', color: '#888', cursor: 'pointer' }}>+ Ajouter</button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {cases.map(c => (
              <div key={c.id} style={{ background: '#1a1a1a', borderRadius: 8, padding: 10, border: `1px solid ${usedCaseIds.includes(c.id) ? c.color + '66' : '#2a2a2a'}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: c.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                    {c.id.replace('p', '')}
                  </div>
                  <input
                    value={c.label}
                    onChange={e => setCases(prev => prev.map(cc => cc.id === c.id ? { ...cc, label: e.target.value } : cc))}
                    style={{ flex: 1, background: 'none', border: 'none', color: 'white', fontSize: 12, fontWeight: 600, outline: 'none' }}
                  />
                  {cases.length > 2 && (
                    <button onClick={() => removeCase(c.id)} style={{ fontSize: 10, color: '#666', background: 'none', border: 'none', cursor: 'pointer' }}>X</button>
                  )}
                </div>

                {/* Photo */}
                <div
                  onClick={() => fileRefs.current[c.id]?.click()}
                  style={{
                    width: '100%', height: 80, borderRadius: 6, border: '1px dashed #444',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', overflow: 'hidden', background: '#151515', marginBottom: 8,
                  }}
                >
                  {c.photo ? (
                    <img src={c.photo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <span style={{ fontSize: 10, color: '#555' }}>Cliquer = upload photo</span>
                  )}
                </div>
                <input ref={el => { fileRefs.current[c.id] = el }} type="file" accept="image/*" style={{ display: 'none' }}
                  onChange={e => handlePhoto(c.id, e)} />

                {/* Voice clone */}
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 9, color: '#888', marginBottom: 4, fontWeight: 600 }}>Voix clonee (audio sample) :</div>
                  {c.voiceCloneStatus === 'cloned' ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: '#064e3b', borderRadius: 4, border: '1px solid #10b981' }}>
                      <span style={{ fontSize: 10, color: '#4ade80', flex: 1 }}>✓ {c.voiceCloneFileName}</span>
                      <button onClick={() => removeVoiceClone(c.id)} style={{ fontSize: 9, color: '#f87171', background: 'none', border: 'none', cursor: 'pointer' }}>X</button>
                    </div>
                  ) : c.voiceCloneStatus === 'uploading' ? (
                    <div style={{ fontSize: 10, color: '#fbbf24', padding: '4px 8px', background: '#1a1a1a', borderRadius: 4 }}>Clonage en cours...</div>
                  ) : (
                    <div
                      onClick={() => voiceFileRefs.current[c.id]?.click()}
                      style={{
                        padding: '6px 8px', borderRadius: 4, border: '1px dashed #6366f1', background: '#1a1a2e',
                        cursor: 'pointer', fontSize: 10, color: '#a5b4fc', textAlign: 'center',
                      }}
                    >
                      {c.voiceCloneStatus === 'error' ? '⚠ Erreur — re-essayer' : 'Uploader un audio pour cloner'}
                    </div>
                  )}
                  <input ref={el => { voiceFileRefs.current[c.id] = el }} type="file" accept="audio/*" style={{ display: 'none' }}
                    onChange={e => handleVoiceClone(c.id, e)} />
                </div>

                {/* Pre-made voice fallback */}
                {!c.clonedVoiceId && (
                  <div>
                    <div style={{ fontSize: 9, color: '#888', marginBottom: 4 }}>Ou voix pre-faite :</div>
                    <select
                      value={c.voiceId}
                      onChange={e => setCases(prev => prev.map(cc => cc.id === c.id ? { ...cc, voiceId: e.target.value } : cc))}
                      style={{ width: '100%', padding: '4px 6px', background: '#151515', border: '1px solid #333', borderRadius: 4, color: 'white', fontSize: 10 }}
                    >
                      {Object.entries(voices).map(([id, v]) => <option key={id} value={id}>{v.label}</option>)}
                    </select>
                  </div>
                )}

                {/* Swap / Re-generate this case only */}
                {scenarioReady && participantVideos[c.id] && !isGenerating && (
                  <div style={{ marginTop: 8, borderTop: '1px solid #2a2a2a', paddingTop: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80' }} />
                      <span style={{ fontSize: 9, color: '#4ade80', fontWeight: 600 }}>Video generee</span>
                    </div>
                    <button
                      onClick={() => setSwapCaseId(swapCaseId === c.id ? null : c.id)}
                      disabled={swapGenerating}
                      style={{
                        marginTop: 4, width: '100%', padding: '6px', borderRadius: 4,
                        border: swapCaseId === c.id ? '1px solid #f59e0b' : '1px solid #444',
                        background: swapCaseId === c.id ? '#1a1a0a' : 'none',
                        color: swapCaseId === c.id ? '#f59e0b' : '#888', fontSize: 9, cursor: 'pointer', fontWeight: 600,
                      }}
                    >
                      {swapCaseId === c.id ? '↩ Annuler swap' : '🔄 Changer cette case'}
                    </button>
                    {swapCaseId === c.id && (
                      <div style={{ marginTop: 6, fontSize: 9, color: '#f59e0b', lineHeight: 1.4 }}>
                        Modifie la photo, voix ou texte de cette case puis clique ci-dessous.
                        Seule cette case sera re-generee — les autres videos restent.
                        <button
                          onClick={() => handleSwapCase(c.id)}
                          disabled={swapGenerating}
                          style={{
                            marginTop: 6, width: '100%', padding: '8px', borderRadius: 6,
                            border: 'none', fontSize: 11, fontWeight: 700, cursor: swapGenerating ? 'wait' : 'pointer',
                            background: swapGenerating ? '#333' : 'linear-gradient(135deg, #f59e0b, #d97706)', color: 'white',
                          }}
                        >
                          {swapGenerating ? 'Re-generation en cours...' : 'Re-generer cette case'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Listeners (silent observers) */}
          <div style={{ marginTop: 16, borderTop: '1px solid #2a2a2a', paddingTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af' }}>Observateurs ({listeners.length}/7)</div>
              {listeners.length < 7 && (
                <button onClick={addListener} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, border: '1px solid #444', background: 'none', color: '#888', cursor: 'pointer' }}>+ Ajouter</button>
              )}
            </div>
            <div style={{ fontSize: 10, color: '#555', marginBottom: 8 }}>IA silencieuses — idle video uniquement</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {listeners.map(l => (
                <div key={l.id} style={{ background: '#1a1a1a', borderRadius: 8, padding: 10, border: '1px solid #2a2a2a' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{ width: 24, height: 24, borderRadius: '50%', background: l.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
                      {l.label.charAt(0)}
                    </div>
                    <input
                      value={l.label}
                      onChange={e => setListeners(prev => prev.map(ll => ll.id === l.id ? { ...ll, label: e.target.value } : ll))}
                      style={{ flex: 1, background: 'none', border: 'none', color: 'white', fontSize: 11, fontWeight: 600, outline: 'none' }}
                    />
                    <button onClick={() => removeListener(l.id)} style={{ fontSize: 10, color: '#666', background: 'none', border: 'none', cursor: 'pointer' }}>X</button>
                  </div>
                  {/* Photo for idle video generation */}
                  <div
                    onClick={() => listenerFileRefs.current[l.id]?.click()}
                    style={{
                      width: '100%', height: 60, borderRadius: 6, border: '1px dashed #444',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', overflow: 'hidden', background: '#151515',
                    }}
                  >
                    {l.photo ? (
                      <img src={l.photo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <span style={{ fontSize: 9, color: '#555' }}>Photo (idle video)</span>
                    )}
                  </div>
                  <input ref={el => { listenerFileRefs.current[l.id] = el }} type="file" accept="image/*" style={{ display: 'none' }}
                    onChange={e => handleListenerPhoto(l.id, e)} />
                  {l.idleVideoUrl && (
                    <div style={{ fontSize: 9, color: '#4ade80', marginTop: 4 }}>✓ Idle video prete</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Center: Script */}
        <div style={{ flex: 1, padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Script de la reunion</div>
            <div style={{ fontSize: 10, color: '#888' }}>{lines.filter(l => (l.mode === 'text' && l.text.trim()) || (l.mode === 'audio' && l.audioPcmPath)).length} repliques</div>
          </div>

          {lines.map((line, idx) => {
            const c = cases.find(cc => cc.id === line.caseId)
            return (
              <div key={line.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ fontSize: 10, color: '#555', paddingTop: 10, width: 20, textAlign: 'right', flexShrink: 0 }}>{idx + 1}</div>
                <select
                  value={line.caseId}
                  onChange={e => updateLine(line.id, 'caseId', e.target.value)}
                  style={{
                    width: 90, padding: '8px 6px', background: c ? `${c.color}20` : '#1a1a1a',
                    border: `1px solid ${c?.color || '#333'}`, borderRadius: 6, color: 'white', fontSize: 11, flexShrink: 0,
                  }}
                >
                  {cases.map(cc => <option key={cc.id} value={cc.id}>{cc.label}</option>)}
                </select>
                {/* Mode toggle: text or audio */}
                <select
                  value={line.mode}
                  onChange={e => updateLine(line.id, 'mode', e.target.value)}
                  style={{
                    width: 70, padding: '8px 4px', background: '#151515', border: '1px solid #333',
                    borderRadius: 6, color: '#aaa', fontSize: 10, flexShrink: 0,
                  }}
                >
                  <option value="text">Texte</option>
                  <option value="audio">Audio</option>
                </select>
                {/* Text mode: textarea */}
                {line.mode === 'text' ? (
                  <textarea
                    value={line.text}
                    onChange={e => updateLine(line.id, 'text', e.target.value)}
                    placeholder="Ecris la replique ici... [sourire] [colere] [rire] pour les expressions"
                    rows={2}
                    style={{
                      flex: 1, padding: '8px 10px', background: '#151515', border: '1px solid #2a2a2a',
                      borderRadius: 6, color: 'white', fontSize: 12, resize: 'vertical', lineHeight: 1.4,
                    }}
                  />
                ) : (
                  /* Audio mode: file upload */
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div
                      onClick={() => !line.audioUploading && lineAudioRefs.current[line.id]?.click()}
                      style={{
                        padding: '8px 10px', background: '#151515', border: `1px solid ${line.audioPcmPath ? '#4ade80' : '#2a2a2a'}`,
                        borderRadius: 6, cursor: line.audioUploading ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                      }}
                    >
                      <span style={{ fontSize: 14 }}>{line.audioPcmPath ? '✓' : '🎤'}</span>
                      <span style={{ fontSize: 11, color: line.audioPcmPath ? '#4ade80' : '#888', flex: 1 }}>
                        {line.audioUploading ? 'Conversion...' : line.audioFileName ? `${line.audioFileName} (${line.audioDuration?.toFixed(1)}s)` : 'Importer un fichier audio'}
                      </span>
                    </div>
                    <input
                      ref={el => { lineAudioRefs.current[line.id] = el }}
                      type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm" style={{ display: 'none' }}
                      onChange={e => handleLineAudioUpload(line.id, e)}
                    />
                  </div>
                )}
                <button onClick={() => removeLine(line.id)} style={{
                  padding: '8px', background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 14, flexShrink: 0,
                }}>x</button>
              </div>
            )
          })}

          <button onClick={addLine} style={{
            padding: '8px 16px', borderRadius: 6, border: '1px dashed #444', background: 'none',
            color: '#888', cursor: 'pointer', fontSize: 12, alignSelf: 'flex-start',
          }}>+ Ajouter une replique</button>

          {/* Generate all */}
          <div style={{ marginTop: 16, borderTop: '1px solid #2a2a2a', paddingTop: 16 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleGenerateAll}
                disabled={isGenerating}
                style={{
                  flex: 1, padding: '14px 24px', borderRadius: 8, border: 'none', fontSize: 15, fontWeight: 700,
                  cursor: isGenerating ? 'wait' : 'pointer',
                  background: isGenerating ? '#333' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  color: 'white',
                }}
              >
                {isGenerating ? 'Generation en cours...' : 'Generer tout le scenario'}
              </button>
              {isGenerating && (
                <button
                  onClick={handleStopGeneration}
                  style={{
                    padding: '14px 20px', borderRadius: 8, border: '2px solid #ef4444', fontSize: 14, fontWeight: 700,
                    cursor: 'pointer', background: '#1a1a1a', color: '#ef4444',
                  }}
                >
                  STOP
                </button>
              )}
            </div>

            {/* Progress */}
            {genStatus && (
              <div style={{ marginTop: 12 }}>
                {genStatus.phase !== 'error' && (
                  <div style={{ height: 6, background: '#222', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
                    <div style={{
                      height: '100%', borderRadius: 3, transition: 'width 0.5s',
                      width: `${progress}%`,
                      background: genStatus.phase === 'done' ? '#10b981' : 'linear-gradient(90deg, #6366f1, #8b5cf6)',
                    }} />
                  </div>
                )}
                <div style={{
                  fontSize: 12, fontWeight: 600, marginBottom: 6,
                  color: genStatus.phase === 'error' ? '#f87171' : genStatus.phase === 'done' ? '#4ade80' : '#a5b4fc',
                }}>
                  {genStatus.detail}
                </div>

                {/* Log */}
                <div style={{
                  background: '#111', borderRadius: 6, padding: 10, maxHeight: 200, overflowY: 'auto',
                  fontSize: 10, fontFamily: 'monospace', lineHeight: 1.6, color: '#888',
                }}>
                  {genStatus.log.map((l, i) => (
                    <div key={i} style={{ color: l.includes('ERREUR') ? '#f87171' : l.includes('OK') ? '#4ade80' : '#888' }}>{l}</div>
                  ))}
                </div>
              </div>
            )}

            {/* LANCER LA REUNION — only after generation is complete */}
            {scenarioReady && !isGenerating && (
              <div style={{
                marginTop: 20, padding: 24, borderRadius: 12,
                background: meetingLinks.length > 0 ? 'linear-gradient(135deg, #064e3b, #065f46)' : 'linear-gradient(135deg, #1a1a2e, #16213e)',
                border: meetingLinks.length > 0 ? '2px solid #10b981' : '2px solid #6366f1',
                textAlign: 'center',
              }}>
                {meetingLinks.length > 0 ? (
                  <>
                    <div style={{ fontSize: 24, marginBottom: 8 }}>✅</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: '#4ade80', marginBottom: 6 }}>Reunion prete !</div>
                    <div style={{ fontSize: 12, color: '#86efac', marginBottom: 12, fontWeight: 600 }}>
                      🔗 {meetingLinks.length} liens single-use (1 ouverture par lien) :
                    </div>

                    {/* All meeting links */}
                    {meetingLinks.map((link, idx) => (
                      <div key={idx} style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        background: '#0a0a0a', borderRadius: 8, padding: '8px 14px', marginBottom: 8,
                      }}>
                        <span style={{ color: '#6ee7b7', fontSize: 11, fontWeight: 700, minWidth: 60 }}>Lien {idx + 1}</span>
                        <input
                          readOnly
                          value={link}
                          onClick={e => (e.target as HTMLInputElement).select()}
                          style={{
                            flex: 1, background: 'none', border: 'none', color: '#5eead4', fontSize: 11,
                            fontFamily: 'monospace', outline: 'none', cursor: 'text',
                          }}
                        />
                        <button
                          onClick={() => { navigator.clipboard.writeText(link); }}
                          style={{
                            padding: '4px 10px', borderRadius: 6, border: 'none', fontSize: 10, fontWeight: 700,
                            background: '#10b981', color: 'white', cursor: 'pointer', whiteSpace: 'nowrap',
                          }}
                        >
                          Copier
                        </button>
                      </div>
                    ))}

                    <div style={{ marginTop: 12, display: 'flex', gap: 12, justifyContent: 'center' }}>
                      <button
                        onClick={() => { navigator.clipboard.writeText(meetingLinks.join('\n')); }}
                        style={{
                          padding: '10px 24px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 800,
                          background: 'linear-gradient(135deg, #10b981, #059669)', color: 'white', cursor: 'pointer',
                          boxShadow: '0 4px 20px rgba(16,185,129,0.4)',
                        }}
                      >
                        Copier tous les liens
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 24, marginBottom: 8 }}>🎬</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#c7d2fe', marginBottom: 6 }}>
                      {Object.keys(participantVideos).length} video{Object.keys(participantVideos).length > 1 ? 's' : ''} continue{Object.keys(participantVideos).length > 1 ? 's' : ''} ({meetingDuration.toFixed(0)}s)
                    </div>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
                      Clique pour generer le lien de la reunion a partager.
                    </div>
                    <button
                      onClick={async () => { await launchInMeeting(); setLaunched(true) }}
                      style={{
                        padding: '14px 40px', borderRadius: 10, border: 'none', fontSize: 16, fontWeight: 800,
                        background: 'linear-gradient(135deg, #10b981, #059669)', color: 'white', cursor: 'pointer',
                        boxShadow: '0 4px 20px rgba(16,185,129,0.4)', letterSpacing: '0.5px',
                      }}
                    >
                      CREER LE LIEN DE REUNION
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: Preview */}
        <div style={{ width: 260, background: '#111', borderLeft: '1px solid #2a2a2a', padding: 14, overflowY: 'auto' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#a5b4fc', marginBottom: 10 }}>Apercu scenario</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {lines.filter(l => l.text.trim()).map((line, idx) => {
              const c = cases.find(cc => cc.id === line.caseId)
              return (
                <div key={line.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: 8, background: '#1a1a1a', borderRadius: 6, borderLeft: `3px solid ${c?.color || '#333'}` }}>
                  <div style={{ width: 22, height: 22, borderRadius: '50%', background: c?.color || '#333', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, flexShrink: 0 }}>
                    {c?.id.replace('p', '')}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: c?.color || '#888' }}>{c?.label}</div>
                    <div style={{ fontSize: 10, color: '#999', lineHeight: 1.3, marginTop: 2 }}>
                      {line.text.length > 80 ? line.text.slice(0, 80) + '...' : line.text}
                    </div>
                  </div>
                  <div style={{ fontSize: 9, color: '#555', flexShrink: 0 }}>#{idx + 1}</div>
                </div>
              )
            })}
            {lines.filter(l => l.text.trim()).length === 0 && (
              <div style={{ color: '#444', fontSize: 11, textAlign: 'center', padding: 20 }}>
                Ecris des repliques pour voir l'apercu
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
