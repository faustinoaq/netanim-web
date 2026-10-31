// NetAnim XML -> a shape the viewer can animate.
//
// Deliberately tolerant: ns-3 versions emit noticeably different traces, and
// the viewer is meant to open ANY NetAnim file, not only the ones SSBCV
// produces. Anything unrecognised is skipped rather than fatal.
//
// What our own traces (pip ns3 3.44) actually contain, verified against
// results/*/anim.xml:
//   wired     <p fId tId fbTx lbTx fbRx lbRx/>      — lbRx is often 0 (!)
//   wireless  <pr uId fId fbTx/>  transmissions
//             <wpr uId tId fbRx lbRx/>  receptions, joined to <pr> by uId
//   nodes     <node id locX locY/>, <link fromId toId/>
// Older/other versions use <packet>/<wpacket> with fromId/toId instead.

// Scanned rather than parsed into a DOM. A NetAnim trace is a flat list of
// self-closing elements, and real ones get big: a 20 s wifi emulation produced
// 5 MB with ~100k elements, which took 3.4 s through DOMParser +
// querySelectorAll — long enough to freeze the tab. One regex pass over the
// text does the same job in a fraction of that, and is more tolerant of the
// dialect differences between ns-3 versions, which is what this parser wants.
const ELEMENT_RE = /<(node|link|nu|nonp2plinkproperties|p|pr|wpr|packet|wpacket)\s([^>]*?)\/?>/g
// <ip n="0"><address>10.1.1.1</address>...</ip> — the per-node address list.
const IP_BLOCK_RE = /<ip\s+n\s*=\s*"(\d+)"\s*>([\s\S]*?)<\/ip>/g
const ADDRESS_RE = /<address\s*>([^<]*)<\/address>/g
const ATTR_RE = /([a-zA-Z_][\w:.-]*)\s*=\s*"([^"]*)"/g

function attrs(raw) {
  const out = {}
  ATTR_RE.lastIndex = 0
  let m
  while ((m = ATTR_RE.exec(raw)) !== null) out[m[1]] = m[2]
  return out
}

