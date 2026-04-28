'use client'

import React, { useState, useEffect, useRef, useCallback, Suspense } from 'react'
import { useParams } from 'next/navigation'
import MeetingToolbar from '../../../components/MeetingToolbar'
import { Mic, MicOff, MoreHorizontal, X } from 'lucide-react'

interface MeetingParticipant {
  id: string
  name: string
  color: string
  videoUrl: string
  idleVideoUrl?: string
  role?: 'speaker' | 'listener'
}

interface TimelineSegment {
  participantId: string
  startTime: number
  endTime: number
}

interface MeetingData {
  id: string
  title: string
  participants: MeetingParticipant[]
  timeline: TimelineSegment[]
  totalDuration: number
}

function MeetingRoomInner() {
  const params = useParams()
  const meetingId = params.id as string

  const [meetingData, setMeetingData] = useState<MeetingData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [joined, setJoined] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [showChat, setShowChat] = useState(false)
  const [showParticipants, setShowParticipants] = useState(false)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [scenarioStatus, setScenarioStatus] = useState('')
  const [displayName, setDisplayName] = useState('Client')
  const [videoLoading, setVideoLoading] = useState<Record<string, boolean>>({})
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [meetingEnded, setMeetingEnded] = useState(false)
  const meetingEndedRef = useRef(false)

  // Preload: download videos fully into memory (blob URLs) before playback
  const [videoBlobUrls, setVideoBlobUrls] = useState<Record<string, string>>({})
  const [idleBlobUrls, setIdleBlobUrls] = useState<Record<string, string>>({})
  const [preloadProgress, setPreloadProgress] = useState(0) // 0-100
  const [preloadDone, setPreloadDone] = useState(false)

  const audioElRef = useRef<HTMLAudioElement>(null)
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({})
  const idleVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({})
  const playStartRef = useRef<number>(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch meeting data
  useEffect(() => {
    if (!meetingId) return
    fetch(`/api/meeting?id=${meetingId}`)
      .then(r => r.json())
      .then(data => {
        if (data.success && data.meeting) {
          setMeetingData(data.meeting)
        } else {
          setLoadError(data.error || 'Reunion introuvable')
        }
        setLoading(false)
      })
      .catch(() => {
        setLoadError('Erreur de connexion')
        setLoading(false)
      })
  }, [meetingId])

  // Preload videos into memory as blob URLs — zero network dependency during playback
  // STRATEGY: Join button enables as soon as MAIN videos are ready. Idle videos download in background.
  // Also has a hard timeout: if a main video can't be preloaded in 90s, fall back to streaming (remote URL).
  useEffect(() => {
    if (!meetingData || preloadDone) return
    let cancelled = false

    const downloadAsBlob = async (url: string, label: string, timeoutMs = 90000): Promise<{ blobUrl: string; size: number } | null> => {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const reader = res.body?.getReader()
        if (!reader) throw new Error('No reader')
        const chunks: BlobPart[] = []
        let received = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (cancelled) { reader.cancel(); return null }
          chunks.push(value)
          received += value.length
        }
        clearTimeout(timeoutId)
        if (cancelled) return null
        const blob = new Blob(chunks, { type: 'video/mp4' })
        return { blobUrl: URL.createObjectURL(blob), size: received }
      } catch (err: any) {
        clearTimeout(timeoutId)
        console.error(`[PRELOAD] ${label}: failed — ${err.message}`)
        return null
      }
    }

    const preloadAll = async () => {
      const participants = meetingData.participants
      if (participants.length === 0) { setPreloadDone(true); setPreloadProgress(100); return }

      const mainBlobMap: Record<string, string> = {}
      let mainLoaded = 0
      const total = participants.length

      // ============================================
      // PHASE 1: Download MAIN videos (blocks join button)
      // ============================================
      await Promise.all(participants.map(async (p) => {
        const result = await downloadAsBlob(p.videoUrl, `${p.name} (main)`)
        if (result) {
          mainBlobMap[p.id] = result.blobUrl
          console.log(`[PRELOAD] ${p.name} main: ${(result.size / 1024 / 1024).toFixed(1)}MB`)
        } else {
          console.warn(`[PRELOAD] ${p.name}: using remote URL as fallback`)
        }
        mainLoaded++
        if (!cancelled) setPreloadProgress(Math.min(99, Math.round((mainLoaded / total) * 100)))
      }))

      if (cancelled) return

      // Main videos done — enable join button immediately (even if some failed, fallback to remote URL)
      setVideoBlobUrls(mainBlobMap)
      setPreloadDone(true)
      setPreloadProgress(100)
      console.log(`[PRELOAD] Main videos done: ${Object.keys(mainBlobMap).length}/${total} cached. Join button enabled.`)

      // ============================================
      // PHASE 2: Download IDLE videos IN BACKGROUND (non-blocking)
      // These only play after scenario ends, so we have plenty of time
      // ============================================
      const idleBlobMap: Record<string, string> = {}
      const participantsWithIdle = participants.filter(p => p.idleVideoUrl)
      if (participantsWithIdle.length === 0) return

      console.log(`[PRELOAD] Starting background idle download (${participantsWithIdle.length} videos)...`)
      await Promise.all(participantsWithIdle.map(async (p) => {
        if (cancelled) return
        const result = await downloadAsBlob(p.idleVideoUrl!, `${p.name} (idle)`, 180000) // 3min timeout
        if (result && !cancelled) {
          idleBlobMap[p.id] = result.blobUrl
          console.log(`[PRELOAD] ${p.name} idle: ${(result.size / 1024 / 1024).toFixed(1)}MB (background)`)
          // Update state progressively as each idle arrives
          setIdleBlobUrls(prev => ({ ...prev, [p.id]: result.blobUrl }))
        }
      }))
      console.log(`[PRELOAD] Idle videos background done: ${Object.keys(idleBlobMap).length}/${participantsWithIdle.length}`)
    }

    preloadAll()
    return () => { cancelled = true }
  }, [meetingData, preloadDone])

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      Object.values(videoBlobUrls).forEach(url => { try { URL.revokeObjectURL(url) } catch {} })
      Object.values(idleBlobUrls).forEach(url => { try { URL.revokeObjectURL(url) } catch {} })
    }
  }, [videoBlobUrls, idleBlobUrls])

  // Elapsed timer
  useEffect(() => {
    if (!joined) return
    const t = setInterval(() => setElapsed(p => p + 1), 1000)
    return () => clearInterval(t)
  }, [joined])

  // Timeline ticker — controls which participant's audio is heard
  useEffect(() => {
    if (!joined || !meetingData) return

    let lastSpeaker: string | null = null
    let logCounter = 0
    const tick = () => {
      if (playStartRef.current === 0) return
      const now = (Date.now() - playStartRef.current) / 1000
      const activeSeg = meetingData.timeline.find(s => now >= s.startTime && now <= s.endTime)
      const currentSpeaker = activeSeg ? activeSeg.participantId : null
      setSpeakingId(currentSpeaker)

      // After scenario: enforce silence on EVERY tick (100ms safety net)
      if (meetingEndedRef.current) {
        meetingData.participants.forEach(p => {
          const vid = videoRefs.current[p.id]
          if (vid && vid.volume > 0) vid.volume = 0
        })
        return
      }

      meetingData.participants.forEach(p => {
        const isSpeakerRole = (p.role || 'speaker') === 'speaker'
        if (isSpeakerRole) {
          // Speaker: manage main video volume + keep it playing
          const vid = videoRefs.current[p.id]
          if (!vid) return
          const isSpeaker = (p.id === currentSpeaker)
          vid.volume = isSpeaker ? 1 : 0
          if (vid.paused || vid.readyState < 2) {
            vid.play().catch(() => {})
          }
        } else {
          // Listener: keep idle video playing (always muted)
          const idleVid = idleVideoRefs.current[p.id]
          if (idleVid && (idleVid.paused || idleVid.readyState < 2)) {
            idleVid.muted = true
            idleVid.loop = true
            idleVid.play().catch(() => {})
          }
        }
      })

      // Detailed state log every 2 seconds
      logCounter++
      if (logCounter % 20 === 0) {
        const states = meetingData.participants.map(p => {
          const v = videoRefs.current[p.id]
          if (!v) return `${p.name}:NO_REF`
          return `${p.name}:${v.paused ? 'PAUSED' : 'PLAY'} t=${v.currentTime.toFixed(1)} vol=${v.volume}`
        }).join(' | ')
        console.log(`[STATE] clock=${now.toFixed(1)}s speaker=${currentSpeaker || 'none'} | ${states}`)
      }

      if (currentSpeaker !== lastSpeaker) {
        const name = currentSpeaker ? meetingData.participants.find(p => p.id === currentSpeaker)?.name : 'nobody'
        const states = meetingData.participants.map(p => {
          const v = videoRefs.current[p.id]
          return v ? `${p.name}:${v.paused?'PAUSED':'OK'} vol=${v.volume}` : `${p.name}:NULL`
        }).join(' | ')
        console.log(`[TICKER] t=${now.toFixed(1)}s speaker=${name} | ${states}`)
        lastSpeaker = currentSpeaker
      }

      if (activeSeg) {
        // No status text — in a real meeting there's no "X parle..." indicator
        setScenarioStatus('')
      } else if (now > meetingData.totalDuration && !meetingEndedRef.current) {
        // Meeting scenario ended — crossfade to idle videos, enable mic for live discussion
        meetingEndedRef.current = true
        setMeetingEnded(true)
        console.log('[MEETING] Scenario ended — crossfading to idle videos, enabling mic')
        meetingData.participants.forEach(p => {
          const mainVid = videoRefs.current[p.id]
          const idleVid = idleVideoRefs.current[p.id]
          if (mainVid) {
            mainVid.volume = 0
            mainVid.loop = false // main video stops at last frame (will be hidden by crossfade)
          }
          // Start playing idle video (preloaded, hidden behind main with opacity 0)
          if (idleVid) {
            idleVid.volume = 0
            idleVid.muted = true
            idleVid.loop = true
            idleVid.currentTime = 0
            idleVid.play().catch(() => {})
            console.log(`[MEETING] ${p.name}: idle video started (crossfading in)`)
          } else {
            console.log(`[MEETING] ${p.name}: no idle video — main will freeze on last frame`)
          }
        })
        setScenarioStatus('') // No visible status — keep it natural
      } else if (meetingEndedRef.current) {
        setScenarioStatus('') // Stay silent — no indication
      } else {
        setScenarioStatus('')
      }
    }

    timerRef.current = setInterval(tick, 100)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [joined, meetingData])

  // Start all videos — videos are pre-loaded as blobs, so playback is instant (no network)
  const startAllVideos = useCallback(async (syncToTime?: number) => {
    if (!meetingData) return
    const startOffset = syncToTime || 0
    console.log(`[PLAY] Starting ${meetingData.participants.length} videos from memory, sync=${startOffset.toFixed(1)}s`)

    // Mark all videos as loading briefly
    const loadingState: Record<string, boolean> = {}
    meetingData.participants.forEach(p => { loadingState[p.id] = true })
    setVideoLoading(loadingState)

    const startSingleVideo = async (p: MeetingParticipant, retryCount = 0): Promise<void> => {
      const isSpeakerRole = (p.role || 'speaker') === 'speaker'
      // Speakers use main video, listeners use idle video
      const vid = isSpeakerRole ? videoRefs.current[p.id] : idleVideoRefs.current[p.id]
      if (!vid) {
        console.warn(`[PLAY] ${p.name}: no video ref (role=${p.role})`)
        setVideoLoading(prev => ({ ...prev, [p.id]: false }))
        return
      }

      // Videos are blob URLs (in memory) — should be ready almost instantly
      if (vid.readyState < 2) {
        await new Promise<void>(resolve => {
          const onReady = () => { vid.removeEventListener('canplay', onReady); resolve() }
          vid.addEventListener('canplay', onReady)
          vid.load()
          setTimeout(resolve, 5000) // 5s is generous for blob URL
        })
      }

      // Sync to correct time position (speakers only)
      if (isSpeakerRole && startOffset > 0 && vid.duration > 0) {
        vid.currentTime = startOffset > vid.duration ? startOffset % vid.duration : startOffset
      }

      // Listeners are always muted + looping
      if (!isSpeakerRole) {
        vid.muted = true
        vid.volume = 0
        vid.loop = true
      } else {
        // Use volume=0 (NOT muted) — muted toggling blocked by browsers without gesture
        vid.muted = false
        vid.volume = 0
      }

      try {
        await vid.play()
        console.log(`[PLAY] ${p.name}: playing from memory (role=${p.role}, d=${vid.duration.toFixed(1)}s)`)
        setVideoLoading(prev => ({ ...prev, [p.id]: false }))
      } catch (err: any) {
        console.warn(`[PLAY] ${p.name}: play failed (attempt ${retryCount}): ${err.message}`)
        if (retryCount < 3) {
          if (err.name === 'NotAllowedError') {
            vid.muted = true
            vid.volume = 0
            try {
              await vid.play()
              console.log(`[PLAY] ${p.name}: playing muted (fallback)`)
              setVideoLoading(prev => ({ ...prev, [p.id]: false }))
              if (isSpeakerRole) setAudioBlocked(true)
              return
            } catch {}
          }
          await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)))
          return startSingleVideo(p, retryCount + 1)
        }
        setVideoLoading(prev => ({ ...prev, [p.id]: false }))
      }
    }

    // Start ALL participants (speakers + listeners) in parallel
    await Promise.all(meetingData.participants.map(p => startSingleVideo(p)))

    playStartRef.current = Date.now() - (startOffset * 1000)
    console.log(`[PLAY] All started from memory, playStartRef=${playStartRef.current}`)
  }, [meetingData])

  // Notify server of join
  const updateState = useCallback(async (action: string) => {
    await fetch('/api/meeting', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: meetingId, action }),
    }).catch(() => {})
  }, [meetingId])

  // Handle join — requires user click (browser autoplay policy)
  const handleJoin = useCallback(() => {
    // Unlock audio context with BOTH methods (required by browsers)
    const el = audioElRef.current
    if (el) {
      el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='
      el.play().catch(() => {})
    }
    try {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      osc.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.01)
      setTimeout(() => ctx.close(), 100)
    } catch {}
    setJoined(true)
    updateState('clientJoin')
  }, [updateState])

  // After joining: wait for video elements to mount, then start playback
  useEffect(() => {
    if (!joined || !meetingData || playStartRef.current !== 0) return
    let cancelled = false
    let attempts = 0
    const speakers = meetingData.participants.filter(p => (p.role || 'speaker') === 'speaker')
    const listeners = meetingData.participants.filter(p => p.role === 'listener')

    const tryStart = () => {
      if (cancelled) return
      // Check speakers have main video refs, listeners have idle video refs
      const speakerRefs = speakers.map(p => videoRefs.current[p.id]).filter(Boolean)
      const listenerRefs = listeners.map(p => idleVideoRefs.current[p.id]).filter(Boolean)
      const ready = speakerRefs.length === speakers.length && listenerRefs.length === listeners.length
      console.log(`[MEETING] tryStart attempt=${attempts}, speakers=${speakerRefs.length}/${speakers.length}, listeners=${listenerRefs.length}/${listeners.length}`)

      if (ready) {
        console.log(`[MEETING] All refs ready — starting videos`)
        startAllVideos()
      } else if (attempts < 100) {
        attempts++
        setTimeout(tryStart, 150)
      } else {
        console.error('[MEETING] Gave up waiting for video refs')
      }
    }

    const t = setTimeout(tryStart, 400)
    return () => { cancelled = true; clearTimeout(t) }
  }, [joined, meetingData, startAllVideos])

  // Start idle videos immediately after join (for crossfade during scenario)
  useEffect(() => {
    if (!joined || !meetingData) return
    let cancelled = false

    const startIdles = () => {
      if (cancelled) return
      meetingData.participants.forEach(p => {
        const idleVid = idleVideoRefs.current[p.id]
        if (idleVid && idleVid.paused) {
          idleVid.volume = 0
          idleVid.muted = true
          idleVid.loop = true
          idleVid.play().catch(() => {})
          console.log(`[IDLE] ${p.name}: idle video started for crossfade`)
        }
      })
    }

    // Give time for idle video elements to mount + blob URLs to be set
    const t = setTimeout(startIdles, 1500)
    // Retry a few times in case idle videos load later
    const t2 = setTimeout(startIdles, 5000)
    const t3 = setTimeout(startIdles, 10000)
    return () => { cancelled = true; clearTimeout(t); clearTimeout(t2); clearTimeout(t3) }
  }, [joined, meetingData, idleBlobUrls])

  // Watchdog: monitor videos every 3s
  // During scenario: restart paused/stalled/errored videos, preserve sync
  // After scenario: FORCE volume=0 (AI must NEVER speak), keep idle videos playing
  useEffect(() => {
    if (!joined || !meetingData || playStartRef.current === 0) return
    const watchdog = setInterval(() => {
      if (meetingEndedRef.current) {
        // SAFETY NET: force all AI videos silent + keep idle videos looping
        meetingData.participants.forEach(p => {
          const mainVid = videoRefs.current[p.id]
          const idleVid = idleVideoRefs.current[p.id]
          if (mainVid && mainVid.volume > 0) { mainVid.volume = 0; console.warn(`[WATCHDOG] Force-muted ${p.name} main`) }
          if (idleVid) {
            if (idleVid.volume > 0) idleVid.volume = 0
            if (!idleVid.loop) idleVid.loop = true
            if (idleVid.paused && idleVid.readyState >= 2) {
              idleVid.play().catch(() => {})
              console.log(`[WATCHDOG] ${p.name}: restarted idle video`)
            }
          }
        })
        return
      }
      meetingData.participants.forEach(p => {
        const isSpeakerRole = (p.role || 'speaker') === 'speaker'
        // Speakers: watch main video. Listeners: watch idle video.
        const vid = isSpeakerRole ? videoRefs.current[p.id] : null
        const idleVid = idleVideoRefs.current[p.id]

        // Keep main video playing (speakers)
        if (vid) {
          if (vid.paused && vid.readyState >= 2) {
            console.warn(`[WATCHDOG] ${p.name}: main paused, restarting...`)
            vid.play().catch(() => {})
          }
          if (vid.error) {
            console.warn(`[WATCHDOG] ${p.name}: main error ${vid.error.code}, reloading...`)
            const savedTime = vid.currentTime
            const src = vid.src
            vid.src = ''
            vid.src = src
            vid.load()
            setTimeout(() => {
              if (savedTime > 0 && vid.duration > 0) vid.currentTime = Math.min(savedTime, vid.duration)
              vid.play().catch(() => {})
            }, 2000)
          }
          if (vid.readyState < 2 && !vid.paused) {
            console.warn(`[WATCHDOG] ${p.name}: main buffering (readyState=${vid.readyState})`)
          }
        }

        // Keep idle video playing (all participants — listeners always, speakers after scenario)
        if (idleVid && idleVid.paused && idleVid.readyState >= 2) {
          if (!isSpeakerRole || meetingEndedRef.current) {
            idleVid.loop = true
            idleVid.muted = true
            idleVid.play().catch(() => {})
            console.log(`[WATCHDOG] ${p.name}: idle restarted`)
          }
        }
      })
    }, 3000)
    return () => clearInterval(watchdog)
  }, [joined, meetingData])


  // --- LOADING ---
  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#1a1a2e]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-4 border-[#5b5fc7] border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">Chargement de la reunion...</p>
        </div>
      </div>
    )
  }

  // --- ERROR ---
  if (loadError || !meetingData) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#1a1a2e]">
        <div className="flex flex-col items-center gap-4">
          <div className="text-4xl">❌</div>
          <h1 className="text-xl font-semibold text-white">Reunion introuvable</h1>
          <p className="text-gray-400 text-sm">{loadError || 'Ce lien de reunion est invalide ou a expire.'}</p>
        </div>
      </div>
    )
  }

  // --- JOIN / LOBBY SCREEN ---
  if (!joined) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#1a1a2e]">
        <audio ref={audioElRef} />
        <div className="flex flex-col items-center gap-6 max-w-md text-center px-4">
          <svg viewBox="0 0 24 24" className="w-16 h-16" fill="none">
            <path d="M20.5 6h-3.5V4.5A1.5 1.5 0 0015.5 3h-7A1.5 1.5 0 007 4.5V6H3.5A1.5 1.5 0 002 7.5v9A1.5 1.5 0 003.5 18H7v1.5A1.5 1.5 0 008.5 21h7a1.5 1.5 0 001.5-1.5V18h3.5a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0020.5 6z" fill="#5b5fc7"/>
            <path d="M9.5 8h5v2h-2v5h-1v-5h-2V8z" fill="white"/>
          </svg>

          <h1 className="text-2xl font-semibold text-white">{meetingData.title}</h1>

          <div className="flex flex-wrap justify-center gap-2">
            {meetingData.participants.map(p => (
              <div key={p.id} className="flex items-center gap-2 bg-[#2d2c2c] rounded-full px-3 py-1">
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ background: p.color }}>
                  {p.name.charAt(0)}
                </div>
                <span className="text-xs text-gray-300">{p.name}</span>
              </div>
            ))}
          </div>

          <p className="text-gray-400 text-sm">
            {meetingData.participants.length} participant{meetingData.participants.length > 1 ? 's' : ''} IA + vous
          </p>

          {!preloadDone && (
            <div className="w-full max-w-[280px]">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-gray-400">Preparation de la reunion...</span>
                <span className="text-[11px] text-[#5b5fc7] font-medium">{preloadProgress}%</span>
              </div>
              <div className="w-full h-1.5 bg-[#2a2a2a] rounded-full overflow-hidden">
                <div className="h-full bg-[#5b5fc7] rounded-full transition-all duration-300" style={{ width: `${preloadProgress}%` }} />
              </div>
            </div>
          )}

          <input
            type="text"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="Votre nom..."
            className="w-full max-w-[260px] bg-[#201f1f] text-white text-center text-sm rounded-lg px-4 py-2.5 outline-none border border-[#383838] focus:border-[#5b5fc7] placeholder-gray-500"
          />

          <button
            onClick={handleJoin}
            disabled={!preloadDone}
            className={`font-semibold px-10 py-3.5 rounded-lg text-[16px] transition-colors shadow-lg ${
              !preloadDone
                ? 'bg-gray-600 text-gray-400 cursor-not-allowed shadow-none'
                : 'bg-[#5b5fc7] hover:bg-[#4a4eb5] text-white shadow-[#5b5fc7]/30'
            }`}
          >
            {preloadDone ? 'Rejoindre la reunion' : 'Chargement...'}
          </button>
        </div>
      </div>
    )
  }

  // --- MEETING VIEW ---
  const totalTiles = meetingData.participants.length + 1 // AI tiles + client tile
  const getResponsiveCols = () => {
    if (typeof window === 'undefined') return 3
    const w = window.innerWidth
    if (w < 640) return totalTiles <= 2 ? 1 : 2
    if (w < 1024) return totalTiles <= 2 ? 2 : 2
    return totalTiles <= 2 ? 2 : totalTiles <= 4 ? 2 : totalTiles <= 6 ? 3 : 4
  }
  const cols = getResponsiveCols()

  return (
    <div className="h-screen flex flex-col bg-[#201f1f] overflow-hidden">
      <audio ref={audioElRef} />

      {/* Top bar */}
      <div className="h-[44px] sm:h-[48px] bg-[#292828] flex items-center px-2 sm:px-3 border-b border-[#383838]">
        <div className="w-[40px] sm:w-[68px] flex items-center justify-center">
          <svg viewBox="0 0 24 24" className="w-5 h-5 sm:w-6 sm:h-6" fill="none">
            <path d="M20.5 6h-3.5V4.5A1.5 1.5 0 0015.5 3h-7A1.5 1.5 0 007 4.5V6H3.5A1.5 1.5 0 002 7.5v9A1.5 1.5 0 003.5 18H7v1.5A1.5 1.5 0 008.5 21h7a1.5 1.5 0 001.5-1.5V18h3.5a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0020.5 6z" fill="#5b5fc7"/>
            <path d="M9.5 8h5v2h-2v5h-1v-5h-2V8z" fill="white"/>
          </svg>
        </div>
        <div className="flex-1 flex justify-center items-center gap-2 sm:gap-3 min-w-0">
          <span className="text-[11px] sm:text-[13px] text-gray-300 font-medium truncate">{meetingData.title}</span>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          {scenarioStatus && (
            <span className="text-[10px] sm:text-[11px] text-[#5b5fc7] font-medium truncate max-w-[100px] sm:max-w-none">{scenarioStatus}</span>
          )}
          <MoreHorizontal className="w-4 h-4 sm:w-5 sm:h-5 text-gray-500 cursor-pointer" />
        </div>
      </div>

      {/* Audio blocked banner */}
      {audioBlocked && (
        <button
          onClick={() => {
            if (meetingData) {
              meetingData.participants.forEach(p => {
                const vid = videoRefs.current[p.id]
                if (vid) vid.muted = false
              })
            }
            setAudioBlocked(false)
          }}
          className="w-full bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium py-2 px-4 flex items-center justify-center gap-2 transition-colors"
        >
          <Mic className="w-4 h-4" />
          Cliquez ici pour activer le son
        </button>
      )}

      {/* Main layout */}
      <div className="flex-1 flex flex-col">
        <MeetingToolbar
          isMuted={true}
          isVideoOff={true}
          onToggleMute={() => {}}
          onToggleVideo={() => {}}
          onToggleChat={() => { setShowChat(!showChat); setShowParticipants(false) }}
          onToggleParticipants={() => { setShowParticipants(!showParticipants); setShowChat(false) }}
          participantCount={totalTiles}
          elapsed={elapsed}
        />

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 bg-[#201f1f] flex items-center justify-center p-1 sm:p-2 md:p-4">
            <div
              className="grid gap-1 sm:gap-2 w-full h-full auto-rows-fr"
              style={{
                gridTemplateColumns: `repeat(${cols}, 1fr)`,
                maxWidth: totalTiles <= 2 ? '900px' : totalTiles <= 4 ? '1100px' : '100%',
                alignContent: 'center',
              }}
            >
              {/* AI Participant tiles — ALL cameras always visible like a real meeting */}
              {meetingData.participants.map((p) => {
                const isSpeakerRole = (p.role || 'speaker') === 'speaker'
                const isSpeaking = !meetingEnded && speakingId === p.id && isSpeakerRole
                return (
                  <div
                    key={p.id}
                    className={`relative rounded-lg overflow-hidden transition-all duration-300 ${
                      isSpeaking ? 'ring-2 ring-green-500 z-10' : 'ring-1 ring-[#3b3b3b]'
                    }`}
                    style={{ backgroundColor: '#1a1a1a', aspectRatio: '16/9' }}
                  >
                    {/* Main video (speakers) — ALWAYS visible, plays continuously */}
                    {isSpeakerRole && (
                      <video
                        ref={el => { videoRefs.current[p.id] = el }}
                        src={videoBlobUrls[p.id] || p.videoUrl}
                        preload="auto"
                        playsInline
                        loop={!meetingEnded}
                        crossOrigin="anonymous"
                        className="absolute inset-0 w-full h-full object-cover"
                        style={{ opacity: 1 }}
                      />
                    )}
                    {/* Idle video — for listeners: always visible. For speakers: hidden behind main, shown after scenario ends */}
                    {(idleBlobUrls[p.id] || (!isSpeakerRole && p.idleVideoUrl)) && (
                      <video
                        ref={el => { idleVideoRefs.current[p.id] = el }}
                        src={idleBlobUrls[p.id] || p.idleVideoUrl}
                        preload="auto"
                        playsInline
                        muted
                        loop
                        crossOrigin="anonymous"
                        className="absolute inset-0 w-full h-full object-cover"
                        style={{
                          // Listeners: idle always on top. Speakers: idle on top only after scenario ends
                          opacity: !isSpeakerRole ? 1 : (meetingEnded ? 1 : 0),
                          zIndex: !isSpeakerRole ? 2 : (meetingEnded ? 2 : 0),
                          transition: 'opacity 1s ease-in-out',
                          pointerEvents: 'none',
                        }}
                      />
                    )}
                    {/* Fallback for listeners with no idle video yet */}
                    {!idleBlobUrls[p.id] && !isSpeakerRole && !p.idleVideoUrl && (
                      <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a1a]">
                        <div className="w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-bold" style={{ background: p.color }}>
                          {p.name.charAt(0)}
                        </div>
                      </div>
                    )}

                    {/* Loading overlay */}
                    {videoLoading[p.id] && (
                      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[#1a1a1a]/80">
                        <div className="w-8 h-8 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                        <span className="text-[11px] text-gray-400 mt-2">Chargement...</span>
                      </div>
                    )}

                    {/* Name label */}
                    <div className="absolute bottom-0 left-0 right-0 z-20">
                      <div className="flex items-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent px-3 py-2">
                        <div className={`rounded-full p-0.5 ${!isSpeaking ? 'bg-red-600' : ''}`}>
                          {!isSpeaking
                            ? <MicOff className="w-3 h-3 text-white" />
                            : <Mic className="w-3 h-3 text-white" />
                          }
                        </div>
                        <span className="text-[13px] text-white font-medium drop-shadow-sm">{p.name}</span>
                      </div>
                    </div>
                  </div>
                )
              })}

              {/* Client tile — initials only, no camera, mic always muted */}
              <div
                className="relative rounded-lg overflow-hidden ring-1 ring-[#3b3b3b]"
                style={{ backgroundColor: '#2d2d2d', aspectRatio: '16/9' }}
              >
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-16 h-16 rounded-full bg-[#5b5fc7] flex items-center justify-center text-white text-xl font-bold">
                    {displayName.charAt(0).toUpperCase()}
                  </div>
                </div>
                <div className="absolute bottom-0 left-0 right-0 z-20">
                  <div className="flex items-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent px-3 py-2">
                    <div className="rounded-full p-0.5 bg-red-600">
                      <MicOff className="w-3 h-3 text-white" />
                    </div>
                    <span className="text-[13px] text-white font-medium drop-shadow-sm">{displayName} (Vous)</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Side panel */}
          {(showChat || showParticipants) && (
            <div className="absolute right-0 top-[44px] sm:top-[48px] bottom-0 w-full sm:w-[320px] sm:relative sm:top-0 z-30 bg-[#2d2c2c] border-l border-[#383838] flex flex-col">
              <div className="flex items-center justify-between px-4 py-3 border-b border-[#383838]">
                <h3 className="text-[14px] font-semibold text-white">
                  {showParticipants ? `Participants (${totalTiles})` : 'Conversation'}
                </h3>
                <button onClick={() => { setShowChat(false); setShowParticipants(false) }} className="hover:bg-[#3a3a3a] p-1 rounded">
                  <X className="w-4 h-4 text-gray-400" />
                </button>
              </div>
              {showParticipants && (
                <div className="flex-1 overflow-y-auto p-2">
                  {meetingData.participants.map(p => (
                    <div key={p.id} className="flex items-center gap-3 py-2 px-3 rounded-md hover:bg-[#3a3a3a]">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold text-white flex-shrink-0" style={{ background: p.color }}>
                        {p.name.charAt(0)}
                      </div>
                      <span className="text-[13px] text-gray-300">{p.name}</span>
                      {(p.role || 'speaker') === 'listener' && (
                        <span className="text-[10px] text-gray-500 ml-auto">Observateur</span>
                      )}
                    </div>
                  ))}
                  <div className="flex items-center gap-3 py-2 px-3 rounded-md hover:bg-[#3a3a3a]">
                    <div className="w-8 h-8 rounded-full bg-[#5b5fc7] flex items-center justify-center text-sm font-semibold text-white flex-shrink-0">
                      {displayName.charAt(0).toUpperCase()}
                    </div>
                    <span className="text-[13px] text-gray-300">{displayName} (Vous)</span>
                  </div>
                </div>
              )}
              {showChat && (
                <div className="flex-1 flex flex-col">
                  <div className="flex-1 overflow-y-auto p-3">
                    <div className="text-center text-gray-500 text-[13px] mt-10">Aucun message</div>
                  </div>
                  <div className="p-3 border-t border-[#383838]">
                    <input type="text" placeholder="Saisissez un message..." className="w-full bg-[#201f1f] text-gray-300 text-[13px] rounded-md px-3 py-2 outline-none border border-[#383838] focus:border-[#5b5fc7] placeholder-gray-600" />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function MeetingRoom() {
  return (
    <Suspense fallback={
      <div className="h-screen flex items-center justify-center bg-[#1a1a2e]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-4 border-[#5b5fc7] border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">Chargement de la reunion...</p>
        </div>
      </div>
    }>
      <MeetingRoomInner />
    </Suspense>
  )
}
