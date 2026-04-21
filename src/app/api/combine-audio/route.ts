import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export const runtime = 'nodejs'

const PCM_RATE = 16000 // 16kHz mono 16-bit

// Build a WAV file from raw PCM data and save to disk
function saveWav(pcmData: Buffer, outPath: string) {
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

  const fd = fs.openSync(outPath, 'w')
  fs.writeSync(fd, header)
  fs.writeSync(fd, pcmData)
  fs.closeSync(fd)
}

// Combine multiple PCM audio segments into one continuous WAV per participant
// Each participant gets: silence everywhere + their speech at the correct timestamps
export async function POST(request: NextRequest) {
  try {
    const { participantIds, segments, totalDuration } = await request.json()
    // participantIds: string[]
    // segments: { participantId: string, pcmPath: string, startTime: number, duration: number }[]
    // totalDuration: number (seconds)

    if (!participantIds || !segments || !totalDuration) {
      return NextResponse.json({ error: 'Missing participantIds, segments, or totalDuration' }, { status: 400 })
    }

    const totalSamples = Math.ceil(totalDuration * PCM_RATE)
    const totalBytes = totalSamples * 2

    console.log(`[COMBINE] Building ${participantIds.length} audio tracks, total ${totalDuration.toFixed(1)}s (${(totalBytes / 1024).toFixed(0)} KB PCM each)`)

    const outDir = path.join(process.cwd(), 'public', 'audio-temp')
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

    const audioTracks: Record<string, string> = {}
    const audioBase64Map: Record<string, string> = {}

    for (const pid of participantIds) {
      // Create a silent buffer for the full meeting duration
      const track = Buffer.alloc(totalBytes)

      // Copy this participant's speech segments at the right byte offsets
      for (const seg of segments) {
        if (seg.participantId !== pid) continue

        const pcmFilePath = path.join(process.cwd(), 'public', seg.pcmPath)
        if (!fs.existsSync(pcmFilePath)) {
          console.warn(`[COMBINE] PCM file not found: ${seg.pcmPath}`)
          continue
        }

        const pcmData = fs.readFileSync(pcmFilePath)
        const startByte = Math.floor(seg.startTime * PCM_RATE * 2)
        const maxCopy = Math.min(pcmData.length, totalBytes - startByte)

        if (startByte >= 0 && startByte < totalBytes && maxCopy > 0) {
          pcmData.copy(track, startByte, 0, maxCopy)
          console.log(`[COMBINE] ${pid}: speech at ${seg.startTime.toFixed(1)}s (${(pcmData.length / PCM_RATE / 2).toFixed(1)}s)`)
        }
      }

      // Save as WAV
      const fname = `combined-${pid}-${Date.now()}.wav`
      const wavPath = path.join(outDir, fname)
      saveWav(track, wavPath)

      // Build WAV buffer for base64 (same as file, but kept in memory)
      const wavHeader = Buffer.alloc(44)
      wavHeader.write('RIFF', 0)
      wavHeader.writeUInt32LE(36 + track.length, 4)
      wavHeader.write('WAVE', 8)
      wavHeader.write('fmt ', 12)
      wavHeader.writeUInt32LE(16, 16)
      wavHeader.writeUInt16LE(1, 20)
      wavHeader.writeUInt16LE(1, 22)
      wavHeader.writeUInt32LE(PCM_RATE, 24)
      wavHeader.writeUInt32LE(PCM_RATE * 2, 28)
      wavHeader.writeUInt16LE(2, 32)
      wavHeader.writeUInt16LE(16, 34)
      wavHeader.write('data', 36)
      wavHeader.writeUInt32LE(track.length, 40)
      const wavBuf = Buffer.concat([wavHeader, track])

      audioTracks[pid] = `/audio-temp/${fname}`
      audioBase64Map[pid] = `data:audio/wav;base64,${wavBuf.toString('base64')}`
      console.log(`[COMBINE] Saved: ${fname} (base64: ${(wavBuf.length / 1024).toFixed(0)} KB)`)
    }

    return NextResponse.json({ success: true, audioTracks, audioBase64: audioBase64Map })
  } catch (err: any) {
    console.error('[COMBINE] Error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
