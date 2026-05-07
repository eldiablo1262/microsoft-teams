import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
// WAN 2.7 is the default model — excellent lip-sync

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

// Generate ambient noise WAV (NOT pure silence — WAN 2.7 rejects all-zeros with E006)
// Low-level random noise prevents model from auto-generating speech audio
function generateAmbientAudio(durationSec = 5): string {
  const sampleRate = 16000
  const numSamples = sampleRate * durationSec
  const pcm = Buffer.alloc(numSamples * 2)
  for (let i = 0; i < numSamples; i++) {
    // Very low amplitude noise: -20 to +20 out of 32768 range (~0.06%)
    const noise = Math.round((Math.random() - 0.5) * 40)
    pcm.writeInt16LE(noise, i * 2)
  }
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
    const { text, voiceId, photoBase64: rawB64, photoPath, prompt, filename, silent, audioPath, audioBase64: rawAudioB64, wanModel } = body

    // Select model — default to WAN 2.5 (best lip-sync + audio up to 30s)
    const MODEL_MAP: Record<string, { endpoint: string; imageField: string }> = {
      'wan-2.5': { endpoint: 'wan-video/wan-2.5-i2v', imageField: 'image' },
      'wan-2.7': { endpoint: 'wan-video/wan-2.7-i2v', imageField: 'first_frame' },
      'wan-2.6': { endpoint: 'wan-video/wan-2.6-i2v', imageField: 'image' },
      'wan-2.2': { endpoint: 'wan-video/wan-2.2-s2v', imageField: 'image' },
    }
    const selectedModel = MODEL_MAP[wanModel] || MODEL_MAP['wan-2.5']

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

    // Separate prompts for speaking vs idle — critical for lip-sync accuracy
    const SPEAKING_PROMPT = 'A person speaking naturally in a video call. Natural lip sync with the audio. Relaxed natural eyes, never wide open, comfortable gaze. Webcam framing head and shoulders, fixed camera. Photorealistic, soft office lighting.'
    const IDLE_PROMPT = 'A person in a professional video conference call, webcam framing head and shoulders, fixed camera. The person is actively LISTENING — mouth fully CLOSED at all times, lips together, NO mouth movement whatsoever. Relaxed natural eyes, never wide open, comfortable half-lidded gaze, slow blinks, very subtle head tilts, gentle breathing motion, occasional small nods. The person stays still and attentive with mouth shut. Photorealistic quality, soft office lighting.'
    const videoPrompt = prompt || (silent ? IDLE_PROMPT : SPEAKING_PROMPT)

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
      console.log(`[GEN] Step 1: Idle mode — no audio needed`)
      audioB64 = '' // placeholder — idle clips don't send audio to WAN 2.7
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

    // Step 2: Audio preparation
    // Idle: NO audio — rely on prompt + negative_prompt + crossfade to keep mouth closed
    // Speaking: WAN 2.7 requires audio ≥ 3 seconds for lip-sync to activate
    let audioInput: string | null = null
    let audioDurationSec = 5
    // WAN 2.5 only accepts duration 5 or 10; WAN 2.7 accepts 2-15
    const snapDuration = (dur: number, model: string): number => {
      if (model === 'wan-2.5') return dur <= 7 ? 5 : 10
      return Math.min(15, Math.max(2, Math.ceil(dur)))
    }

    if (silent) {
      audioInput = null // No audio for idle — avoids E006 and DataInspectionFailed
      const silDur = body.silentDuration || 10
      audioDurationSec = snapDuration(silDur, wanModel || 'wan-2.5')
      console.log(`[GEN] Step 2: Idle mode → no audio, duration=${audioDurationSec}s`)
    } else {
      // Decode audio to check/pad duration — WAN 2.7 needs minimum 3s audio
      const b64Data = audioB64.includes(',') ? audioB64.split(',')[1] : audioB64
      const audioBuf = Buffer.from(b64Data, 'base64')
      const PCM_RATE_CHECK = 16000
      const pcmBytes = audioBuf.length - 44 // subtract WAV header
      const audioSec = pcmBytes / (PCM_RATE_CHECK * 2)
      const MIN_AUDIO_SEC = 3 // WAN 2.7 minimum for lip-sync activation

      if (audioSec < MIN_AUDIO_SEC) {
        // Pad audio with silence to reach 3 seconds minimum
        const neededSamples = Math.ceil((MIN_AUDIO_SEC - audioSec) * PCM_RATE_CHECK)
        const silencePad = Buffer.alloc(neededSamples * 2) // 16-bit zeros
        const existingPcm = audioBuf.subarray(44) // strip header
        const paddedPcm = Buffer.concat([existingPcm, silencePad])
        audioInput = buildWav(paddedPcm, PCM_RATE_CHECK)
        audioDurationSec = snapDuration(MIN_AUDIO_SEC, wanModel || 'wan-2.5')
        console.log(`[GEN] Step 2: Audio padded ${audioSec.toFixed(1)}s → ${MIN_AUDIO_SEC}s (min for lip-sync)`)
      } else {
        audioInput = audioB64
        audioDurationSec = snapDuration(audioSec, wanModel || 'wan-2.5')
        console.log(`[GEN] Step 2: Audio ready ${audioSec.toFixed(1)}s → duration=${audioDurationSec}s (${(audioBuf.length / 1024).toFixed(0)} KB)`)
      }
    }

    // Step 3: Create prediction on Replicate with retry
    console.log(`[GEN] Step 3: Creating ${wanModel || 'wan-2.7'} prediction (${selectedModel.endpoint}), duration=${audioDurationSec}s...`)

    const MAX_RETRIES = 3
    let prediction: any = null
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const inputPayload: Record<string, any> = {
          [selectedModel.imageField]: photoBase64,
          prompt: videoPrompt,
        }

        if (wanModel === 'wan-2.2') {
          // WAN 2.2 s2v: just image + audio, model handles everything
          if (audioInput) inputPayload.audio = audioInput
        } else {
          // WAN 2.5 / 2.7 i2v: audio drives lip-sync natively
          if (audioInput) {
            inputPayload.audio = audioInput
          }
          // WAN 2.5 supports audio up to 30s — set duration to match audio
          inputPayload.duration = audioDurationSec
          inputPayload.resolution = '720p'
          if (silent) {
            inputPayload.negative_prompt = 'speaking, talking, open mouth, lip movement, mouth movement, wide eyes, staring, surprised expression'
          } else {
            inputPayload.negative_prompt = 'wide eyes, staring, surprised expression, bug eyes, unnatural eyes'
          }
          // WAN 2.5: disable prompt expansion so audio drives lip-sync
          inputPayload.enable_prompt_expansion = false
        }
        const createRes = await fetch(`https://api.replicate.com/v1/models/${selectedModel.endpoint}/predictions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${REPLICATE_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ input: inputPayload }),
        })

        if (createRes.ok) {
          prediction = await createRes.json()
          console.log(`[GEN] Prediction ${prediction.id} created (attempt ${attempt})`)
          break
        }

        const errText = await createRes.text()
        console.error(`[GEN] Replicate error ${createRes.status} (attempt ${attempt}/${MAX_RETRIES}):`, errText.slice(0, 200))

        if (createRes.status === 402) {
          return NextResponse.json({ error: 'Crédit Replicate insuffisant. Recharge sur replicate.com/account/billing' }, { status: 402 })
        }

        if (attempt < MAX_RETRIES) {
          const waitSec = attempt * 10
          console.log(`[GEN] Retrying in ${waitSec}s...`)
          await sleep(waitSec * 1000)
        } else {
          return NextResponse.json({ error: `Replicate error after ${MAX_RETRIES} attempts: ${errText.slice(0, 150)}` }, { status: 500 })
        }
      } catch (fetchErr: any) {
        console.error(`[GEN] Fetch error (attempt ${attempt}/${MAX_RETRIES}):`, fetchErr.message)
        if (attempt < MAX_RETRIES) {
          const waitSec = attempt * 10
          console.log(`[GEN] Retrying in ${waitSec}s...`)
          await sleep(waitSec * 1000)
        } else {
          return NextResponse.json({ error: `Network error after ${MAX_RETRIES} attempts: ${fetchErr.message}` }, { status: 500 })
        }
      }
    }

    if (!prediction) {
      return NextResponse.json({ error: 'Failed to create prediction after retries' }, { status: 500 })
    }

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
