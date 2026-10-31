import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Frame,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { colorAt, inferTopology, nodeAt, parseNetAnim, traceBounds } from '../lib/netanim.js'
import { useI18n } from '../i18n.jsx'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Faster than 2x is not useful here: past that the packets stop being
// individually followable, which is the whole reason to open the animation.
// The very slow end is where the value is, hence 0.001x.
const SPEEDS = [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2]

// ns-3 node index of the server in every SSBCV scenario: UdpEchoServer in
// simulation, the iperf3 servers in emulation. Set in ns3_runner.build_and_run
// (`echo_server.Install(nodes.Get(0))`) and ns3_sim._run_workload.
const SERVER_NODE = 0
// Slow by default: at 1x a dense trace is a blur, and the point of opening the
// animation is to watch individual packets move. A 20 s emulation puts ~80k
// events on the wire, so even 0.1x still smears — start at the bottom of the
// range and let the user speed it up.
const DEFAULT_SPEED = 0.001
// Fit the whole trace: every node visible is worth more than a closer look at
// some of them, and zooming in is one click away. (This was 1.5x, which cropped
// the ends of a wide topology before the user had seen it at all.)
const DEFAULT_ZOOM = 1

// Real propagation is microseconds: at true speed a packet would cross the
// canvas inside one frame and never be seen. Every hop is therefore drawn over
// a minimum on-screen flight (desktop NetAnim stretches time the same way).
// The floor follows the trace's density — a sparse p2p trace needs a long
// stretch to show anything, a dense wifi trace would smear into a solid line
// with the same value. The caption says the flight time is not physical.
const FLIGHT_PER_EVENT = 2
const MIN_FLIGHT_S = 0.05
const MAX_FLIGHT_S = 0.4

// Glyphs keep a constant size on screen while positions scale, so a 100-node
// network stays readable instead of turning into a field of dots.
const BODY_W = 22
const BODY_H = 15
const DEVICE_HALF_W = BODY_W / 2 + 2 // glyph footprint, for label placement
const HIT_RADIUS = 18
const PACKET_R = 3.4
const PACKET_HIT_R = 9
const LABEL_LIMIT = 40 // above this many nodes, labels only on hover
const ADDRESS_LIMIT = 14 // and addresses only on hover
// A dense emulation puts hundreds of packets in the air at once (a 25 s run
// recorded ~80k events); drawing them all buries the topology under a solid
// line of dots. Above this many, draw an evenly spaced sample — the caption
// still reports the true total.
const MAX_DRAWN_PACKETS = 140
// Above this many nodes an observed-link mesh is a hairball, so its edges are
// drawn only for the node under the cursor.
const MESH_ALL_LIMIT = 24

// The expanding wavefront a radio node draws while transmitting. Three rings
// staggered behind the leading edge, so it reads as a wave train rather than
// one circle; the reach is generous because the point is to be seen, not to
// claim a propagation distance (positions are metres, this is pixels).
const RIPPLE_LAGS = [0, 0.16, 0.32, 0.48]
const RIPPLE_MIN_R = 12
const RIPPLE_REACH = 84
// The comet trail behind each packet: ghosts that shrink and fade with
// distance (····ooOO@). Five is enough to read as motion without turning a
// dense trace into soup, and at 140 drawn packets it is 840 cheap arcs.
const GHOSTS = 5
const GHOST_SPACING = 0.026

// Canvas needs real colours, and reading a custom property gives back its
// declared text: `--signal: var(--sim)` comes out as the literal "var(--sim)",
// which canvas silently rejects — packets then draw in whatever colour was set
// last, i.e. invisibly. Resolving through a probe element makes the browser do
// the substitution, so any level of var() indirection ends up as rgb().
function readTheme() {
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
  document.body.appendChild(probe)
  const v = (name, fallback) => {
    probe.style.color = ''
    probe.style.color = `var(${name})`
    const resolved = getComputedStyle(probe).color
    return resolved && resolved !== 'rgba(0, 0, 0, 0)' ? resolved : fallback
  }
  const theme = {
    paper: v('--paper', '#fff'),
    panel: v('--panel', '#fff'),
    ink: v('--ink', '#111'),
    inkSoft: v('--ink-soft', '#666'),
    rule: v('--rule', '#ddd'),
    ruleStrong: v('--rule-strong', '#bbb'),
    signal: v('--signal', '#4338ca'),
    ok: v('--ok', '#0a7'),
    devices: [
      v('--dev-1', '#0e7490'),
      v('--dev-2', '#15803d'),
      v('--dev-3', '#b45309'),
      v('--dev-4', '#7e22ce'),
      v('--dev-5', '#be123c'),
      v('--dev-6', '#475569'),
    ],
  }
  probe.remove()
  return theme
}

// A node is radio if its channel says so, or — when the trace declares no
// channel at all, as emulation traces do — if the trace carries wireless
// events. Otherwise a wifi emulation would draw as wired boxes.
const RADIO = /wifi|wireless|yans|spectrum|lr-?wpan|lte|uan|wave/i
const isWireless = (node, trace) =>
  (node.channels?.length ? node.channels : [node.channel || '']).some((c) => RADIO.test(c)) ||
  (!node.channel && !!trace?.wireless)

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/

// Which device profile a node runs. The run knows exactly (node_profiles); an
// arbitrary NetAnim file only has the description, and SSBCV writes those as
// "<name> <profile> [ip]", so the second word is the profile when it is not an
// address. Unknown profiles simply share the neutral colour.
function deviceKey(node, profiles) {
  const given = profiles?.[node.id]
  if (given) return given
  const parts = (node.label || '').trim().split(/\s+/)
  const candidate = parts[1]
  return candidate && !IPV4.test(candidate) ? candidate : null
}

