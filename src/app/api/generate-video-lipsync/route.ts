import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export const runtime = 'nodejs'
export const maxDuration = 7200

const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN || ''

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// Upload a data URI to Replicate's file hosting → returns a hosted URL
async function uploadToReplicate(dataUri: string): Promise<string> {
  // Extract mime type and base64 data
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('Invalid data URI')
  const mimeType = match[1]
  const buffer = Buffer.from(match[2], 'base64')

  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp4') ? 'mp4' : 'bin'
  const fname = `upload-${Date.now()}.${ext}`

  // Replicate files API requires multipart/form-data with a "content" field
  const blob = new Blob([buffer], { type: mimeType })
  const formData = new FormData()
  formData.append('content', blob, fname)

  const res = await fetch('https://api.replicate.com/v1/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_TOKEN}`,
    },
    body: formData,
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Upload failed: ${err.slice(0, 200)}`)
  }

  const data = await res.json()
  console.log(`[LIPSYNC] Uploaded ${ext} to Replicate: ${data.urls?.get?.slice(0, 60)}...`)
  return data.urls?.get
}

// Step 1: Generate a short base video with WAN 2.7 (with SPEAKING motion)
// Step 2: Apply lipsync-2-pro to the base video + full audio → one continuous lip-synced video

export async function POST(request: NextRequest) {
  if (!REPLICATE_TOKEN) return NextResponse.json({ error: 'REPLICATE_API_TOKEN not set' }, { status: 500 })

  try {
    const body = await request.json()
    const { photoBase64, audioBase64, filename, silent } = body

    if (!photoBase64) return NextResponse.json({ error: 'Missing photoBase64' }, { status: 400 })

    // ==========================================
    // STEP 1: Generate base video with WAN 2.7
    // ==========================================
    // IMPORTANT: lipsync-2-pro needs a video with MOUTH MOVEMENT as input
    // A static/idle video produces artifacts ("chchch")
    const basePrompt = silent
      ? 'A person sitting in a video conference call, webcam framing head and shoulders, fixed camera. The person is listening calmly with mouth closed, relaxed natural eyes never wide open, comfortable half-lidded gaze, natural subtle movements, slow blinks, gentle breathing. Photorealistic, soft office lighting.'
      : 'A person talking and speaking naturally in a video conference call, webcam framing head and shoulders, fixed camera. Mouth opens and closes with natural talking motion, active lip movement, relaxed natural eyes never wide open, comfortable gaze. Photorealistic, soft office lighting.'

    console.log(`[LIPSYNC] Step 1: Generating base video with WAN 2.5 (${silent ? 'idle' : 'speaking-base'})...`)

    const basePayload: Record<string, any> = {
      image: photoBase64,
      prompt: basePrompt,
      duration: 10, // base video — lipsync-2-pro will loop it (longer = fewer loop seams = less chchch)
      resolution: '720p',
      enable_prompt_expansion: false,
    }

    // For idle mode, no lip-sync needed — just return the base video
    if (silent) {
      basePayload.negative_prompt = 'speaking, talking, open mouth, lip movement, wide eyes, staring, surprised expression'
    } else {
      basePayload.negative_prompt = 'wide eyes, staring, surprised expression, bug eyes, unnatural eyes'
    }

    let basePrediction: any = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch('https://api.replicate.com/v1/models/wan-video/wan-2.5-i2v/predictions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${REPLICATE_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: basePayload }),
        })
        if (res.ok) {
          basePrediction = await res.json()
          console.log(`[LIPSYNC] Base prediction ${basePrediction.id} created (attempt ${attempt})`)
          break
        }
        const err = await res.text()
        console.error(`[LIPSYNC] WAN 2.7 error (attempt ${attempt}):`, err.slice(0, 200))
        if (res.status === 402) return NextResponse.json({ error: 'Crédit Replicate insuffisant' }, { status: 402 })
        if (attempt < 3) await sleep(attempt * 10000)
      } catch (e: any) {
        console.error(`[LIPSYNC] WAN 2.7 fetch error (attempt ${attempt}):`, e.message)
        if (attempt < 3) await sleep(attempt * 10000)
      }
    }

    if (!basePrediction) return NextResponse.json({ error: 'Failed to create base video prediction' }, { status: 500 })

    // Poll WAN 2.7 until done
    let baseVideoUrl: string | null = null
    for (let i = 0; i < 120; i++) { // max 10 min
      await sleep(5000)
      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${basePrediction.id}`, {
        headers: { 'Authorization': `Bearer ${REPLICATE_TOKEN}` },
      })
      const pollData = await pollRes.json()

      if (pollData.status === 'succeeded') {
        baseVideoUrl = typeof pollData.output === 'string' ? pollData.output : pollData.output?.[0] || pollData.output?.video
        console.log(`[LIPSYNC] Base video ready: ${baseVideoUrl?.slice(0, 80)}...`)
        break
      }
      if (pollData.status === 'failed' || pollData.status === 'canceled') {
        const errMsg = pollData.error || 'Base video generation failed'
        console.error(`[LIPSYNC] Base video failed:`, errMsg)
        return NextResponse.json({ error: `Base video: ${errMsg}` }, { status: 500 })
      }
      if (i % 6 === 0) console.log(`[LIPSYNC] Base video polling... ${pollData.status} (${i * 5}s)`)
    }

    if (!baseVideoUrl) return NextResponse.json({ error: 'Base video timed out' }, { status: 500 })

    // For idle mode, just return the base video — no lip-sync needed
    if (silent) {
      return NextResponse.json({
        success: true,
        videoUrl: baseVideoUrl,
        filename: filename || `idle-${Date.now()}.mp4`,
        method: 'wan27-idle',
      })
    }

    // ==========================================
    // STEP 2: Apply lipsync-2-pro
    // ==========================================
    if (!audioBase64) return NextResponse.json({ error: 'Missing audioBase64 for speaking mode' }, { status: 400 })

    console.log(`[LIPSYNC] Step 2: Uploading audio to Replicate...`)

    // Upload audio as hosted file — lipsync-2-pro requires URLs, not data URIs
    let audioUrl: string
    try {
      audioUrl = await uploadToReplicate(audioBase64)
    } catch (uploadErr: any) {
      console.error(`[LIPSYNC] Audio upload failed:`, uploadErr.message)
      return NextResponse.json({ error: `Audio upload: ${uploadErr.message}` }, { status: 500 })
    }

    console.log(`[LIPSYNC] Step 2: Applying lipsync-2-pro (video + audio URL)...`)

    const lipsyncPayload = {
      video: baseVideoUrl, // URL from WAN 2.7 output
      audio: audioUrl,     // Hosted URL on Replicate
      sync_mode: 'loop',   // Loop base video to match audio length
      temperature: 0.5,    // Balanced expressiveness
      active_speaker: false,
    }

    let lipsyncPrediction: any = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch('https://api.replicate.com/v1/models/sync/lipsync-2-pro/predictions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${REPLICATE_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: lipsyncPayload }),
        })
        if (res.ok) {
          lipsyncPrediction = await res.json()
          console.log(`[LIPSYNC] Lipsync prediction ${lipsyncPrediction.id} created (attempt ${attempt})`)
          break
        }
        const err = await res.text()
        console.error(`[LIPSYNC] Lipsync-2-pro error (attempt ${attempt}):`, err.slice(0, 200))
        if (res.status === 402) return NextResponse.json({ error: 'Crédit Replicate insuffisant' }, { status: 402 })
        if (attempt < 3) await sleep(attempt * 10000)
      } catch (e: any) {
        console.error(`[LIPSYNC] Lipsync-2-pro fetch error (attempt ${attempt}):`, e.message)
        if (attempt < 3) await sleep(attempt * 10000)
      }
    }

    if (!lipsyncPrediction) return NextResponse.json({ error: 'Failed to create lipsync prediction' }, { status: 500 })

    // Poll lipsync-2-pro until done
    let finalVideoUrl: string | null = null
    for (let i = 0; i < 180; i++) { // max 15 min
      await sleep(5000)
      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${lipsyncPrediction.id}`, {
        headers: { 'Authorization': `Bearer ${REPLICATE_TOKEN}` },
      })
      const pollData = await pollRes.json()

      if (pollData.status === 'succeeded') {
        finalVideoUrl = typeof pollData.output === 'string' ? pollData.output : pollData.output?.[0] || pollData.output?.video
        console.log(`[LIPSYNC] Final video ready: ${finalVideoUrl?.slice(0, 80)}...`)
        break
      }
      if (pollData.status === 'failed' || pollData.status === 'canceled') {
        const errMsg = pollData.error || 'Lipsync failed'
        console.error(`[LIPSYNC] Lipsync failed:`, errMsg)
        return NextResponse.json({ error: `Lipsync: ${errMsg}` }, { status: 500 })
      }
      if (i % 6 === 0) console.log(`[LIPSYNC] Lipsync polling... ${pollData.status} (${i * 5}s)`)
    }

    if (!finalVideoUrl) return NextResponse.json({ error: 'Lipsync timed out' }, { status: 500 })

    // Download and save locally
    const outDir = path.join(process.cwd(), 'public', 'videos-generated')
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
    const fname = filename || `lipsync-${Date.now()}.mp4`
    const outPath = path.join(outDir, fname)

    const dlRes = await fetch(finalVideoUrl)
    if (dlRes.ok) {
      const buf = Buffer.from(await dlRes.arrayBuffer())
      fs.writeFileSync(outPath, buf)
      console.log(`[LIPSYNC] Saved: ${fname} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`)
    }

    return NextResponse.json({
      success: true,
      videoUrl: `/videos-generated/${fname}`,
      remoteUrl: finalVideoUrl,
      filename: fname,
      method: 'wan27+lipsync2pro',
    })
  } catch (err: any) {
    console.error('[LIPSYNC] Error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
