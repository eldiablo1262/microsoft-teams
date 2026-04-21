import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

export const runtime = 'nodejs'

const execFileAsync = promisify(execFile)

// Get ffmpeg binary path — try node_modules first, then system ffmpeg
function getFfmpegPath(): string {
  // Try ffmpeg-static in node_modules (works locally)
  const ffmpegInModules = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  if (fs.existsSync(ffmpegInModules)) {
    console.log('[CONCAT] Using ffmpeg-static from node_modules')
    return ffmpegInModules
  }
  // Fallback to system ffmpeg (installed via nixpacks on Railway)
  console.log('[CONCAT] Using system ffmpeg')
  return 'ffmpeg'
}

// Concatenate multiple MP4 video files into one using ffmpeg
// Supports remote URLs as fallback if local files were deleted (Railway redeploy)
export async function POST(request: NextRequest) {
  try {
    const { videoPaths, remoteUrls, outputFilename } = await request.json()
    if (!videoPaths || videoPaths.length === 0) {
      return NextResponse.json({ error: 'Missing videoPaths' }, { status: 400 })
    }

    if (videoPaths.length === 1) {
      return NextResponse.json({ success: true, videoUrl: videoPaths[0] })
    }

    const ffmpegPath = getFfmpegPath()
    const publicDir = path.join(process.cwd(), 'public')
    const outDir = path.join(publicDir, 'videos-generated')
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

    // Ensure all chunk files exist locally — download from remote URLs if missing
    for (let i = 0; i < videoPaths.length; i++) {
      const localPath = path.join(publicDir, videoPaths[i])
      if (!fs.existsSync(localPath)) {
        const remoteUrl = remoteUrls?.[i]
        if (remoteUrl) {
          console.log(`[CONCAT] Chunk ${i} missing locally, downloading from Replicate...`)
          try {
            const res = await fetch(remoteUrl)
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer())
              const dir = path.dirname(localPath)
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
              fs.writeFileSync(localPath, buf)
              console.log(`[CONCAT] Downloaded chunk ${i}: ${(buf.length / 1024 / 1024).toFixed(1)} MB`)
            } else {
              console.error(`[CONCAT] Failed to download chunk ${i}: HTTP ${res.status}`)
            }
          } catch (dlErr: any) {
            console.error(`[CONCAT] Failed to download chunk ${i}:`, dlErr.message)
          }
        } else {
          console.error(`[CONCAT] Chunk ${i} missing and no remote URL available: ${videoPaths[i]}`)
        }
      }
    }

    // Create concat list file for ffmpeg
    const listFilePath = path.join(outDir, `concat-list-${Date.now()}.txt`)
    const listContent = videoPaths.map((vp: string) => {
      const absPath = path.join(publicDir, vp).replace(/\\/g, '/')
      return `file '${absPath}'`
    }).join('\n')
    fs.writeFileSync(listFilePath, listContent)

    console.log(`[CONCAT] Concatenating ${videoPaths.length} videos...`)

    const fname = outputFilename || `concat-${Date.now()}.mp4`
    const outputPath = path.join(outDir, fname)

    // Run ffmpeg concat
    await execFileAsync(ffmpegPath, [
      '-f', 'concat',
      '-safe', '0',
      '-i', listFilePath,
      '-c', 'copy',
      '-y',
      outputPath,
    ], { timeout: 120000 })

    // Cleanup list file
    try { fs.unlinkSync(listFilePath) } catch {}

    const stats = fs.statSync(outputPath)
    console.log(`[CONCAT] Done: ${fname} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`)

    return NextResponse.json({
      success: true,
      videoUrl: `/videos-generated/${fname}`,
      size: stats.size,
    })
  } catch (err: any) {
    console.error('[CONCAT] Error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