const num = (el, name) => {
  const raw = el[name]
  if (raw == null || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

// A packet that arrives before it left, or in zero time, cannot be drawn
// travelling; give it a short visible flight instead of dividing by zero.
const MIN_FLIGHT_S = 1e-4

function pushEvent(events, from, to, tx, rx, extra) {
  if (from == null || to == null || tx == null || from === to) return
  const arrival = rx != null && rx > tx ? rx : tx + MIN_FLIGHT_S
  events.push({ from, to, tx, rx: arrival, ...extra })
}

export function parseNetAnim(xmlText) {
  if (typeof xmlText !== 'string' || !/<anim\b/.test(xmlText)) {
    throw new Error('Not a NetAnim trace (no <anim> element)')
  }

  const nodes = new Map()
  const links = []
  const events = []
  // Wireless transmissions and receptions are separate elements joined by uId,
  // and one transmission can have several receivers (broadcast medium): each
  // pair becomes its own drawn hop.
  const txByUid = new Map()
  const pendingRx = []

  ELEMENT_RE.lastIndex = 0
  let match
  while ((match = ELEMENT_RE.exec(xmlText)) !== null) {
    const tag = match[1]
    const el = attrs(match[2])

    if (tag === 'node') {
      const id = num(el, 'id')
      if (id != null) {
        nodes.set(id, {
          id,
          x: num(el, 'locX') ?? 0,
          y: num(el, 'locY') ?? 0,
          moves: [],
          label: null,
          addresses: [],
          mac: null,
          channel: null,
          // Every channel class the node has a device on: an access point sits
          // on a Wi-Fi channel and a CSMA one at the same time.
          channels: [],
          // AnimationInterface::UpdateNodeColor keyframes, honoured as given.
          colors: [],
        })
      }
    } else if (tag === 'nonp2plinkproperties') {
      // "10.1.1.1~00:00:00:00:00:01" plus the channel class: the closest thing
      // the trace has to a device identity, and what NetAnim shows beside a node.
      const node = nodes.get(num(el, 'id'))
      const [ip, mac] = (el.ipAddress || '').split('~')
      if (node && ip && ip !== '127.0.0.1') {
        if (!node.addresses.includes(ip)) node.addresses.push(ip)
        if (mac && mac !== '00:00:00:00:00:00') node.mac = mac
        if (el.channelType && el.channelType !== 'Unknown channel') {
          if (!node.channel) node.channel = el.channelType
          if (!node.channels.includes(el.channelType)) node.channels.push(el.channelType)
        }
      }
    } else if (tag === 'link') {
      const from = num(el, 'fromId')
      const to = num(el, 'toId')
      if (from != null && to != null && from !== to) links.push({ from, to })
      // p2p links carry "ip~mac" for each end; NetAnim labels the link with them.
      for (const [nodeId, spec] of [[from, el.fd], [to, el.td]]) {
        const node = nodes.get(nodeId)
        const [ip, mac] = (spec || '').split('~')
        if (node && ip && ip !== '127.0.0.1') {
          if (!node.addresses.includes(ip)) node.addresses.push(ip)
          if (mac && mac !== '00:00:00:00:00:00') node.mac = mac
        }
      }
    } else if (tag === 'nu') {
      const node = nodes.get(num(el, 'id'))
      if (!node) continue
      if (el.p === 'd') {
        // Node description (AnimationInterface::UpdateNodeDescription): SSBCV
        // writes "<name> <profile>" so a node reads as a device, not an index.
        node.label = el.descr ?? el.d ?? node.label
      } else if (el.p === 'p') {
        // Mobility keyframe. Our scenarios are static; external traces move.
        const t = num(el, 't')
        const x = num(el, 'x') ?? num(el, 'locX')
        const y = num(el, 'y') ?? num(el, 'locY')
        if (t != null && x != null && y != null) node.moves.push({ t, x, y })
      } else if (el.p === 'c') {
        // Node colour (AnimationInterface::UpdateNodeColor). Desktop NetAnim
        // paints the node with it, and examples use it to tell roles apart.
        const r = num(el, 'r')
        const g = num(el, 'g')
        const b = num(el, 'b')
        if (r != null && g != null && b != null) {
          node.colors.push({ t: num(el, 't') ?? 0, color: `rgb(${r}, ${g}, ${b})` })
        }
      }
    } else if (tag === 'p' || tag === 'packet') {
      // Wired. lbRx is 0 in csma traces, so it cannot be trusted as the
      // arrival time; fbRx (first bit received) is the honest one.
      const fbRx = num(el, 'fbRx')
      const lbRx = num(el, 'lbRx')
      const fbTx = num(el, 'fbTx')
      const lbTx = num(el, 'lbTx')
      const from = num(el, 'fId') ?? num(el, 'fromId')
      const to = num(el, 'tId') ?? num(el, 'toId')
      const rx = Math.max(fbRx ?? 0, lbRx ?? 0) || fbRx
      // ns-3 writes every wired packet twice (once from the tx trace source,
      // once from the rx one), always adjacent and byte-identical. Counting
      // both would double the reported traffic and draw two dots on the same
      // pixel, so the repeat is dropped.
      const prev = events[events.length - 1]
      if (prev && prev.from === from && prev.to === to && prev.tx === fbTx && prev.rx === rx) continue
      pushEvent(events, from, to, fbTx, rx, {
        wire: lbTx != null && fbTx != null && lbTx > fbTx ? lbTx - fbTx : null,
        meta: el['meta-info'] ?? null,
      })
    } else if (tag === 'pr') {
      const uid = num(el, 'uId')
      const from = num(el, 'fId')
      const tx = num(el, 'fbTx')
      if (uid != null && from != null && tx != null) {
        txByUid.set(uid, { from, tx, meta: el['meta-info'] ?? null })
      }
    } else if (tag === 'wpr' || tag === 'wpacket') {
      const fbRx = num(el, 'fbRx')
      const lbRx = num(el, 'lbRx')
      pendingRx.push({
        uid: num(el, 'uId'),
        from: num(el, 'fId') ?? num(el, 'fromId'),
        tx: num(el, 'fbTx'),
        to: num(el, 'tId') ?? num(el, 'toId'),
        rx: Math.max(fbRx ?? 0, lbRx ?? 0) || fbRx,
      })
    }
  }

  // <ip> blocks are nested, so they are read separately from the flat scan.
  IP_BLOCK_RE.lastIndex = 0
  let ipBlock
  while ((ipBlock = IP_BLOCK_RE.exec(xmlText)) !== null) {
    const node = nodes.get(Number(ipBlock[1]))
    if (!node) continue
    ADDRESS_RE.lastIndex = 0
    let addr
    while ((addr = ADDRESS_RE.exec(ipBlock[2])) !== null) {
      const ip = addr[1].trim()
      if (ip && ip !== '127.0.0.1' && !node.addresses.includes(ip)) node.addresses.push(ip)
    }
  }

  // Receptions are resolved after the pass: a <wpr> can precede its <pr>.
  for (const r of pendingRx) {
    const sent = txByUid.get(r.uid)
    pushEvent(events, sent?.from ?? r.from, r.to, sent?.tx ?? r.tx, r.rx, {
      uid: r.uid,
      meta: sent?.meta ?? null,
    })
  }

  for (const node of nodes.values()) {
    if (node.moves.length) node.moves.sort((a, b) => a.t - b.t)
    if (node.colors.length) node.colors.sort((a, b) => a.t - b.t)
  }
  // AnimationInterface writes a red colour for every node when it starts, so a
  // trace where no node is ever anything but red carries no colour choice at
  // all; honouring it would paint every device the same. Colours count only
  // once the author has set some other one with UpdateNodeColor.
  const DEFAULT_RED = 'rgb(255, 0, 0)'
  const chosen = [...nodes.values()].some((node) => node.colors.some((c) => c.color !== DEFAULT_RED))
  if (!chosen) for (const node of nodes.values()) node.colors = []
  events.sort((a, b) => a.tx - b.tx)

  // Nodes referenced by events but never declared (partial traces): place them
  // so the animation still draws instead of dropping those hops.
  for (const e of events) {
    for (const id of [e.from, e.to]) {
      if (!nodes.has(id)) {
        nodes.set(id, { id, x: id * 10, y: 0, moves: [], label: null, addresses: [], mac: null, channel: null, channels: [], colors: [] })
      }
    }
  }

  // One transmission on a shared medium (csma bus, wifi ad-hoc) is recorded
  // once per receiver. Grouping by sender+instant recovers "this was a
  // broadcast heard by N nodes", which is what the packet card reports.
  const fanout = new Map()
  for (const e of events) {
    const key = `${e.from}|${e.tx}`
    fanout.set(key, (fanout.get(key) ?? 0) + 1)
  }
  events.forEach((e, i) => {
    e.i = i
    e.fanout = fanout.get(`${e.from}|${e.tx}`) ?? 1
  })

  const nodeList = [...nodes.values()].sort((a, b) => a.id - b.id)
  const startTime = events.length ? events[0].tx : 0
  const endTime = events.reduce((max, e) => Math.max(max, e.rx), startTime)
  // Longest flight, so the renderer knows how far back to look for events that
  // are still in the air at a given instant.
  const maxFlight = events.reduce((max, e) => Math.max(max, e.rx - e.tx), 0)

  return {
    nodes: nodeList,
    links,
    events,
    startTime,
    endTime: endTime > startTime ? endTime : startTime + 1,
    maxFlight,
    wireless: txByUid.size > 0,
  }
}

// How many observed edges we are willing to draw. Beyond this the picture is
// noise rather than topology, and the weakest links are the least informative.
const MAX_TOPOLOGY_EDGES = 400

// What shape is this network?
//
// TWO shapes, and conflating them is what made a csma run read as "shared bus"
// while the picture on screen was plainly a star. They are both true:
//
//   the MEDIUM   what carries the bits. One cable everyone taps (csma bus), one
//                wire per pair (p2p), or radio in range of radio (mesh).
//   the TRAFFIC  who actually talks to whom over it. Every SSBCV scenario puts
//                the server on n0 — UdpEchoServer in simulation, the iperf3
//                servers in emulation — so the traffic is a star toward n0
//                even when the medium is a bus. That star is the sink /
//                cluster-head shape of a WSAN, and it is worth naming.
//
// A NetAnim trace states neither. It declares point-to-point links (<link>) and
// the channel class each device sits on (<nonp2plinkproperties channelType=...>)
// and nothing else — a wifi ad-hoc trace declares no links at all — so the
// medium is reconstructed, and the traffic is counted from the events.
//
// The edges for wireless are OBSERVED, not declared: A—B means "a packet went
// from A to B during the run", i.e. they were in range and did talk. That is a
// weaker claim than a cable, and the viewer draws them dashed to say so.
export function inferTopology(trace, run) {
  const n = trace.nodes.length
  const wired = trace.links.length > 0
  // A run opened from SSBCV knows which scenario produced it, and a declared
  // fact beats an inference. It matters most in emulation: those traces carry
  // no addresses and no channel types at all (the containers own the IPs, so
  // ns-3 has nothing to write down), which leaves every packet pair looking
  // like a mesh edge when the medium is really one shared bus.
  const declared = run?.scenario ?? null
  const declaredBus = declared === 'csma'
  const onChannel = (node, re) => (node.channels?.length ? node.channels : [node.channel || '']).some((c) => re.test(c))
  const busNodes = declaredBus
    ? trace.nodes.map((node) => node.id)
    : trace.nodes.filter((node) => onChannel(node, BUS_CHANNEL)).map((node) => node.id)
  const radioNodes = declared
    ? []
    : trace.nodes.filter((node) => onChannel(node, RADIO_CHANNEL)).map((node) => node.id)
  // A LAN behind an access point: some devices share a cable, others reach
  // them by radio. Neither "bus" nor "mesh" alone describes it, so the cable is
  // drawn as a bus and the radio hops as observed links on top of it.
  const hybrid = busNodes.length >= 2 && radioNodes.length >= 2
  const busSet = new Set(busNodes)

  const edges = new Map() // "a|b" (a<b) -> weight
  const bump = (a, b, w = 1) => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    edges.set(key, (edges.get(key) ?? 0) + w)
  }

  if (wired) {
    for (const l of trace.links) bump(l.from, l.to)
  }
  if (hybrid) {
    // Frames between two devices on the cable travel the bus; only the rest
    // went over the air.
    for (const e of trace.events) if (!(busSet.has(e.from) && busSet.has(e.to))) bump(e.from, e.to)
  } else if (!wired && busNodes.length < 2) {
    for (const e of trace.events) bump(e.from, e.to)
  }

  const degree = new Map()
  for (const key of edges.keys()) {
    const [a, b] = key.split('|').map(Number)
    degree.set(a, (degree.get(a) ?? 0) + 1)
    degree.set(b, (degree.get(b) ?? 0) + 1)
  }
  let hub = null
  let hubDegree = 0
  for (const [id, d] of degree) {
    if (d > hubDegree) { hub = id; hubDegree = d }
  }

  // The classic taxonomy — bus, star, ring, tree, mesh, hybrid — is the right
  // vocabulary, and the viewer opens files from any ns-3 project, so it names
  // all of it. SSBCV itself can only *produce* bus, p2p and mesh today: a real
  // star or tree medium needs a switch (BridgeHelper) and a ring needs p2p
  // links wired in a cycle. See the roadmap.
  const degrees = [...degree.values()]
  let kind = 'unknown'
  if (hybrid) {
    kind = 'hybrid'
  } else if (busNodes.length >= 2) {
    kind = 'bus'
  } else if (wired && degrees.every((d) => d <= 1)) {
    kind = 'p2p'
  } else if (n > 2 && hubDegree >= n - 1 && edges.size <= (n - 1) * 1.35) {
    // Every leaf reaches the hub, and there are barely more edges than leaves:
    // the traffic that exists is traffic to and from one node.
    kind = 'star'
  } else if (n > 2 && degree.size === n && degrees.every((d) => d === 2) && edges.size === n) {
    // Every node has exactly two neighbours and there are as many edges as
    // nodes: one closed cycle.
    kind = 'ring'
  } else if (n > 2 && edges.size === n - 1 && isConnected(edges, degree, n)) {
    // Connected with no cycle to spare. A star is a tree too, but it was
    // already claimed above, so what lands here is the branching kind.
    kind = 'tree'
  } else if (edges.size > 0) {
    kind = 'mesh'
  }

  const list = [...edges].map(([key, weight]) => {
    const [from, to] = key.split('|').map(Number)
    return { from, to, weight }
  })
  list.sort((a, b) => b.weight - a.weight)
  const maxWeight = list.length ? list[0].weight : 1

  return {
    kind,
    hub: kind === 'star' ? hub : null,
    bus: busNodes,
    wired: wired || busNodes.length >= 2,
    // Declared links are facts; observed ones are inferred from traffic.
    observed: hybrid || (!wired && busNodes.length < 2),
    // What the hybrid is made of, for the caption ("CSMA + Wi-Fi").
    media: hybrid ? mediaNames(trace) : [],
    edges: list.slice(0, MAX_TOPOLOGY_EDGES),
    edgeCount: list.length,
    maxWeight,
    // The caption distinguishes "the run told us this" from "we worked it out".
    declared: Boolean(declared),
    traffic: trafficShape(trace, n, run),
  }
}

const BUS_CHANNEL = /csma|bus|lan|ethernet/i
const RADIO_CHANNEL = /wifi|wireless|yans|spectrum|lr-?wpan|lte|uan|wave/i

// Short names for the channel classes present, in a stable order.
function mediaNames(trace) {
  const all = new Set(trace.nodes.flatMap((node) => node.channels ?? []))
  const names = []
  const has = (re) => [...all].some((c) => re.test(c))
  if (has(BUS_CHANNEL)) names.push('CSMA')
  if (has(/wifi|yans/i)) names.push('Wi-Fi')
  if (has(/lr-?wpan/i)) names.push('802.15.4')
  if (has(/lte/i)) names.push('LTE')
  if (trace.links.length) names.push('p2p')
  return names
}

// Does one walk reach every node that has an edge? Tells a tree apart from a
// forest plus a spare cycle, which have the same edge count.
function isConnected(edges, degree, n) {
  if (degree.size !== n) return false
  const adj = new Map()
  for (const key of edges.keys()) {
    const [a, b] = key.split('|').map(Number)
    if (!adj.has(a)) adj.set(a, [])
    if (!adj.has(b)) adj.set(b, [])
    adj.get(a).push(b)
    adj.get(b).push(a)
  }
  const seen = new Set()
  const stack = [degree.keys().next().value]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    for (const next of adj.get(id) ?? []) if (!seen.has(next)) stack.push(next)
  }
  return seen.size === n
}

