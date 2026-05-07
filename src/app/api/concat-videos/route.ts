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
      return NextResponse.json({ success: true, videoUrl: videoPaths[0], size: 0 })
    }

    const ffmpegPath = getFfmpegPath()
    const publicDir = path.join(process.cwd(), 'public')
    const outDir = path.join(publicDir, 'videos-generated')
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

    // Step 1: Ensure all chunk files exist locally — download from remote URLs if missing
    const missingChunks: number[] = []
    for (let i = 0; i < videoPaths.length; i++) {
      const localPath = path.join(publicDir, videoPaths[i])
      if (fs.existsSync(localPath)) {
        const sz = fs.statSync(localPath).size
        console.log(`[CONCAT] Chunk ${i}: OK (${(sz / 1024 / 1024).toFixed(1)} MB) — ${videoPaths[i]}`)
        continue
      }

      // Try downloading from remote URL
      const remoteUrl = remoteUrls?.[i]
      if (!remoteUrl) {
        console.error(`[CONCAT] Chunk ${i}: MISSING locally AND no remote URL — ${videoPaths[i]}`)
        missingChunks.push(i)
        continue
      }

      console.log(`[CONCAT] Chunk ${i}: missing locally, downloading...`)
      let downloaded = false
      for (let dl = 0; dl < 3 && !downloaded; dl++) {
        try {
          if (dl > 0) await new Promise(r => setTimeout(r, dl * 5000))
          const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(60000) })
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer())
            const dir = path.dirname(localPath)
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(localPath, buf)
            console.log(`[CONCAT] Chunk ${i}: downloaded (${(buf.length / 1024 / 1024).toFixed(1)} MB)`)
            downloaded = true
          } else {
            console.error(`[CONCAT] Chunk ${i}: download HTTP ${res.status} (attempt ${dl + 1})`)
          }
        } catch (dlErr: any) {
          console.error(`[CONCAT] Chunk ${i}: download error (attempt ${dl + 1}): ${dlErr.message}`)
        }
      }
      if (!downloaded) missingChunks.push(i)
    }

    // Step 2: Build concat list with only existing files
    const validPaths: string[] = []
    for (let i = 0; i < videoPaths.length; i++) {
      const localPath = path.join(publicDir, videoPaths[i])
      if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
        validPaths.push(videoPaths[i])
      } else {
        console.warn(`[CONCAT] Skipping chunk ${i} — file missing or empty`)
      }
    }

    if (validPaths.length === 0) {
      return NextResponse.json({ error: 'All chunks missing or empty' }, { status: 500 })
    }
    if (validPaths.length === 1) {
      return NextResponse.json({ success: true, videoUrl: validPaths[0], size: 0 })
    }

    const listFilePath = path.join(outDir, `concat-list-${Date.now()}.txt`)
    const listContent = validPaths.map((vp: string) => {
      const absPath = path.join(publicDir, vp).replace(/\\/g, '/')
      return `file '${absPath}'`
    }).join('\n')
    fs.writeFileSync(listFilePath, listContent)

    console.log(`[CONCAT] Concat list (${validPaths.length} files):\n${listContent}`)

    const fname = outputFilename || `concat-${Date.now()}.mp4`
    const outputPath = path.join(outDir, fname)

    // Step 3: Run ffmpeg — always re-encode audio to prevent glitches at chunk boundaries
    // Stream copy can cause "chchch" artifacts when audio codec params differ between Replicate chunks
    let ffmpegOk = false

    // Method 1: video copy + audio re-encode (fast + safe audio)
    try {
      const { stderr } = await execFileAsync(ffmpegPath, [
        '-f', 'concat', '-safe', '0', '-i', listFilePath,
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart', '-y', outputPath,
      ], { timeout: 300000 })
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        ffmpegOk = true
        console.log('[CONCAT] Video copy + audio re-encode succeeded')
      } else {
        console.warn('[CONCAT] Video copy + audio re-encode produced empty file, trying full re-encode...')
      }
    } catch (copyErr: any) {
      console.warn(`[CONCAT] Video copy + audio re-encode failed: ${copyErr.message?.slice(0, 150)}`)
    }

    // Method 2: full re-encode with CROSSFADE (smooth transitions + no audio glitches)
    if (!ffmpegOk) {
      try {
        const inputArgs: string[] = []
        validPaths.forEach(vp => {
          inputArgs.push('-i', path.join(publicDir, vp).replace(/\\/g, '/'))
        })

        const XFADE_DURATION = 0.4 // 400ms crossfade between chunks
        let filterComplex = ''

        if (validPaths.length === 2) {
          // Simple 2-input xfade
          filterComplex = `[0:v][1:v]xfade=transition=fade:duration=${XFADE_DURATION}:offset=OFFSET0[outv];[0:a][1:a]acrossfade=d=${XFADE_DURATION}:c1=tri:c2=tri[outa]`
        } else {
          // Chain xfade for 3+ inputs
          // Build video chain
          let vChain = '[0:v]'
          for (let i = 1; i < validPaths.length; i++) {
            const prevLabel = i === 1 ? '[0:v]' : `[xv${i - 1}]`
            const outLabel = i === validPaths.length - 1 ? '[outv]' : `[xv${i}]`
            filterComplex += `${prevLabel}[${i}:v]xfade=transition=fade:duration=${XFADE_DURATION}:offset=OFFSET${i - 1}${outLabel};`
          }
          // Build audio chain
          let aChain = '[0:a]'
          for (let i = 1; i < validPaths.length; i++) {
            const prevLabel = i === 1 ? '[0:a]' : `[xa${i - 1}]`
            const outLabel = i === validPaths.length - 1 ? '[outa]' : `[xa${i}]`
            filterComplex += `${prevLabel}[${i}:a]acrossfade=d=${XFADE_DURATION}:c1=tri:c2=tri${outLabel};`
          }
          // Remove trailing semicolon
          filterComplex = filterComplex.replace(/;$/, '')
        }

        // We need chunk durations to calculate xfade offsets
        // Probe each file for duration
        let offsets: number[] = []
        let cumDuration = 0
        for (let i = 0; i < validPaths.length - 1; i++) {
          try {
            const probePath = path.join(publicDir, validPaths[i]).replace(/\\/g, '/')
            const { stdout } = await execFileAsync(ffmpegPath.replace('ffmpeg', 'ffprobe').replace('ffmpeg.exe', 'ffprobe.exe'), [
              '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', probePath
            ], { timeout: 10000 })
            const dur = parseFloat(stdout.trim()) || 9
            cumDuration += dur - (i > 0 ? XFADE_DURATION : 0)
            offsets.push(cumDuration - XFADE_DURATION)
          } catch {
            cumDuration += 9 - (i > 0 ? XFADE_DURATION : 0)
            offsets.push(cumDuration - XFADE_DURATION)
          }
        }

        // Replace OFFSET placeholders with actual values
        offsets.forEach((offset, i) => {
          filterComplex = filterComplex.replace(`OFFSET${i}`, offset.toFixed(3))
        })

        console.log(`[CONCAT] Crossfade filter: ${filterComplex.slice(0, 300)}...`)

        const { stderr } = await execFileAsync(ffmpegPath, [
          ...inputArgs,
          '-filter_complex', filterComplex,
          '-map', '[outv]', '-map', '[outa]',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
          '-c:a', 'aac', '-b:a', '192k',
          '-movflags', '+faststart', '-y', outputPath,
        ], { timeout: 600000 })
        
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          ffmpegOk = true
          console.log('[CONCAT] Crossfade re-encode succeeded')
        }
      } catch (reencErr: any) {
        console.error(`[CONCAT] Crossfade re-encode failed: ${reencErr.message?.slice(0, 200)}`)
      }
    }

    // Method 2b: fallback without crossfade (simple concat with re-encode)
    if (!ffmpegOk) {
      try {
        const inputArgs: string[] = []
        validPaths.forEach(vp => {
          inputArgs.push('-i', path.join(publicDir, vp).replace(/\\/g, '/'))
        })
        const filterComplex = validPaths.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('') + `concat=n=${validPaths.length}:v=1:a=1[outv][outa]`
        
        const { stderr } = await execFileAsync(ffmpegPath, [
          ...inputArgs,
          '-filter_complex', filterComplex,
          '-map', '[outv]', '-map', '[outa]',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-c:a', 'aac', '-b:a', '128k',
          '-movflags', '+faststart', '-y', outputPath,
        ], { timeout: 600000 })
        
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          ffmpegOk = true
          console.log('[CONCAT] Simple re-encode (filter_complex) succeeded')
        }
      } catch (reencErr: any) {
        console.error(`[CONCAT] Simple re-encode also failed: ${reencErr.message?.slice(0, 200)}`)
      }
    }

    // Method 3: last resort — concat demuxer with re-encode
    if (!ffmpegOk) {
      try {
        await execFileAsync(ffmpegPath, [
          '-f', 'concat', '-safe', '0', '-i', listFilePath,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-c:a', 'aac', '-b:a', '128k',
          '-movflags', '+faststart', '-y', outputPath,
        ], { timeout: 600000 })
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          ffmpegOk = true
          console.log('[CONCAT] Concat demuxer re-encode succeeded')
        }
      } catch (lastErr: any) {
        console.error(`[CONCAT] All methods failed: ${lastErr.message?.slice(0, 200)}`)
      }
    }

    // Cleanup
    try { fs.unlinkSync(listFilePath) } catch {}

    if (!ffmpegOk || !fs.existsSync(outputPath)) {
      // Last fallback: return first chunk instead of failing
      console.error('[CONCAT] All ffmpeg methods failed — returning first chunk as fallback')
      return NextResponse.json({ success: true, videoUrl: validPaths[0], size: 0, partial: true })
    }

    const stats = fs.statSync(outputPath)
    console.log(`[CONCAT] Done: ${fname} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`)

    return NextResponse.json({
      success: true,
      videoUrl: `/videos-generated/${fname}`,
      size: stats.size,
    })
  } catch (err: any) {
    console.error('[CONCAT] Critical error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
