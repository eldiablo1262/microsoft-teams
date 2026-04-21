import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

export interface MeetingData {
  id: string
  title: string
  createdAt: number
  adminKey: string
  participants: { id: string; name: string; color: string; videoUrl: string }[]
  timeline: { participantId: string; startTime: number; endTime: number }[]
  totalDuration: number
  state: {
    started: boolean
    startedAt: number | null
    clientJoined: boolean
    adminJoined: boolean
  }
  rtc?: {
    offer?: RTCSessionDescriptionInit | null
    answer?: RTCSessionDescriptionInit | null
    adminCandidates?: RTCIceCandidateInit[]
    clientCandidates?: RTCIceCandidateInit[]
  }
}

// Persist meetings to disk so they survive hot-reloads
const MEETINGS_DIR = path.join(process.cwd(), 'public', 'meetings')

function ensureDir() {
  if (!fs.existsSync(MEETINGS_DIR)) fs.mkdirSync(MEETINGS_DIR, { recursive: true })
}

function saveMeeting(meeting: MeetingData) {
  ensureDir()
  fs.writeFileSync(path.join(MEETINGS_DIR, `${meeting.id}.json`), JSON.stringify(meeting))
}

function loadMeeting(id: string): MeetingData | null {
  const filePath = path.join(MEETINGS_DIR, `${id}.json`)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

// POST: create a new meeting room
export async function POST(request: NextRequest) {
  const body = await request.json()
  const id = crypto.randomBytes(4).toString('hex') // 8-char hex ID
  const adminKey = crypto.randomBytes(8).toString('hex') // 16-char secret for admin
  const meeting: MeetingData = {
    id,
    title: body.title || 'Reunion IA',
    createdAt: Date.now(),
    adminKey,
    participants: body.participants || [],
    timeline: body.timeline || [],
    totalDuration: body.totalDuration || 0,
    state: {
      started: false,
      startedAt: null,
      clientJoined: false,
      adminJoined: false,
    },
  }
  saveMeeting(meeting)
  console.log(`[MEETING] Created room ${id} (adminKey=${adminKey}) with ${meeting.participants.length} participants, ${meeting.timeline.length} segments, ${meeting.totalDuration.toFixed(1)}s`)
  return NextResponse.json({ success: true, meetingId: id, adminKey })
}

// GET: retrieve meeting data by ID
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'Missing meeting id' }, { status: 400 })
  }
  const meeting = loadMeeting(id)
  if (!meeting) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 })
  }
  // Don't expose adminKey in GET response unless the caller provides it
  const key = searchParams.get('key')
  const isAdmin = key === meeting.adminKey
  const safeData = { ...meeting, adminKey: isAdmin ? meeting.adminKey : undefined }
  return NextResponse.json({ success: true, meeting: safeData, isAdmin, rtc: meeting.rtc || null })
}

// PATCH: update meeting state (join/leave/start)
export async function PATCH(request: NextRequest) {
  const body = await request.json()
  const { id, action, key } = body
  if (!id || !action) {
    return NextResponse.json({ error: 'Missing id or action' }, { status: 400 })
  }
  const meeting = loadMeeting(id)
  if (!meeting) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 })
  }

  const isAdmin = key === meeting.adminKey

  switch (action) {
    case 'clientJoin':
      meeting.state.clientJoined = true
      if (!meeting.state.started) {
        meeting.state.started = true
        meeting.state.startedAt = Date.now()
      }
      // Clear stale RTC data only (not admin state — admin may already be connected)
      meeting.rtc = {}
      console.log(`[MEETING] ${id}: Client joined (RTC data cleared, adminJoined=${meeting.state.adminJoined})`)
      break
    case 'clientLeave':
      meeting.state.clientJoined = false
      console.log(`[MEETING] ${id}: Client left`)
      break
    case 'adminJoin':
      if (!isAdmin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
      meeting.state.adminJoined = true
      // Clear stale RTC from previous session so fresh offer is created
      meeting.rtc = {}
      console.log(`[MEETING] ${id}: Admin joined (RTC reset)`)
      break
    case 'adminLeave':
      if (!isAdmin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
      meeting.state.adminJoined = false
      console.log(`[MEETING] ${id}: Admin left`)
      break
    // WebRTC signaling actions
    case 'rtcOffer':
      if (!isAdmin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
      if (!meeting.rtc) meeting.rtc = {}
      meeting.rtc.offer = body.offer
      meeting.rtc.answer = null
      meeting.rtc.adminCandidates = []
      meeting.rtc.clientCandidates = []
      console.log(`[MEETING] ${id}: Admin sent RTC offer`)
      break
    case 'rtcAnswer':
      if (!meeting.rtc) meeting.rtc = {}
      meeting.rtc.answer = body.answer
      console.log(`[MEETING] ${id}: Client sent RTC answer`)
      break
    case 'iceCandidate': {
      if (!meeting.rtc) meeting.rtc = {}
      const from = body.from // 'admin' or 'client'
      if (from === 'admin') {
        if (!meeting.rtc.adminCandidates) meeting.rtc.adminCandidates = []
        meeting.rtc.adminCandidates.push(body.candidate)
      } else {
        if (!meeting.rtc.clientCandidates) meeting.rtc.clientCandidates = []
        meeting.rtc.clientCandidates.push(body.candidate)
      }
      break
    }
    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  }

  saveMeeting(meeting)
  return NextResponse.json({ success: true, state: meeting.state, rtc: meeting.rtc })
}
