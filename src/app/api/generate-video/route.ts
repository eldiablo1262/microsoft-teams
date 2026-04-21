import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export const runtime = 'nodejs'
export const maxDuration = 7200 // 2h max per request

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || ''
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN || ''

const VOICE_OPTIONS: Record<string, { label: string; gender: string }> = {
  'TX3LPaxmHKxFdv7VOQHJ': { label: 'Liam (homme FR)', gender: 'male' },
  'bIHbv24MWmeRgasZH58o': { label: 'Will (homme FR)', gender: 'male' },
  'N2lVS1w4EtoT3dr4eOWO': { label: 'Callum (homme FR)', gender: 'male' },
  'ErXwobaYiN019PkySvjV': { label: 'Antoni (homme FR)', gender: 'male' },
  'EXAVITQu4vr4xnSDxMaL': { label: 'Sarah (femme FR)', gender: 'female' },
  'XB0fDUnXU5powFXDhCwa': { label: 'Charlotte (femme FR)', gender: 'female' },
  'FGY2WhTYpPnrIDTdsKH5': { label: 'Laura (femme FR)', gender: 'female' },
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// Build a WAV data URI from raw PCM 16-bit mono data at given sample rate
function buildWav(pcmData: Buffer, sampleRate = 16000): string {
  const dataSize = pcmData.length
  const headerSize = 44
  const buf = Buffer.alloc(headerSize + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)  // PCM
  buf.writeUInt16LE(1, 22)  // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  pcmData.copy(buf, headerSize)
  return `data:audio/wav;base64,${buf.toString('base64')}`
}

// Generate a silent WAV audio as base64 data URI
function generateSilentAudio(durationSec = 3): string {
  const sampleRate = 16000
  const pcm = Buffer.alloc(sampleRate * 2 * durationSec) // all zeros = silence
  return buildWav(pcm, sampleRate)
}

// Pad raw PCM audio with silence before and after (natural transition)
function padPcmWithSilence(pcmData: Buffer, sampleRate: number, beforeSec: number, afterSec: number): Buffer {
  const silenceBefore = Buffer.alloc(sampleRate * 2 * beforeSec)
  const silenceAfter = Buffer.alloc(sampleRate * 2 * afterSec)
  return Buffer.concat([silenceBefore, pcmData, silenceAfter])
}

export async function GET() {
  return NextResponse.json({ voices: VOICE_OPTIONS })
}

export async function POST(request: NextRequest) {
  if (!ELEVENLABS_KEY) return NextResponse.json({ error: 'ELEVENLABS_API_KEY not set' }, { status: 500 })
  if (!REPLICATE_TOKEN) return NextResponse.json({ error: 'REPLICATE_API_TOKEN not set' }, { status: 500 })

  try {
    const body = await request.json()
    const { text, voiceId, photoBase64: rawB64, photoPath, prompt, filename, silent, audioPath, audioBase64: rawAudioB64 } = body

    // Support either direct base64 or a file path (uploaded via /api/upload-photo)
    let photoBase64 = rawB64
    if (!photoBase64 && photoPath) {
      const absPath = path.join(process.cwd(), 'public', photoPath)
      if (fs.existsSync(absPath)) {
        const buf = fs.readFileSync(absPath)
        photoBase64 = `data:image/jpeg;base64,${buf.toString('base64')}`
        console.log(`[GEN] Photo loaded from disk: ${photoPath} (${(buf.length / 1024).toFixed(0)} KB)`)
      } else {
        return NextResponse.json({ error: `Photo not found: ${photoPath}` }, { status: 400 })
      }
    }

    if (!photoBase64) {
      return NextResponse.json({ error: 'Missing photo (photoBase64 or photoPath)' }, { status: 400 })
    }

    // Pre-resolved audio base64 (sent directly from frontend — survives Railway redeploys)
    let preResolvedAudioB64 = rawAudioB64 || null

    const videoPrompt = prompt || 'Continuous uninterrupted webcam shot, head and shoulders framing, fixed camera with no movement. A person is in a live professional video conference call. CRITICAL RULE: The person MUST keep their mouth COMPLETELY CLOSED and STILL during ALL silent/quiet sections of the audio. Absolutely ZERO lip movement, ZERO jaw movement, ZERO mouth opening when there is no speech audio. The lips must remain pressed together naturally as if the person is simply listening. During these silent periods, the person shows ONLY subtle idle body language: very gentle weight shifts, slow natural head tilts, occasional eyebrow raises, relaxed blinking at varied intervals, subtle chest breathing motion, slight nods as if listening, and minor postural adjustments. All these idle movements flow smoothly so the video never loops. When speech audio begins, the person speaks with precise natural lip sync matching the audio exactly, with natural conversational head motion. Transitions from listening (mouth closed) to speaking (lip sync) must be smooth. The mouth opens ONLY when audio speech is present. Photorealistic webcam quality, soft natural office lighting, shallow depth of field on the background.'

    // Step 1: Generate audio — pre-resolved base64, pre-built file, silent mode, or ElevenLabs TTS
    let audioB64: string
    if (preResolvedAudioB64) {
      // Audio sent directly as base64 from frontend (survives Railway redeploys)
      audioB64 = preResolvedAudioB64
      console.log(`[GEN] Step 1: Audio from base64 (${(audioB64.length / 1024).toFixed(0)} KB)`)
    } else if (audioPath) {
      // Pre-built audio file (from /api/combine-audio) — fallback if base64 not provided
      const absAudioPath = path.join(process.cwd(), 'public', audioPath)
      if (!fs.existsSync(absAudioPath)) {
        return NextResponse.json({ error: `WAV file not found: ${audioPath}. Use audioBase64 instead.` }, { status: 400 })
      }
      const audioBuf = fs.readFileSync(absAudioPath)
      audioB64 = `data:audio/wav;base64,${audioBuf.toString('base64')}`
      console.log(`[GEN] Step 1: Pre-built audio loaded from ${audioPath} (${(audioBuf.length / 1024).toFixed(0)} KB)`)
    } else if (silent) {
      console.log(`[GEN] Step 1: Silent audio (idle mode)`)
      audioB64 = generateSilentAudio(10)
    } else {
      if (!text || !voiceId) {
        return NextResponse.json({ error: 'Missing text or voiceId for talk mode' }, { status: 400 })
      }
      // Request raw PCM from ElevenLabs so we can add silence padding
      const PCM_RATE = 16000
      console.log(`[GEN] Step 1: ElevenLabs TTS PCM (voice=${voiceId})...`)
      const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_16000`, {
        method: 'POST',
        headers: {
          'Accept': 'application/octet-stream',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_KEY,
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.45, similarity_boost: 0.78, style: 0.35, use_speaker_boost: true },
        }),
      })

      if (!ttsRes.ok) {
        const err = await ttsRes.text()
        return NextResponse.json({ error: `ElevenLabs error: ${err.slice(0, 200)}` }, { status: 500 })
      }

      const rawPcm = Buffer.from(await ttsRes.arrayBuffer())
      console.log(`[GEN] Raw PCM: ${(rawPcm.length / 1024).toFixed(0)} KB (${(rawPcm.length / PCM_RATE / 2).toFixed(1)}s)`)

      // Pad with 0.8s silence before (listening → about to speak) and 0.6s after (finishing → back to listening)
      const paddedPcm = padPcmWithSilence(rawPcm, PCM_RATE, 0.8, 0.6)
      audioB64 = buildWav(paddedPcm, PCM_RATE)
      console.log(`[GEN] Audio padded: +0.8s before, +0.6s after → ${(paddedPcm.length / PCM_RATE / 2).toFixed(1)}s total`)
    }

    // Step 2: Create prediction on Replicate (returns immediately — no waiting)
    console.log(`[GEN] Step 2: Creating OmniHuman 1.5 prediction...`)

    const createRes = await fetch('https://api.replicate.com/v1/models/bytedance/omni-human-1.5/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REPLICATE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: { image: photoBase64, audio: audioB64, prompt: videoPrompt },
      }),
    })

    if (!createRes.ok) {
      const errText = await createRes.text()
      console.error(`[GEN] Replicate create error ${createRes.status}:`, errText.slice(0, 300))
      if (createRes.status === 402) {
        return NextResponse.json({ error: 'Crédit Replicate insuffisant. Recharge sur replicate.com/account/billing' }, { status: 402 })
      }
      return NextResponse.json({ error: `Replicate error ${createRes.status}: ${errText.slice(0, 150)}` }, { status: 500 })
    }

    const prediction = await createRes.json()
    console.log(`[GEN] Prediction ${prediction.id} created — returning immediately`)

    // Return prediction ID immediately — frontend will poll via /api/check-prediction
    return NextResponse.json({
      success: true,
      predictionId: prediction.id,
      status: 'starting',
      filename: filename || `gen-${Date.now()}.mp4`,
    })
  } catch (err: any) {
    console.error('[GEN] Error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