function formatSeconds(s) {
  if (s == null) return null
  if (s >= 1e-3) return `${(s * 1e3).toFixed(3)} ms`
  return `${(s * 1e6).toFixed(1)} µs`
}

export default function NetAnimViewer({ source, label, note, profiles, scenario }) {
  const { t: tr } = useI18n()
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const rootRef = useRef(null)
  const fileInput = useRef(null)
  const [xml, setXml] = useState(null)
  const [name, setName] = useState(label)
  // Once the user opens their own file the run's declared scenario no longer
  // describes what is on screen.
  const [localFile, setLocalFile] = useState(false)
  const [error, setError] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(DEFAULT_SPEED)
  const [clock, setClock] = useState(0)
  const [theme, setTheme] = useState(readTheme)
  const [fullscreen, setFullscreen] = useState(false)
  // What the cursor is over, for the info card. Mirrored in a ref so the render
  // loop can read it without listing it as a dependency.
  const [hover, setHover] = useState(null)
  const hoverRef = useRef(null)
  const [mouse, setMouse] = useState({ x: 0, y: 0 })
  const mouseRef = useRef(null)
  // A tapped (or clicked) node or packet keeps its card open. Touch screens
  // have no hover, so without this the cards were unreachable on a phone.
  const pinnedRef = useRef(null)
  const drawnRef = useRef([])
  const tapRef = useRef(null)
  const clockRef = useRef(0)
  // Pan/zoom live in refs: they change on every mouse move and must not make
  // React re-render 60 times a second.
  const viewRef = useRef({ zoom: DEFAULT_ZOOM, panX: 0, panY: 0 })
  const dragRef = useRef(null)
  const screenRef = useRef(new Map())
  // Node positions the user dragged, in trace (world) coordinates, keyed by id.
  // A ref, not state: they change on every pointermove and only the canvas
  // cares. `moveCount` exists purely so the "reset layout" button can appear.
  const movedRef = useRef(new Map())
  const unprojectRef = useRef(null)
  const [moveCount, setMoveCount] = useState(0)

  useEffect(() => {
    if (!source) return
    let cancelled = false
    setError(null)
    fetch(source)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((text) => !cancelled && setXml(text))
      .catch((e) => !cancelled && setError(e.message))
    return () => { cancelled = true }
  }, [source])

  const trace = useMemo(() => {
    if (!xml) return null
    try {
      return parseNetAnim(xml)
    } catch (e) {
      setError(e.message)
      return null
    }
  }, [xml])

  // A pin belongs to the trace it was made on.
  useEffect(() => {
    pinnedRef.current = null
  }, [trace])

  // A file the user opened by hand is not the run's file, so its scenario and
  // its traffic pattern are unknown again and both go back to being inferred.
  // SERVER_NODE: every SSBCV scenario puts the server on node 0.
  const run = useMemo(
    () => (localFile || !scenario ? null : { scenario, serverNode: SERVER_NODE }),
    [localFile, scenario],
  )
  const topology = useMemo(() => (trace ? inferTopology(trace, run) : null), [trace, run])

  const nodeById = useMemo(
    () => new Map((trace?.nodes ?? []).map((n) => [n.id, n])),
    [trace],
  )

  // How much each node sent and received, for the hover card.
  const counts = useMemo(() => {
    const map = new Map()
    if (!trace) return map
    for (const e of trace.events) {
      const from = map.get(e.from) || { tx: 0, rx: 0 }
      from.tx++
      map.set(e.from, from)
      const to = map.get(e.to) || { tx: 0, rx: 0 }
      to.rx++
      map.set(e.to, to)
    }
    return map
  }, [trace])

  // One colour per distinct device profile, in first-seen order so the legend
  // and the canvas agree. A colour the trace sets itself (UpdateNodeColor)
  // wins: the author chose it, and desktop NetAnim shows it too. Those nodes
  // are listed in the legend by their description and colour.
  const devices = useMemo(() => {
    const map = new Map()
    if (!trace) return map
    let palette = 0
    for (const node of trace.nodes) {
      // The colour the node settles on at the start (the last keyframe at t0).
      const own = colorAt(node, trace.startTime)
      const key = own ? `${node.label || 'node'}|${own}` : deviceKey(node, profiles)
      if (!key) continue
      if (!map.has(key)) {
        map.set(key, {
          name: own ? node.label || own : key,
          color: own ?? theme.devices[palette++ % theme.devices.length],
          count: 0,
        })
      }
      map.get(key).count++
    }
    return map
  }, [trace, profiles, theme])

  const colorOf = useCallback(
    (node, t) => {
      const own = colorAt(node, t ?? clockRef.current)
      if (own) return own
      return devices.get(deviceKey(node, profiles))?.color ?? theme.ink
    },
    [devices, profiles, theme],
  )

  // Examples often give many nodes the same description ("STA" for every
  // station). On the canvas the index is added so each one can be told apart.
  const displayName = useMemo(() => {
    const map = new Map()
    if (!trace) return map
    const seen = new Map()
    for (const node of trace.nodes) if (node.label) seen.set(node.label, (seen.get(node.label) ?? 0) + 1)
    for (const node of trace.nodes) {
      map.set(node.id, !node.label ? `n${node.id}` : seen.get(node.label) > 1 ? `${node.label} n${node.id}` : node.label)
    }
    return map
  }, [trace])

  const span = trace ? trace.endTime - trace.startTime : 0
  const flightFloor = trace
    ? Math.min(
        Math.max((span / Math.max(trace.events.length, 1)) * FLIGHT_PER_EVENT, MIN_FLIGHT_S),
        MAX_FLIGHT_S,
      )
    : MIN_FLIGHT_S

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    if (!trace) return
    clockRef.current = trace.startTime
    viewRef.current = { zoom: DEFAULT_ZOOM, panX: 0, panY: 0 }
    setClock(trace.startTime)
    setPlaying(trace.events.length > 0)
  }, [trace])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !trace) return
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = theme.panel
    ctx.fillRect(0, 0, w, h)

    const now = clockRef.current
    const { zoom, panX, panY } = viewRef.current
    const b = traceBounds(trace.nodes)
    // Wider than tall: a node's label and address stick out sideways well past
    // the glyph, and fitting only the positions clipped the outermost ones.
    const padX = 92
    const padY = 52
    const fit = Math.min((w - padX * 2) / (b.maxX - b.minX), (h - padY * 2) / (b.maxY - b.minY))
    const scale = fit * zoom
    const offX = (w - (b.maxX - b.minX) * scale) / 2 + panX
    const offY = (h - (b.maxY - b.minY) * scale) / 2 + panY
    const project = (p) => [offX + (p.x - b.minX) * scale, offY + (p.y - b.minY) * scale]
    // Hand-placed nodes win over the trace's own coordinates. ns-3 lays a wired
    // network out for the simulator's convenience, not for reading, so being
    // able to pull a node aside is often the difference between a picture that
    // explains the topology and one that hides it.
    const moved = movedRef.current
    const pos = new Map(
      trace.nodes.map((n) => [n.id, project(moved.get(n.id) ?? nodeAt(n, now))]),
    )
    screenRef.current = pos
    // Screen -> world, so a drag can be stored in trace coordinates and survive
    // panning, zooming and fit.
    unprojectRef.current = (sx, sy) => ({
      x: (sx - offX) / scale + b.minX,
      y: (sy - offY) / scale + b.minY,
    })

    const hovered = hoverRef.current
    const hoveredNodeId = hovered?.kind === 'node' ? hovered.id : null

    // World grid, so panning and zooming have a frame of reference.
    const step = niceStep((b.maxX - b.minX) / 6)
    ctx.strokeStyle = theme.rule
    ctx.lineWidth = 1
    ctx.globalAlpha = 0.6
    ctx.beginPath()
    for (let x = Math.ceil(b.minX / step) * step; x <= b.maxX; x += step) {
      const [sx] = project({ x, y: b.minY })
      ctx.moveTo(sx, 0)
      ctx.lineTo(sx, h)
    }
    for (let y = Math.ceil(b.minY / step) * step; y <= b.maxY; y += step) {
      const [, sy] = project({ x: b.minX, y })
      ctx.moveTo(0, sy)
      ctx.lineTo(w, sy)
    }
    ctx.stroke()
    ctx.globalAlpha = 1

    const busGeom = busGeometry(topology, pos)
    drawTopology(ctx, topology, pos, theme, hoveredNodeId, trace.nodes.length, busGeom)

    // Packets in flight. Events are sorted by tx, so the scan starts at the
    // first one that could still be airborne instead of walking the trace.
    const window0 = now - Math.max(trace.maxFlight, flightFloor)
    let lo = 0
    let hi = trace.events.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (trace.events[mid].tx < window0) lo = mid + 1
      else hi = mid
    }
    const airborne = []
    const transmitting = new Map() // node id -> youngest transmission's progress
    for (let i = lo; i < trace.events.length; i++) {
      const e = trace.events[i]
      if (e.tx > now) break
      const flight = Math.max(e.rx - e.tx, flightFloor)
      const progress = (now - e.tx) / flight
      if (progress > 1) continue
      const seen = transmitting.get(e.from)
      if (seen == null || progress < seen) transmitting.set(e.from, progress)
      airborne.push([e, progress])
    }
    // Wireless transmission ripple, the NetAnim signature for radio nodes: a
    // wavefront that actually expands and fades as the transmission travels,
    // rather than three fixed circles. This is what makes a radio node read as
    // broadcasting into space instead of shooting a dot down a wire.
    for (const [id, progress] of transmitting) {
      // By id, not by array index: node ids are sorted but not guaranteed
      // contiguous, so a trace with a gap would ripple the wrong device.
      const node = nodeById.get(id)
      if (!node || !isWireless(node, trace)) continue
      const [x, y] = pos.get(id)
      ctx.strokeStyle = colorOf(node)
      ctx.lineWidth = 1.5
      for (const lag of RIPPLE_LAGS) {
        const p = progress - lag
        if (p <= 0 || p >= 1) continue
        ctx.globalAlpha = 0.6 * (1 - p) ** 2
        ctx.beginPath()
        ctx.arc(x, y, RIPPLE_MIN_R + p * RIPPLE_REACH, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    const showLabels = trace.nodes.length <= LABEL_LIMIT
    const showAddresses = trace.nodes.length <= ADDRESS_LIMIT
    ctx.textAlign = 'center'
    for (const node of trace.nodes) {
      const [x, y] = pos.get(node.id)
      const isHub = topology?.hub === node.id
      drawDevice(ctx, x, y, node, theme, colorOf(node, now), hoveredNodeId === node.id, transmitting.has(node.id), trace, isHub)
    }
    // Labels after every device, and only where they fit: nodes that sit close
    // together (a station grid, a crowd around an access point) would print
    // their names on top of each other. Each label claims its box; one that
    // would overlap a box already taken drops its address first, then itself,
    // and is still shown on hover. The hovered node is placed first so it
    // always wins.
    const taken = []
    const overlaps = (r) => taken.some((o) => r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0)
    for (const node of trace.nodes) {
      const [x, y] = pos.get(node.id)
      taken.push({ x0: x - DEVICE_HALF_W, x1: x + DEVICE_HALF_W, y0: y - BODY_H / 2 - 8, y1: y + BODY_H / 2 })
    }
    const order = [...trace.nodes].sort((a, b) => (b.id === hoveredNodeId) - (a.id === hoveredNodeId))
    for (const node of order) {
      const hovered = hoveredNodeId === node.id
      if (!showLabels && !hovered) continue
      const [x, y] = pos.get(node.id)
      const name = displayName.get(node.id) ?? `n${node.id}`
      ctx.font = '600 11px ui-monospace, monospace'
      const nameW = ctx.measureText(name).width
      const addr = (showAddresses || hovered) && node.addresses[0]
      ctx.font = '10px ui-monospace, monospace'
      const addrW = addr ? ctx.measureText(addr).width : 0
      const top = y + BODY_H / 2 + 5
      const nameBox = { x0: x - nameW / 2 - 2, x1: x + nameW / 2 + 2, y0: top, y1: top + 13 }
      const fullW = Math.max(nameW, addrW)
      const fullBox = { x0: x - fullW / 2 - 2, x1: x + fullW / 2 + 2, y0: top, y1: top + 26 }
      let box = null
      let withAddr = false
      if (addr && (hovered || !overlaps(fullBox))) {
        box = fullBox
        withAddr = true
      } else if (hovered || !overlaps(nameBox)) {
        box = nameBox
      }
      if (!box) continue
      taken.push(box)
      // A backing in the panel colour, so a cable or a dashed link running
      // under the name does not strike it through.
      ctx.globalAlpha = hovered ? 1 : 0.85
      ctx.fillStyle = theme.panel
      ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0)
      ctx.globalAlpha = 1
      ctx.fillStyle = theme.ink
      ctx.font = '600 11px ui-monospace, monospace'
      ctx.fillText(name, x, y + BODY_H / 2 + 15)
      if (withAddr) {
        ctx.fillStyle = theme.inkSoft
        ctx.font = '10px ui-monospace, monospace'
        ctx.fillText(addr, x, y + BODY_H / 2 + 28)
      }
    }

    const inFlight = airborne.length
    const stride = Math.max(1, Math.ceil(inFlight / MAX_DRAWN_PACKETS))
    const drawn = []
    for (let i = 0; i < airborne.length; i += stride) {
      const [e, progress] = airborne[i]
      const a = pos.get(e.from)
      const c = pos.get(e.to)
      if (!a || !c) continue
      // Over a cable the packet follows the cable; over the air it goes
      // straight, because that is what radio does.
      const route = busGeom && busRoute(busGeom, e.from, e.to, a, c)
      const at = (p) =>
        route ? alongPath(route, p) : [a[0] + (c[0] - a[0]) * p, a[1] + (c[1] - a[1]) * p]
      const [x, y] = at(progress)
      drawn.push({ e, x, y })
      // The trail is a row of shrinking, fading ghosts rather than a stroked
      // line. Each one is placed ON the path, so a trail going round a corner
      // of the cable simply bends with it — a line between two path points
      // cuts the corner no matter how finely it is sampled.
      ctx.fillStyle = theme.signal
      for (let g = GHOSTS; g >= 1; g--) {
        const p = progress - g * GHOST_SPACING
        if (p <= 0) continue
        const fade = 1 - g / (GHOSTS + 1)
        ctx.globalAlpha = 0.55 * fade ** 1.6
        const [gx, gy] = at(p)
        ctx.beginPath()
        ctx.arc(gx, gy, PACKET_R * (0.3 + 0.7 * fade), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 0.95
      ctx.beginPath()
      ctx.arc(x, y, PACKET_R, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    // Hit testing runs here rather than on pointermove: packets move under a
    // stationary cursor, so "what am I pointing at" has to be answered every
    // frame, not only when the mouse does something.
    drawnRef.current = drawn
    let next = hitTest(mouseRef.current, pos, drawn)
    const pinned = pinnedRef.current
    if (!next && pinned) {
      if (pinned.kind === 'node') {
        next = pos.has(pinned.id) ? pinned : null
      } else {
        // Follow the packet while it flies; once it lands the card stays where
        // it was last seen, so it can still be read.
        const live = drawn.find((p) => p.e === pinned.e)
        if (live) pinnedRef.current = { kind: 'packet', e: live.e, x: live.x, y: live.y }
        next = pinnedRef.current
      }
    }
    if (next?.kind === 'packet') {
      // Ring the packet the card is describing, so the pairing is unambiguous.
      ctx.strokeStyle = theme.ink
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(next.x, next.y, PACKET_R + 4, 0, Math.PI * 2)
      ctx.stroke()
    }
    if (!sameHover(next, hoverRef.current)) {
      hoverRef.current = next
      setHover(next)
    }

    canvas.dataset.inFlight = String(inFlight)
  }, [trace, topology, theme, colorOf, flightFloor, nodeById])

  useEffect(() => {
    if (!trace) return
    let raf = 0
    let last = performance.now()
    const step = (now) => {
      const dt = (now - last) / 1000
      last = now
      if (playing) {
        clockRef.current += dt * speed
        if (clockRef.current >= trace.endTime) {
          clockRef.current = trace.endTime
          setPlaying(false)
        }
        setClock(clockRef.current)
      }
      draw()
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [trace, playing, speed, draw])

  useEffect(() => {
    if (!wrapRef.current) return
    const observer = new ResizeObserver(() => draw())
    observer.observe(wrapRef.current)
    return () => observer.disconnect()
  }, [draw])

  function zoomBy(factor, anchor) {
    const v = viewRef.current
    const next = Math.min(Math.max(v.zoom * factor, 0.2), 12)
    const applied = next / v.zoom
    if (anchor && canvasRef.current) {
      // Keep the point under the cursor fixed while the scale changes.
      const cx = canvasRef.current.clientWidth / 2
      const cy = canvasRef.current.clientHeight / 2
      v.panX = anchor.x - cx - (anchor.x - cx - v.panX) * applied
      v.panY = anchor.y - cy - (anchor.y - cy - v.panY) * applied
    }
    v.zoom = next
    draw()
  }

  function onWheel(e) {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  function onPointerDown(e) {
    const rect = e.currentTarget.getBoundingClientRect()
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    tapRef.current = { x: e.clientX, y: e.clientY, point }
    // Pressing on a device moves that device; pressing on empty space pans the
    // view. Same gesture, and which one you get is decided by what is under it.
    const node = nodeUnder(point, screenRef.current)
    dragRef.current =
      node != null
        ? { node }
        : { x: e.clientX, y: e.clientY, panX: viewRef.current.panX, panY: viewRef.current.panY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e) {
    const rect = e.currentTarget.getBoundingClientRect()
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    // A finger has no hover: only a mouse or pen drives the hover card.
    if (e.pointerType !== 'touch') {
      mouseRef.current = point
      setMouse(point)
    }
    const drag = dragRef.current
    if (!drag) return
    if (drag.node != null) {
      const world = unprojectRef.current?.(point.x, point.y)
      if (world) movedRef.current.set(drag.node, world)
    } else {
      viewRef.current.panX = drag.panX + (e.clientX - drag.x)
      viewRef.current.panY = drag.panY + (e.clientY - drag.y)
    }
    draw()
  }

  function onPointerUp(e) {
    // A press that barely moved is a tap: pin what is under it, or clear the
    // pin when it lands on empty space or on what is already pinned.
    const tap = tapRef.current
    tapRef.current = null
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < TAP_SLOP) {
      // A fingertip is far less precise than a cursor, so packets get a wider
      // target on touch.
      const hit = hitTest(tap.point, screenRef.current, drawnRef.current, e.pointerType === 'touch' ? PACKET_HIT_R * 2.5 : PACKET_HIT_R)
      pinnedRef.current = hit && !sameHover(hit, pinnedRef.current) ? hit : null
      if (!pinnedRef.current && e.pointerType === 'touch') {
        hoverRef.current = null
        setHover(null)
      }
      draw()
    }
    if (dragRef.current?.node != null) setMoveCount(movedRef.current.size)
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  function resetLayout() {
    movedRef.current = new Map()
    setMoveCount(0)
    draw()
  }

  function onPointerLeave(e) {
    dragRef.current = null
    mouseRef.current = null
    // Touch fires pointerleave right after every lift; the pinned card stays.
    if (e.pointerType !== 'touch' && !pinnedRef.current) {
      hoverRef.current = null
      setHover(null)
    }
  }

  function fitView() {
    viewRef.current = { zoom: 1, panX: 0, panY: 0 }
    draw()
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen()
    else rootRef.current?.requestFullscreen?.()
  }

  async function openFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    setName(file.name)
    setLocalFile(true)
    setXml(await file.text())  // fully client-side: no upload, any NetAnim file
  }

  function seek(value) {
    clockRef.current = Number(value)
    setClock(clockRef.current)
    draw()
  }

  function restart() {
    if (!trace) return
    seek(trace.startTime)
    setPlaying(true)
  }

  const hoveredNode = hover?.kind === 'node' ? trace?.nodes.find((n) => n.id === hover.id) : null
  const hoveredAt = hoveredNode ? screenRef.current.get(hoveredNode.id) : null
  const nodeName = (id) => trace?.nodes.find((n) => n.id === id)?.label || `n${id}`
  const cardX = (x) => Math.max(4, Math.min(x, (wrapRef.current?.clientWidth ?? 0) - 220))

  return (
    <div
      ref={rootRef}
      className={`flex flex-col gap-2 ${fullscreen ? 'h-full bg-paper p-4' : ''}`}
    >
      {/* Fullscreen hides the surrounding card, so the viewer has to name
          itself — otherwise the canvas fills the screen unattributed. */}
      {fullscreen && (
        <div className="flex items-baseline gap-3 border-b border-rule pb-2">
          <h2 className="nameplate text-lg leading-none">{tr('anim.fullTitle')}</h2>
          {name && <span className="truncate font-mono text-xs text-ink-soft">{name}</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="xs" variant="outline" onClick={() => setPlaying((p) => !p)} disabled={!trace?.events.length}>
          {playing ? <Pause className="size-3" /> : <Play className="size-3" />}
          {tr(playing ? 'anim.pause' : 'anim.play')}
        </Button>
        <Button type="button" size="icon-xs" variant="outline" aria-label={tr('anim.restart')} onClick={restart}>
          <RotateCcw className="size-3" />
        </Button>
        <Select value={String(speed)} onValueChange={(v) => setSpeed(Number(v))}>
          {/* Wide enough for "0.001×" without the value being clipped. */}
          <SelectTrigger size="sm" className="w-24" aria-label={tr('anim.speed')}>
            <SelectValue />
          </SelectTrigger>
          {/* In fullscreen the dropdown has to live inside the fullscreen
              element; portalled to document.body it would not be painted. */}
          <SelectContent container={fullscreen ? rootRef.current : undefined}>
            {SPEEDS.map((s) => (
              <SelectItem key={s} value={String(s)}>{s}×</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="font-mono text-xs text-ink-soft">{clock.toFixed(3)} s</span>

        <span className="mx-1 h-4 w-px bg-rule" aria-hidden="true" />
        <Button type="button" size="icon-xs" variant="outline" aria-label={tr('anim.zoomIn')} onClick={() => zoomBy(1.3)}>
          <ZoomIn className="size-3" />
        </Button>
        <Button type="button" size="icon-xs" variant="outline" aria-label={tr('anim.zoomOut')} onClick={() => zoomBy(1 / 1.3)}>
          <ZoomOut className="size-3" />
        </Button>
        {moveCount > 0 && (
          <Button type="button" size="icon-xs" variant="outline" aria-label={tr('anim.resetLayout')} onClick={resetLayout}>
            <Undo2 className="size-3" />
          </Button>
        )}
        {/* Frame, not Scan: Scan's corner brackets read as the fullscreen
            icon sitting right beside it. */}
        <Button type="button" size="icon-xs" variant="outline" aria-label={tr('anim.fit')} onClick={fitView}>
          <Frame className="size-3" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="outline"
          aria-label={tr(fullscreen ? 'anim.exitFullscreen' : 'anim.fullscreen')}
          aria-pressed={fullscreen}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <Minimize className="size-3" /> : <Maximize className="size-3" />}
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {name && <span className="max-w-56 truncate font-mono text-xs text-ink-soft">{name}</span>}
          <Button type="button" size="xs" variant="outline" onClick={() => fileInput.current?.click()}>
            <Upload className="size-3" />
            {tr('anim.openFile')}
          </Button>
          <input ref={fileInput} type="file" accept=".xml,application/xml,text/xml" className="hidden" onChange={openFile} />
        </div>
      </div>

      <input
        type="range"
        aria-label={tr('anim.timeline')}
        className="w-full accent-[var(--signal)]"
        min={trace?.startTime ?? 0}
        max={trace?.endTime ?? 1}
        step={Math.max((span || 1) / 2000, 1e-6)}
        value={clock}
        onChange={(e) => seek(e.target.value)}
        disabled={!trace}
      />

      <div
        ref={wrapRef}
        className={`relative w-full overflow-hidden border border-rule bg-panel ${
          fullscreen ? 'min-h-0 flex-1' : 'h-[26rem]'
        }`}
      >
        <canvas
          ref={canvasRef}
          className="h-full w-full cursor-grab touch-none"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
        />
        {hoveredNode && hoveredAt && (
          <div
            className="pointer-events-none absolute z-10 min-w-44 border border-rule-strong bg-paper px-2.5 py-2 shadow-md"
            style={{ left: cardX(hoveredAt[0] + 14), top: Math.max(hoveredAt[1] - 10, 4) }}
          >
            <p className="font-mono text-xs font-semibold">{hoveredNode.label || `n${hoveredNode.id}`}</p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 font-mono text-[0.6875rem] text-ink-soft">
              <dt>id</dt>
              <dd className="text-ink">{hoveredNode.id}</dd>
              {deviceKey(hoveredNode, profiles) && (
                <>
                  <dt>{tr('anim.device')}</dt>
                  <dd className="text-ink">{deviceKey(hoveredNode, profiles)}</dd>
                </>
              )}
              {hoveredNode.addresses.map((ip) => (
                <span key={ip} className="contents">
                  <dt>ip</dt>
                  <dd className="text-ink">{ip}</dd>
                </span>
              ))}
              {hoveredNode.mac && (
                <>
                  <dt>mac</dt>
                  <dd className="text-ink">{hoveredNode.mac}</dd>
                </>
              )}
              {hoveredNode.channel && (
                <>
                  <dt>{tr('anim.channel')}</dt>
                  <dd className="text-ink">{hoveredNode.channel.replace('ns3::', '')}</dd>
                </>
              )}
              <dt>pos</dt>
              <dd className="text-ink">
                {nodeAt(hoveredNode, clock).x}, {nodeAt(hoveredNode, clock).y}
              </dd>
              <dt>tx / rx</dt>
              <dd className="text-ink">
                {counts.get(hoveredNode.id)?.tx ?? 0} / {counts.get(hoveredNode.id)?.rx ?? 0}
              </dd>
            </dl>
          </div>
        )}
        {hover?.kind === 'packet' && (
          <div
            className="pointer-events-none absolute z-10 min-w-52 border border-rule-strong bg-paper px-2.5 py-2 shadow-md"
            style={{ left: cardX(mouse.x + 14), top: Math.max(mouse.y - 10, 4) }}
          >
            <p className="font-mono text-xs font-semibold text-signal">
              {nodeName(hover.e.from)} → {nodeName(hover.e.to)}
            </p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 font-mono text-[0.6875rem] text-ink-soft">
              <dt>{tr('anim.pkt.tx')}</dt>
              <dd className="text-ink">{hover.e.tx.toFixed(6)} s</dd>
              <dt>{tr('anim.pkt.rx')}</dt>
              <dd className="text-ink">{hover.e.rx.toFixed(6)} s</dd>
              <dt>{tr('anim.pkt.latency')}</dt>
              <dd className="text-ink">{formatSeconds(hover.e.rx - hover.e.tx)}</dd>
              {hover.e.wire != null && (
                <>
                  <dt>{tr('anim.pkt.wire')}</dt>
                  <dd className="text-ink">{formatSeconds(hover.e.wire)}</dd>
                </>
              )}
              {hover.e.uid != null && (
                <>
                  <dt>uid</dt>
                  <dd className="text-ink">{hover.e.uid}</dd>
                </>
              )}
              {hover.e.fanout > 1 && (
                <>
                  <dt>{tr('anim.pkt.fanout')}</dt>
                  <dd className="text-ink">{tr('anim.pkt.receivers', { n: hover.e.fanout })}</dd>
                </>
              )}
            </dl>
            {hover.e.meta && (
              <p className="mt-1.5 max-w-72 border-t border-rule pt-1.5 font-mono text-[0.625rem] leading-snug break-words text-ink">
                {hover.e.meta}
              </p>
            )}
          </div>
        )}
        {/* Opened from the navbar there is no run to fetch, so the viewer is
            waiting for a file, not loading one — saying "loading" there looks
            like it hung. */}
        {!trace && !error && (
          <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-ink-soft">
            {tr(source ? 'anim.loading' : 'anim.awaitingFile')}
          </p>
        )}
      </div>

      {devices.size > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="eyebrow">{tr('anim.devices')}</span>
          {[...devices].map(([key, entry]) => (
            <span key={key} className="flex items-center gap-1.5 font-mono text-[0.6875rem] text-ink-soft">
              <span
                className="size-2.5 shrink-0 rounded-[1px]"
                style={{ backgroundColor: entry.color }}
                aria-hidden="true"
              />
              {entry.name}
              <span className="text-ink-soft/70">×{entry.count}</span>
            </span>
          ))}
        </div>
      )}

      {error && <p className="border-l-2 border-alert bg-alert/5 px-3 py-2 text-sm text-alert">{error}</p>}

      {trace && !fullscreen && (
        <p className="text-[0.6875rem] leading-snug text-ink-soft">
          {tr('anim.caption', {
            nodes: trace.nodes.length,
            events: trace.events.length,
            from: trace.startTime.toFixed(2),
            to: trace.endTime.toFixed(2),
          })}{' '}
          {/* Medium and traffic are different questions with different answers
              — a csma run is a bus that carries a star — and naming only one of
              them is what made the label look wrong against the picture. */}
          <span className="text-ink">
            {tr('anim.medium')}: {tr(`anim.topo.${topology.kind}`, { parts: topology.media.join(' + ') })}
            {topology.kind === 'star' && topology.hub != null
              ? ` (${tr('anim.topo.hub', { node: nodeName(topology.hub) })})`
              : ''}
            {topology.traffic.kind === 'star' && topology.traffic.hub != null
              ? ` · ${tr('anim.traffic')}: ${tr('anim.topo.star')} ${tr('anim.topo.hub', {
                  node: nodeName(topology.traffic.hub),
                })}`
              : ''}
            .
          </span>{' '}
          {/* Short on purpose: the long-form explanation of why the medium and
              the traffic differ, and of what a stretched flight time does and
              does not claim, belongs in the thesis, not under every canvas. */}
          {tr(topology.observed ? 'anim.topo.observedShort' : 'anim.topo.declaredShort')}{' '}
          {tr('anim.controlsNote')}
        </p>
      )}

      {/* Emulation traces animate the containers' real traffic; say so, because
          "real packets" is the whole point of that mode. */}
      {trace && note && !fullscreen && (
        <p className="border-l-2 border-signal-edge bg-sunk px-3 py-2 text-xs leading-snug text-ink-soft">{note}</p>
      )}
    </div>
  )
}

const sameHover = (a, b) => {
  if (!a || !b) return a === b
  if (a.kind !== b.kind) return false
  return a.kind === 'node' ? a.id === b.id : a.e === b.e
}

// Nodes win over packets: a node is a fixed target the user aimed at, a packet
// happens to be passing over it.
// Which device is under this point, if any. Shared by hover and by drag, so
// "what the card describes" and "what the gesture grabs" can never disagree.
function nodeUnder(point, pos) {
  if (!point) return null
  for (const [id, [x, y]] of pos) {
    if (Math.abs(x - point.x) <= HIT_RADIUS && Math.abs(y - point.y) <= HIT_RADIUS) return id
  }
  return null
}

// A press that moves less than this many pixels counts as a tap, not a drag.
const TAP_SLOP = 8

function hitTest(point, pos, drawn, packetR = PACKET_HIT_R) {
  if (!point) return null
  const id = nodeUnder(point, pos)
  if (id != null) return { kind: 'node', id }
  for (const p of drawn) {
    if (Math.hypot(p.x - point.x, p.y - point.y) <= packetR) {
      return { kind: 'packet', e: p.e, x: p.x, y: p.y }
    }
  }
  return null
}

// Devices within this many pixels of each other vertically share one cable
// segment. A tolerance rather than an equality test, because nodes can be
// dragged and a hand-placed row is never pixel-exact.
const BUS_ROW_TOLERANCE = 14

// Where the bus cable runs on screen: one horizontal segment per row of
// devices, joined by a riser down the left. Computed once per frame and used
// twice — to draw the cable, and to route packets along it, which is the only
// way the two can agree.
function busGeometry(topo, pos) {
  if (topo?.kind !== 'bus' && topo?.kind !== 'hybrid') return null
  const taps = topo.bus.map((id) => [id, pos.get(id)]).filter(([, p]) => p)
  if (taps.length < 2) return null

  const rows = new Map()
  for (const [id, [x, y]] of taps) {
    const key = Math.round(y / BUS_ROW_TOLERANCE)
    if (!rows.has(key)) rows.set(key, [])
    rows.get(key).push([id, x, y])
  }
  const bars = []
  const barOf = new Map() // node id -> its bar, for routing
  for (const members of rows.values()) {
    const ys = members.map(([, , y]) => y)
    const bar = {
      // Below the name and the address, not through them.
      y: Math.max(...ys) + BODY_H / 2 + 36,
      maxX: Math.max(...members.map(([, x]) => x)),
      minX: Math.min(...members.map(([, x]) => x)),
      taps: members.map(([, x, y]) => [x, y]),
    }
    bars.push(bar)
    for (const [id] of members) barOf.set(id, bar)
  }
  bars.sort((a, b) => a.y - b.y)
  return { bars, barOf, riserX: Math.min(...bars.map((bar) => bar.minX)) - 20 }
}

// The route a packet takes from one device to another over a bus: down its own
// drop cable, along the backbone (via the riser when the two are on different
// rows), then up the other drop. Drawing the cable but flying the packets
// straight through the air across it was the thing that made a wired run look
// like it had no wires at all.
function busRoute(geom, from, to, a, c) {
  const barA = geom.barOf.get(from)
  const barC = geom.barOf.get(to)
  if (!barA || !barC) return null
  const path = [
    [a[0], a[1] + BODY_H / 2],
    [a[0], barA.y],
  ]
  if (barA !== barC) {
    path.push([geom.riserX, barA.y], [geom.riserX, barC.y])
  }
  path.push([c[0], barC.y], [c[0], c[1] + BODY_H / 2])
  return path
}

// A point at `t` (0..1) of the way along a polyline, measured by real length so
// the packet keeps a constant speed around the corners instead of hurrying
// through the short segments.
function alongPath(path, t) {
  let total = 0
  const seg = []
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
    seg.push(d)
    total += d
  }
  if (total === 0) return path[0]
  let want = Math.max(0, Math.min(1, t)) * total
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i] || i === seg.length - 1) {
      const f = seg[i] ? want / seg[i] : 0
      return [
        path[i][0] + (path[i + 1][0] - path[i][0]) * f,
        path[i][1] + (path[i + 1][1] - path[i][1]) * f,
      ]
    }
    want -= seg[i]
  }
  return path[path.length - 1]
}

// The wiring, drawn as the shape it actually is. A bus is one cable everyone
// taps into, not a line per pair; a star is spokes to one node; observed radio
// links are dashed, because "these two exchanged packets" is a weaker claim
// than a cable and should not look like one.
function drawTopology(ctx, topo, pos, theme, hoveredId, nodeCount, geom) {
  if (!topo) return
  ctx.save()

  if (topo.kind === 'bus' || topo.kind === 'hybrid') {
    const points = topo.bus.map((id) => pos.get(id)).filter(Boolean)
    if (geom) {
      const { bars, riserX } = geom
      ctx.strokeStyle = theme.ruleStrong
      ctx.lineWidth = 3
      ctx.beginPath()
      for (const bar of bars) {
        ctx.moveTo(riserX, bar.y)
        ctx.lineTo(bar.maxX + 20, bar.y)
      }
      if (bars.length > 1) {
        ctx.moveTo(riserX, bars[0].y)
        ctx.lineTo(riserX, bars[bars.length - 1].y)
      }
      ctx.stroke()

      ctx.lineWidth = 1.5
      ctx.fillStyle = theme.ruleStrong
      for (const bar of bars) {
        for (const [x, nodeY] of bar.taps) {
          ctx.beginPath()
          ctx.moveTo(x, nodeY + BODY_H / 2)
          ctx.lineTo(x, bar.y)
          ctx.stroke()
          ctx.fillRect(x - 2.5, bar.y - 2.5, 5, 5)
        }
      }
    }
    if (topo.kind === 'bus') {
      ctx.restore()
      return
    }
  }

  // A hairball helps nobody: past a certain size the observed mesh is drawn
  // only for the node being inspected.
  const onlyHovered = topo.observed && nodeCount > MESH_ALL_LIMIT
  if (onlyHovered && hoveredId == null) {
    ctx.restore()
    return
  }
  if (topo.observed) ctx.setLineDash([4, 4])

  for (const edge of topo.edges) {
    if (onlyHovered && edge.from !== hoveredId && edge.to !== hoveredId) continue
    const a = pos.get(edge.from)
    const c = pos.get(edge.to)
    if (!a || !c) continue
    const touchesHover = hoveredId != null && (edge.from === hoveredId || edge.to === hoveredId)
    // Busier links read stronger, so the shape of the traffic is visible even
    // when every pair in range technically has an edge.
    ctx.globalAlpha = touchesHover ? 0.9 : 0.25 + 0.45 * (edge.weight / topo.maxWeight)
    ctx.strokeStyle = touchesHover ? theme.signal : theme.ruleStrong
    ctx.lineWidth = touchesHover ? 2 : 1.5
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(c[0], c[1])
    ctx.stroke()
  }
  ctx.restore()
}

// A device, not a dot: a body with a wireless antenna or a wired port, so the
// picture reads as hardware on a network (thesis figures come out of this).
function drawDevice(ctx, x, y, node, theme, color, hovered, active, trace, isHub) {
  const w = BODY_W
  const h = BODY_H
  // The hub of a star is the sink/cluster head; it earns a bigger body.
  const sx = isHub ? 1.35 : 1
  ctx.lineWidth = hovered ? 2.5 : 1.6
  ctx.strokeStyle = color
  ctx.fillStyle = theme.paper

  ctx.beginPath()
  ctx.roundRect(x - (w * sx) / 2, y - (h * sx) / 2, w * sx, h * sx, 3)
  ctx.fill()
  // A tint of the device colour, so profiles are told apart by fill as well as
  // by outline — an outline alone is thin at 100 nodes.
  ctx.globalAlpha = 0.16
  ctx.fillStyle = color
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.stroke()

  if (hovered || active) {
    // The packet accent marks activity; the device colour stays its identity.
    ctx.strokeStyle = theme.signal
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.roundRect(x - (w * sx) / 2 - 3, y - (h * sx) / 2 - 3, w * sx + 6, h * sx + 6, 4)
    ctx.stroke()
  }

  // Status LED, so a device reads as powered even when idle.
  ctx.fillStyle = active ? theme.signal : theme.ok
  ctx.beginPath()
  ctx.arc(x - (w * sx) / 2 + 4.5, y, 1.8, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = color
  ctx.lineWidth = 1.6
  if (isWireless(node, trace)) {
    const ax = x + (w * sx) / 2 - 5
    const ay = y - (h * sx) / 2
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(ax, ay - 6)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(ax, ay - 6, 2, Math.PI, 0)
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.moveTo(x, y + (h * sx) / 2)
    ctx.lineTo(x, y + (h * sx) / 2 + 5)
    ctx.stroke()
  }
}

// Grid spacing rounded to 1/2/5 x 10^n, so the reference lines land on
// readable world coordinates.
function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1
  const pow = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / pow
  return (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * pow
}
