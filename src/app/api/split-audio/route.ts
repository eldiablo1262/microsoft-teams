import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export const runtime = 'nodejs'

const PCM_RATE = 16000 // 16kHz mono 16-bit

// Build a WAV file buffer from raw PCM data
function buildWavBuffer(pcmData: Buffer): Buffer {
  const dataSize = pcmData.length
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)  // PCM
  header.writeUInt16LE(1, 22)  // mono
  header.writeUInt32LE(PCM_RATE, 24)
  header.writeUInt32LE(PCM_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  return Buffer.concat([header, pcmData])
}

// Split a WAV file into chunks of maxChunkSeconds
// Returns list of chunk WAV paths and their durations
export async function POST(request: NextRequest) {
  try {
    const { wavPath, wavBase64, maxChunkSeconds } = await request.json()
    if (!wavPath && !wavBase64) return NextResponse.json({ error: 'Missing wavPath or wavBase64' }, { status: 400 })

    const maxSec = maxChunkSeconds || 25

    let wavBuf: Buffer
    if (wavBase64) {
      // Audio sent as base64 data URI (survives Railway redeploys)
      const b64Data = wavBase64.includes(',') ? wavBase64.split(',')[1] : wavBase64
      wavBuf = Buffer.from(b64Data, 'base64')
      console.log(`[SPLIT] Audio from base64 (${(wavBuf.length / 1024).toFixed(0)} KB)`)
    } else {
      const absPath = path.join(process.cwd(), 'public', wavPath)
      if (!fs.existsSync(absPath)) {
        return NextResponse.json({ error: `WAV file not found: ${wavPath}` }, { status: 400 })
      }
      wavBuf = fs.readFileSync(absPath)
    }
    // Skip 44-byte WAV header to get raw PCM
    const pcmData = wavBuf.subarray(44)
    const totalDuration = pcmData.length / (PCM_RATE * 2)

    if (totalDuration <= maxSec) {
      // No splitting needed — return the full audio as base64 too
      const fullB64 = `data:audio/wav;base64,${wavBuf.toString('base64')}`
      return NextResponse.json({
        success: true,
        chunks: [{ wavPath: wavPath || 'inline', duration: totalDuration, audioBase64: fullB64 }],
        totalDuration,
      })
    }

    const chunkBytes = Math.floor(maxSec * PCM_RATE * 2)
    const outDir = path.join(process.cwd(), 'public', 'audio-temp')
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

    const chunks: { wavPath: string; duration: number; audioBase64: string }[] = []
    let offset = 0
    let chunkIndex = 0

    while (offset < pcmData.length) {
      const end = Math.min(offset + chunkBytes, pcmData.length)
      const chunkPcm = pcmData.subarray(offset, end)
      const chunkDuration = chunkPcm.length / (PCM_RATE * 2)

      const baseName = wavPath ? path.basename(wavPath, '.wav') : 'inline'
      const fname = `chunk-${baseName}-${chunkIndex}-${Date.now()}.wav`
      const chunkWav = buildWavBuffer(chunkPcm)
      fs.writeFileSync(path.join(outDir, fname), chunkWav)

      // Also return chunk as base64 (survives Railway redeploys)
      const chunkB64 = `data:audio/wav;base64,${chunkWav.toString('base64')}`
      chunks.push({ wavPath: `/audio-temp/${fname}`, duration: chunkDuration, audioBase64: chunkB64 })
      console.log(`[SPLIT] Chunk ${chunkIndex}: ${chunkDuration.toFixed(1)}s (${(chunkWav.length / 1024).toFixed(0)} KB)`)

      offset = end
      chunkIndex++
    }

    console.log(`[SPLIT] ${wavPath || 'inline'} → ${chunks.length} chunks (total ${totalDuration.toFixed(1)}s, max ${maxSec}s each)`)

    return NextResponse.json({ success: true, chunks, totalDuration })
  } catch (err: any) {
    console.error('[SPLIT] Error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
