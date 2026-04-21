import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export const runtime = 'nodejs'

const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN || ''

// GET: Check prediction status + download/save video when done
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const predictionId = searchParams.get('id')
  const filename = searchParams.get('filename')

  if (!predictionId) {
    return NextResponse.json({ error: 'Missing prediction id' }, { status: 400 })
  }

  try {
    const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { 'Authorization': `Bearer ${REPLICATE_TOKEN}` },
    })

    if (!pollRes.ok) {
      return NextResponse.json({ error: `Replicate poll error: ${pollRes.status}` }, { status: 500 })
    }

    const status = await pollRes.json()

    if (status.status === 'succeeded') {
      const outputUrl = Array.isArray(status.output) ? status.output[0] : status.output

      if (!outputUrl) {
        return NextResponse.json({ error: 'No output URL from Replicate' }, { status: 500 })
      }

      // Download the video
      console.log(`[CHECK] Prediction ${predictionId} succeeded, downloading video...`)
      const videoRes = await fetch(outputUrl)
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer())

      // Save to disk
      const fname = filename || `gen-${Date.now()}.mp4`
      const outDir = path.join(process.cwd(), 'public', 'videos-generated')
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
      const outPath = path.join(outDir, fname)
      fs.writeFileSync(outPath, videoBuffer)

      console.log(`[CHECK] Saved: ${fname} (${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB)`)

      return NextResponse.json({
        status: 'succeeded',
        videoUrl: `/videos-generated/${fname}`,
        replicateUrl: outputUrl,
        size: videoBuffer.length,
      })
    }

    if (status.status === 'failed' || status.status === 'canceled') {
      console.error(`[CHECK] Prediction ${predictionId} failed:`, status.error)
      return NextResponse.json({
        status: 'failed',
        error: status.error || 'Video generation failed',
      })
    }

    // Still processing
    return NextResponse.json({
      status: status.status, // 'starting' or 'processing'
      progress: status.logs ? status.logs.split('\n').length : 0,
    })
  } catch (err: any) {
    console.error('[CHECK] Error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