// A node has to be an endpoint of at least this share of the packets before the
// traffic is called a star around it. Broadcast ARP and the odd stray exchange
// are normal on any medium and must not break the classification.
const STAR_SHARE = 0.75

// Who talks to whom — a different question from what carries the bits, and the
// one that makes a csma run "look like a star" while its medium is a bus.
//
// On a shared medium it cannot be answered from the trace at all: ns-3 records
// one arrival per device on the channel, because at L1 every NIC on a bus does
// see every frame, so a unicast to n0 is indistinguishable from a broadcast
// (measured: every event in a 12-node csma run has fan-out 11). When the run is
// ours we do not have to guess — every SSBCV scenario puts the server on node 0
// (UdpEchoServer in simulation, the iperf3 servers in emulation) and the clients
// on the rest, which is a star toward the sink.
function trafficShape(trace, n, run) {
  if (run?.serverNode != null && n >= 3) {
    return { kind: 'star', hub: run.serverNode, declared: true }
  }
  if (n < 3 || !trace.events.length) return { kind: 'mixed', hub: null, declared: false }
  const touches = new Map()
  let total = 0
  for (const e of trace.events) {
    // One broadcast is one transmission, not one per receiver.
    const w = 1 / (e.fanout || 1)
    touches.set(e.from, (touches.get(e.from) ?? 0) + w)
    touches.set(e.to, (touches.get(e.to) ?? 0) + w)
    total += w
  }
  let hub = null
  let best = 0
  for (const [id, count] of touches) {
    if (count > best) { hub = id; best = count }
  }
  return best >= total * STAR_SHARE
    ? { kind: 'star', hub, declared: false }
    : { kind: 'mixed', hub: null, declared: false }
}

// Position of a node at time t, honouring mobility keyframes when present.
export function nodeAt(node, t) {
  if (!node.moves.length) return node
  let pos = node
  for (const m of node.moves) {
    if (m.t > t) break
    pos = m
  }
  return pos
}

// Colour of a node at time t when the trace sets one (UpdateNodeColor), else null.
export function colorAt(node, t) {
  if (!node.colors?.length) return null
  let color = node.colors[0].color
  for (const c of node.colors) {
    if (c.t > t) break
    color = c.color
  }
  return color
}

// World bounds with a margin, for fitting the trace into the canvas.
export function traceBounds(nodes) {
  if (!nodes.length) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of nodes) {
    for (const p of [n, ...n.moves]) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
  }
  // A single point (or a straight line of nodes) has no extent on some axis;
  // give it one so the fit does not divide by zero.
  if (maxX - minX < 1e-6) { minX -= 1; maxX += 1 }
  if (maxY - minY < 1e-6) { minY -= 1; maxY += 1 }
  return { minX, minY, maxX, maxY }
}
