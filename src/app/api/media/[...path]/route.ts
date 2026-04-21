import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export const runtime = 'nodejs'

// Serve dynamically generated files from public/ directory
// In production, Next.js only serves files that existed at build time
// This route serves files created after build (videos, audio, meetings JSON)
export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const filePath = params.path.join('/')
  
  // Security: prevent directory traversal
  if (filePath.includes('..') || filePath.includes('~')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  }

  const absPath = path.join(process.cwd(), 'public', filePath)
  
  if (!fs.existsSync(absPath)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  const stat = fs.statSync(absPath)
  const ext = path.extname(absPath).toLowerCase()

  const mimeTypes: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.json': 'application/json',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
  }

  const contentType = mimeTypes[ext] || 'application/octet-stream'

  // Handle Range requests for video streaming
  const range = request.headers.get('range')
  if (range && (ext === '.mp4' || ext === '.webm')) {
    const parts = range.replace(/bytes=/, '').split('-')
    const start = parseInt(parts[0], 10)
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
    const chunkSize = end - start + 1

    const stream = fs.createReadStream(absPath, { start, end })
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks)

    return new NextResponse(body, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunkSize),
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    })
  }

  // Full file response
  const fileBuffer = fs.readFileSync(absPath)
  return new NextResponse(fileBuffer, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
