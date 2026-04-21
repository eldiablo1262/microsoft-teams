'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'

interface VoiceOption { label: string; gender: string }

interface CaseConfig {
  id: string
  label: string
  color: string
  photo: string | null
  photoPath: string | null
  voiceId: string
}

interface ScriptLine {
  id: string
  caseId: string
  text: string
}

interface GenStatus {
  phase: string
  current: number
  total: number
  detail: string
  log: string[]
}

const COLORS = ['#7B83EB', '#E74856', '#00A4EF', '#FFB900', '#9B59B6']

export default function ScenarioBuilder() {
  const [voices, setVoices] = useState<Record<string, VoiceOption>>({})
  const [cases, setCases] = useState<CaseConfig[]>([
    { id: 'p1', label: 'Case 1', color: COLORS[0], photo: null, photoPath: null, voiceId: '' },
    { id: 'p2', label: 'Case 2', color: COLORS[1], photo: null, photoPath: null, voiceId: '' },
    { id: 'p3', label: 'Case 3', color: COLORS[2], photo: null, photoPath: null, voiceId: '' },
    { id: 'p4', label: 'Case 4', color: COLORS[3], photo: null, photoPath: null, voiceId: '' },
  ])
  const [lines, setLines] = useState<ScriptLine[]>([
    { id: 'l1', caseId: 'p1', text: '' },
  ])
  const [genStatus, setGenStatus] = useState<GenStatus | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [scenarioReady, setScenarioReady] = useState(false)
  const [participantVideos, setParticipantVideos] = useState<Record<string, string>>({})
  const [meetingTimeline, setMeetingTimeline] = useState<{ participantId: string; startTime: number; endTime: number }[]>([])
  const [meetingDuration, setMeetingDuration] = useState(0)
  const [launched, setLaunched] = useState(false)
  const [meetingLink, setMeetingLink] = useState<string | null>(null)
  const [adminLink, setAdminLink] = useState<string | null>(null)
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({})

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

  const handlePhoto = async (caseId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Resize client-side to max 1024px
    const preview = URL.createObjectURL(file)
    const resized = await resizeImage(file, 1024)
    // Upload via FormData (no body size limit)
    const form = new FormData()
    form.append('photo', resized, `${caseId}.jpg`)
    try {
      const res = await fetch('/api/upload-photo', { method: 'POST', body: form })
      const data = await res.json()
      if (data.url) {
        setCases(prev => prev.map(c => c.id === caseId ? { ...c, photo: preview, photoPath: data.url } : c))
      }
    } catch (err) {
      console.error('Photo upload failed:', err)
    }
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
    setLines(prev => [...prev, { id: `l${Date.now()}`, caseId: cases[0]?.id || 'p1', text: '' }])
  }

  const removeLine = (id: string) => {
    if (lines.length <= 1) return
    setLines(prev => prev.filter(l => l.id !== id))
  }

  const updateLine = (id: string, field: 'caseId' | 'text', value: string) => {
    setLines(prev => prev.map(l => l.id === id ? { ...l, [field]: value } : l))
  }

  const addCase = () => {
    if (cases.length >= 5) return
    const idx = cases.length
    const keys = Object.keys(voices)
    setCases(prev => [...prev, {
      id: `p${idx + 1}`, label: `Case ${idx + 1}`, color: COLORS[idx],
      photo: null, photoPath: null, voiceId: keys[idx] || keys[0] || '',
    }])
  }

  const removeCase = (id: string) => {
    if (cases.length <= 2) return
    setCases(prev => prev.filter(c => c.id !== id))
    setLines(prev => prev.map(l => l.caseId === id ? { ...l, caseId: cases[0].id } : l))
  }

  // Generate everything — 3-phase continuous video approach
  const handleGenerateAll = useCallback(async () => {
    // Validate
    const usedCases = lines.filter(l => l.text.trim()).map(l => l.caseId).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
    const missingPhoto = usedCases.filter((cid: string) => !cases.find(c => c.id === cid)?.photoPath)
    if (missingPhoto.length > 0) {
      setGenStatus({ phase: 'error', current: 0, total: 0, detail: `Photo manquante pour: ${missingPhoto.join(', ')}`, log: [] })
      return
    }
    const validLines = lines.filter(l => l.text.trim())
    if (validLines.length === 0) {
      setGenStatus({ phase: 'error', current: 0, total: 0, detail: 'Ecris au moins une replique', log: [] })
      return
    }

    setIsGenerating(true)
    setScenarioReady(false)
    setMeetingLink(null)
    const log: string[] = []
    // Total steps: TTS per line + 1 combine + 1 video per participant
    const totalSteps = validLines.length + 1 + usedCases.length
    let currentStep = 0

    const addLog = (msg: string) => {
      log.push(msg)
      setGenStatus(prev => prev ? { ...prev, log: [...log] } : null)
    }

    // ==============================================
    // PHASE 1: Generate TTS for all speech segments
    // ==============================================
    setGenStatus({ phase: 'tts', current: 0, total: totalSteps, detail: 'Phase 1: Generation audio TTS...', log })

    const ttsSegments: { participantId: string; pcmPath: string; duration: number; index: number }[] = []
    for (let i = 0; i < validLines.length; i++) {
      const line = validLines[i]
      const c = cases.find(cc => cc.id === line.caseId)!
      currentStep++
      setGenStatus({ phase: 'tts', current: currentStep, total: totalSteps, detail: `TTS ${i + 1}/${validLines.length} (${c.label})...`, log })
      addLog(`[TTS ${i + 1}] ${c.label}: "${line.text.slice(0, 40)}..."`)

      try {
        const res = await fetch('/api/generate-tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: line.text.trim(),
            voiceId: c.voiceId,
            filename: `tts-${i + 1}-${line.caseId}-${Date.now()}.pcm`,
          }),
        })
        const data = await res.json()
        if (data.success) {
          ttsSegments.push({ participantId: line.caseId, pcmPath: data.pcmPath, duration: data.duration, index: i })
          addLog(`[TTS ${i + 1}] ${c.label}: OK (${data.duration.toFixed(1)}s)`)
        } else {
          addLog(`[TTS ${i + 1}] ${c.label}: ERREUR - ${data.error}`)
        }
      } catch (err) {
        addLog(`[TTS ${i + 1}] ${c.label}: ERREUR - ${err instanceof Error ? err.message : 'inconnue'}`)
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
      // PHASE 3: Generate continuous video per participant
      // Supports chunking for long videos (>25s)
      // ================================================
      const MAX_CHUNK_SEC = 25
      const videoResults: Record<string, string> = {}
      const VIDEO_PROMPT = 'Continuous uninterrupted webcam shot, head and shoulders framing, fixed camera with no movement. A person is in a live professional video conference call. CRITICAL RULE: The person MUST keep their mouth COMPLETELY CLOSED and STILL during ALL silent/quiet sections of the audio. Absolutely ZERO lip movement, ZERO jaw movement, ZERO mouth opening when there is no speech audio. The lips must remain pressed together naturally as if the person is simply listening. During these silent periods, the person shows ONLY subtle idle body language: very gentle weight shifts, slow natural head tilts, occasional eyebrow raises, relaxed blinking at varied intervals, subtle chest breathing motion, slight nods as if listening, and minor postural adjustments. All these idle movements flow smoothly so the video never loops. When speech audio begins, the person speaks with precise natural lip sync matching the audio exactly, with natural conversational head motion. Transitions from listening (mouth closed) to speaking (lip sync) must be smooth. The mouth opens ONLY when audio speech is present. Photorealistic webcam quality, soft natural office lighting, shallow depth of field on the background.'

      for (const pid of usedCases) {
        const c = cases.find(cc => cc.id === pid)!
        currentStep++
        const audioTrack = combData.audioTracks[pid]

        // Check if we need to split into chunks
        if (totalMeetingDuration > MAX_CHUNK_SEC) {
          addLog(`[VIDEO] ${c.label}: duree ${totalMeetingDuration.toFixed(0)}s > ${MAX_CHUNK_SEC}s, decoupage en chunks...`)
          setGenStatus({ phase: 'video', current: currentStep, total: totalSteps, detail: `Phase 3: Decoupage audio ${c.label}...`, log })

          // Split audio into chunks
          const splitRes = await fetch('/api/split-audio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wavPath: audioTrack, maxChunkSeconds: MAX_CHUNK_SEC }),
          })
          const splitData = await splitRes.json()
          if (!splitData.success) {
            addLog(`[VIDEO] ${c.label}: ERREUR split - ${splitData.error}`)
            continue
          }

          const chunks = splitData.chunks as { wavPath: string; duration: number }[]
          addLog(`[VIDEO] ${c.label}: ${chunks.length} chunks a generer`)

          // Generate video for each chunk sequentially
          const chunkVideoPaths: string[] = []
          let allChunksOk = true

          for (let ci = 0; ci < chunks.length; ci++) {
            const chunk = chunks[ci]
            addLog(`[VIDEO] ${c.label}: chunk ${ci + 1}/${chunks.length} (${chunk.duration.toFixed(1)}s)...`)
            setGenStatus({ phase: 'video', current: currentStep, total: totalSteps, detail: `Phase 3: ${c.label} chunk ${ci + 1}/${chunks.length}...`, log })

            try {
              const controller = new AbortController()
              const timeout = setTimeout(() => controller.abort(), 2 * 60 * 60 * 1000) // 2h timeout
              const vRes = await fetch('/api/generate-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                  audioPath: chunk.wavPath,
                  photoPath: c.photoPath,
                  prompt: VIDEO_PROMPT,
                  filename: `chunk-${pid}-${ci}-${Date.now()}.mp4`,
                }),
              })
              clearTimeout(timeout)
              const vData = await vRes.json()
              if (vData.success) {
                chunkVideoPaths.push(vData.videoUrl)
                addLog(`[VIDEO] ${c.label}: chunk ${ci + 1} OK (${(vData.size / 1024 / 1024).toFixed(1)} MB)`)
              } else {
                addLog(`[VIDEO] ${c.label}: chunk ${ci + 1} ERREUR - ${vData.error}`)
                allChunksOk = false
                break
              }
            } catch (err) {
              addLog(`[VIDEO] ${c.label}: chunk ${ci + 1} ERREUR - ${err instanceof Error ? err.message : 'inconnue'}`)
              allChunksOk = false
              break
            }
          }

          if (!allChunksOk || chunkVideoPaths.length === 0) {
            addLog(`[VIDEO] ${c.label}: generation echouee`)
            continue
          }

          // Concatenate chunks into one video
          if (chunkVideoPaths.length > 1) {
            addLog(`[VIDEO] ${c.label}: concatenation ${chunkVideoPaths.length} chunks...`)
            setGenStatus({ phase: 'video', current: currentStep, total: totalSteps, detail: `Phase 3: Concatenation ${c.label}...`, log })

            try {
              const concatRes = await fetch('/api/concat-videos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  videoPaths: chunkVideoPaths,
                  outputFilename: `meeting-${pid}-${Date.now()}.mp4`,
                }),
              })
              const concatData = await concatRes.json()
              if (concatData.success) {
                videoResults[pid] = concatData.videoUrl
                addLog(`[VIDEO] ${c.label}: concatenation OK (${(concatData.size / 1024 / 1024).toFixed(1)} MB)`)
              } else {
                addLog(`[VIDEO] ${c.label}: ERREUR concat - ${concatData.error}`)
              }
            } catch (err) {
              addLog(`[VIDEO] ${c.label}: ERREUR concat - ${err instanceof Error ? err.message : 'inconnue'}`)
            }
          } else {
            videoResults[pid] = chunkVideoPaths[0]
          }

        } else {
          // Short video — generate in one shot (no chunking)
          setGenStatus({ phase: 'video', current: currentStep, total: totalSteps, detail: `Phase 3: Video ${c.label} (${totalMeetingDuration.toFixed(0)}s)...`, log })
          addLog(`[VIDEO] ${c.label}: generation video continue (${totalMeetingDuration.toFixed(0)}s)...`)

          try {
            const controller2 = new AbortController()
            const timeout2 = setTimeout(() => controller2.abort(), 2 * 60 * 60 * 1000) // 2h timeout
            const vRes = await fetch('/api/generate-video', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: controller2.signal,
              body: JSON.stringify({
                audioPath: audioTrack,
                photoPath: c.photoPath,
                prompt: VIDEO_PROMPT,
                filename: `meeting-${pid}-${Date.now()}.mp4`,
              }),
            })
            clearTimeout(timeout2)
            const vData = await vRes.json()
            if (vData.success) {
              videoResults[pid] = vData.videoUrl
              addLog(`[VIDEO] ${c.label}: OK (${(vData.size / 1024 / 1024).toFixed(1)} MB)`)
            } else {
              addLog(`[VIDEO] ${c.label}: ERREUR - ${vData.error}`)
            }
          } catch (err) {
            addLog(`[VIDEO] ${c.label}: ERREUR - ${err instanceof Error ? err.message : 'inconnue'}`)
          }
        }
      }

      // Save results to state
      setParticipantVideos(videoResults)
      setMeetingTimeline(timeline)
      setMeetingDuration(totalMeetingDuration)

      const totalGenerated = Object.keys(videoResults).length
      addLog(`[OK] ${totalGenerated} videos continues generees (${totalMeetingDuration.toFixed(1)}s chacune)`)

      setScenarioReady(totalGenerated > 0)
      setIsGenerating(false)
      setGenStatus({ phase: 'done', current: totalSteps, total: totalSteps, detail: `Pret ! ${totalGenerated} videos continues de ${totalMeetingDuration.toFixed(0)}s`, log })
    } catch (err) {
      addLog(`[COMBINE] ERREUR: ${err instanceof Error ? err.message : 'inconnue'}`)
      setIsGenerating(false)
      setGenStatus({ phase: 'error', current: 0, total: 0, detail: 'Erreur construction audio', log })
    }
  }, [cases, lines])

  // Launch — create meeting room with continuous videos + timeline
  const launchInMeeting = async () => {
    if (Object.keys(participantVideos).length === 0) {
      console.warn('No videos to launch')
      return
    }
    try {
      const participantList = Object.keys(participantVideos).map(pid => {
        const c = cases.find(cc => cc.id === pid)
        return { id: pid, name: c?.label || pid, color: c?.color || '#5b5fc7', videoUrl: participantVideos[pid] }
      })

      const res = await fetch('/api/meeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Reunion IA',
          participants: participantList,
          timeline: meetingTimeline,
          totalDuration: meetingDuration,
        }),
      })
      const data = await res.json()
      if (data.success && data.meetingId) {
        const clientLink = `${window.location.origin}/meeting/${data.meetingId}`
        const admLink = `${window.location.origin}/meeting/${data.meetingId}?role=admin&key=${data.adminKey}`
        setMeetingLink(clientLink)
        setAdminLink(admLink)
        setGenStatus(prev => prev ? { ...prev, detail: 'Liens de reunion generes !' } : null)
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
          <a href="/" style={{ color: '#818cf8', fontSize: 12, textDecoration: 'none' }}>Aller a la reunion</a>
        </div>
      </div>

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

                {/* Voice */}
                <select
                  value={c.voiceId}
                  onChange={e => setCases(prev => prev.map(cc => cc.id === c.id ? { ...cc, voiceId: e.target.value } : cc))}
                  style={{ width: '100%', padding: '4px 6px', background: '#151515', border: '1px solid #333', borderRadius: 4, color: 'white', fontSize: 10 }}
                >
                  {Object.entries(voices).map(([id, v]) => <option key={id} value={id}>{v.label}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>

        {/* Center: Script */}
        <div style={{ flex: 1, padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Script de la reunion</div>
            <div style={{ fontSize: 10, color: '#888' }}>{lines.filter(l => l.text.trim()).length} repliques</div>
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
                <textarea
                  value={line.text}
                  onChange={e => updateLine(line.id, 'text', e.target.value)}
                  placeholder="Ecris la replique ici..."
                  rows={2}
                  style={{
                    flex: 1, padding: '8px 10px', background: '#151515', border: '1px solid #2a2a2a',
                    borderRadius: 6, color: 'white', fontSize: 12, resize: 'vertical', lineHeight: 1.4,
                  }}
                />
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
            <button
              onClick={handleGenerateAll}
              disabled={isGenerating}
              style={{
                width: '100%', padding: '14px 24px', borderRadius: 8, border: 'none', fontSize: 15, fontWeight: 700,
                cursor: isGenerating ? 'wait' : 'pointer',
                background: isGenerating ? '#333' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                color: 'white',
              }}
            >
              {isGenerating ? 'Generation en cours...' : 'Generer tout le scenario'}
            </button>

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
                background: meetingLink ? 'linear-gradient(135deg, #064e3b, #065f46)' : 'linear-gradient(135deg, #1a1a2e, #16213e)',
                border: meetingLink ? '2px solid #10b981' : '2px solid #6366f1',
                textAlign: 'center',
              }}>
                {meetingLink ? (
                  <>
                    <div style={{ fontSize: 24, marginBottom: 8 }}>✅</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: '#4ade80', marginBottom: 6 }}>Reunion prete !</div>

                    {/* Client link */}
                    <div style={{ fontSize: 12, color: '#86efac', marginBottom: 8, fontWeight: 600 }}>🔗 Lien CLIENT (a envoyer au participant) :</div>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      background: '#0a0a0a', borderRadius: 8, padding: '10px 14px', marginBottom: 16,
                    }}>
                      <input
                        readOnly
                        value={meetingLink}
                        onClick={e => (e.target as HTMLInputElement).select()}
                        style={{
                          flex: 1, background: 'none', border: 'none', color: '#5eead4', fontSize: 13,
                          fontFamily: 'monospace', outline: 'none', cursor: 'text',
                        }}
                      />
                      <button
                        onClick={() => { navigator.clipboard.writeText(meetingLink); }}
                        style={{
                          padding: '6px 14px', borderRadius: 6, border: 'none', fontSize: 11, fontWeight: 700,
                          background: '#10b981', color: 'white', cursor: 'pointer', whiteSpace: 'nowrap',
                        }}
                      >
                        Copier
                      </button>
                    </div>

                    {/* Admin link */}
                    <div style={{ fontSize: 12, color: '#93c5fd', marginBottom: 8, fontWeight: 600 }}>🛡️ Lien ADMIN (pour toi — monitoring + rejoindre) :</div>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      background: '#0a0a0a', borderRadius: 8, padding: '10px 14px', marginBottom: 16,
                    }}>
                      <input
                        readOnly
                        value={adminLink || ''}
                        onClick={e => (e.target as HTMLInputElement).select()}
                        style={{
                          flex: 1, background: 'none', border: 'none', color: '#93c5fd', fontSize: 13,
                          fontFamily: 'monospace', outline: 'none', cursor: 'text',
                        }}
                      />
                      <button
                        onClick={() => { if (adminLink) navigator.clipboard.writeText(adminLink); }}
                        style={{
                          padding: '6px 14px', borderRadius: 6, border: 'none', fontSize: 11, fontWeight: 700,
                          background: '#6366f1', color: 'white', cursor: 'pointer', whiteSpace: 'nowrap',
                        }}
                      >
                        Copier
                      </button>
                    </div>

                    <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                      <a href={adminLink || ''} target="_blank" rel="noopener noreferrer" style={{
                        display: 'inline-block', padding: '12px 28px', borderRadius: 10, fontSize: 14, fontWeight: 800,
                        background: 'linear-gradient(135deg, #6366f1, #4f46e5)', color: 'white', textDecoration: 'none',
                        boxShadow: '0 4px 20px rgba(99,102,241,0.4)',
                      }}>
                        Ouvrir (Admin)
                      </a>
                      <a href={meetingLink} target="_blank" rel="noopener noreferrer" style={{
                        display: 'inline-block', padding: '12px 28px', borderRadius: 10, fontSize: 14, fontWeight: 800,
                        background: 'linear-gradient(135deg, #10b981, #059669)', color: 'white', textDecoration: 'none',
                        boxShadow: '0 4px 20px rgba(16,185,129,0.4)',
                      }}>
                        Ouvrir (Client)
                      </a>
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
