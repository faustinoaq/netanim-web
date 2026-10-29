import { createContext, useCallback, useContext, useMemo, useState } from 'react'

// Lightweight i18n with no dependency. Two locales; the client's language
// picks the default (Spanish for es-*, English for everything else), and the
// choice is persisted. Strings support {var} interpolation via t(key, vars).

const STORAGE_KEY = 'netanim-web-lang'

const translations = {
  es: {
    'app.title': 'NetAnim Web',
    'app.tagline': 'Visor de trazas NetAnim de ns-3 en el navegador',
    'app.examples': 'Ejemplos',
    'app.example.csma': 'Bus CSMA, 10 nodos',
    'app.example.wifi': 'Wi-Fi ad hoc, 10 nodos',
    'app.github': 'Código en GitHub',
    'app.issues': 'Reportar un problema',
    'app.footer': 'Código abierto, licencia MIT. Los archivos se leen en tu navegador y no se suben a ningún servidor.',
    'app.origin': 'Nació como parte de SSBCV, una tesis de licenciatura en la Universidad de Panamá.',
    'app.theme': 'Cambiar tema',
    'anim.title': 'Animación de red',
    'anim.play': 'Reproducir',
    'anim.pause': 'Pausar',
    'anim.restart': 'Reiniciar la animación',
    'anim.speed': 'Velocidad',
    'anim.timeline': 'Línea de tiempo',
    'anim.openFile': 'Abrir archivo',
    'anim.loading': 'Cargando traza…',
    'anim.caption': '{nodes} nodos · {events} eventos de paquete · t = {from} a {to} s.',
    'anim.timeNote': 'La propagación real dura microsegundos: cada salto se dibuja estirado para poder verse, igual que hace NetAnim de escritorio. El orden y la dirección son fieles; la duración del vuelo en pantalla no.',
    'anim.emuNote': 'Traza de una emulación: los paquetes que ves son el tráfico real de los contenedores (ping e iperf3) animado al cruzar los dispositivos ns-3. El simulador no lo genera ni lo agenda —solo lo transporta— pero sí lo registra, así que la animación muestra tráfico real, no modelado.',
    'anim.open': 'Abrir anim.xml',
    'anim.zoomIn': 'Acercar',
    'anim.zoomOut': 'Alejar',
    'anim.fit': 'Ajustar a la vista',
    'anim.channel': 'canal',
    'anim.fullscreen': 'Pantalla completa',
    'anim.exitFullscreen': 'Salir de pantalla completa',
    'anim.back': 'Volver a la lectura',
    'anim.device': 'dispositivo',
    'anim.devices': 'Dispositivos',
    'anim.pkt.tx': 'sale',
    'anim.pkt.rx': 'llega',
    'anim.pkt.latency': 'latencia',
    'anim.pkt.wire': 'en el medio',
    'anim.pkt.fanout': 'difusión',
    'anim.pkt.receivers': '{n} receptores',
    'anim.topology': 'Topología',
    'anim.close': 'Cerrar el visor',
    'anim.runHasNoTrace': 'La prueba {id} no grabó una traza de NetAnim (se lanzó con netanim desactivado). Puedes abrir cualquier otro anim.xml desde aquí.',
    'anim.medium': 'Medio',
    'anim.traffic': 'Tráfico',
    'anim.topo.serverNote': 'El medio es lo que transporta los bits; el tráfico es quién le habla a quién. Todo escenario de SSBCV pone el servidor en n0 (UdpEchoServer en simulación, los servidores iperf3 en emulación) y los clientes en el resto, así que un bus compartido transporta una estrella hacia el sumidero: ambas cosas son ciertas a la vez. En un medio compartido el tráfico no se puede deducir de la traza —ns-3 registra una llegada por cada dispositivo del canal, porque en L1 toda tarjeta del bus sí ve toda trama—, por eso viene del escenario y no de una inferencia.',
    'anim.topo.p2p': 'punto a punto',
    'anim.topo.bus': 'bus compartido',
    'anim.topo.star': 'estrella',
    'anim.topo.mesh': 'malla',
    'anim.topo.ring': 'anillo',
    'anim.topo.tree': 'árbol',
    'anim.topo.unknown': 'sin enlaces declarados',
    'anim.topo.hub': 'centro en {node}',
    'anim.topo.declaredNote': 'Los enlaces son los que declara la traza (cable o canal compartido).',
    'anim.topo.runNote': 'La topología viene del escenario con que se lanzó la prueba, no de adivinarla: en emulación la traza no guarda direcciones ni tipos de canal (las IP son de los contenedores), así que sin ese dato un bus compartido parecería una malla.',
    'anim.topo.observedNote': 'La traza no declara enlaces: los que se dibujan (punteados) son observados —A y B intercambiaron paquetes, es decir estaban a alcance—, no cables.',
    'anim.topo.hoverNote': 'Con esta cantidad de nodos los enlaces se dibujan solo para el nodo bajo el cursor.',
    'anim.controlsNote': 'Arrastra un dispositivo para moverlo, o el fondo para desplazarte; rueda para acercar. Pasa el mouse por un nodo o por un paquete en vuelo para ver sus datos. El tiempo de vuelo en pantalla está estirado para poder verse.',
    'anim.topo.declaredShort': 'Los enlaces dibujados son los que declara la traza.',
    'anim.topo.observedShort': 'Los enlaces punteados son observados, no cables: A y B intercambiaron paquetes.',
    'anim.resetLayout': 'Restaurar las posiciones originales',
    'anim.viewer': 'Visor NetAnim',
    'anim.viewerDesc': 'Reproduce cualquier traza NetAnim (.xml) de un proyecto ns-3. El archivo se lee en tu navegador; no se sube a ningún lado.',
    'anim.fullTitle': 'NetAnim Web',
    'anim.awaitingFile': 'Abre un anim.xml con «Abrir archivo» o carga uno de los ejemplos. Sirve cualquier traza de NetAnim de ns-3; se lee en tu navegador y no se sube a ningún lado.',
  },
  en: {
    'app.title': 'NetAnim Web',
    'app.tagline': 'ns-3 NetAnim trace viewer in the browser',
    'app.examples': 'Examples',
    'app.example.csma': 'CSMA bus, 10 nodes',
    'app.example.wifi': 'Wi-Fi ad hoc, 10 nodes',
    'app.github': 'Source on GitHub',
    'app.issues': 'Report an issue',
    'app.footer': 'Open source, MIT license. Files are read in your browser and never uploaded.',
    'app.origin': 'Born as part of SSBCV, a bachelor thesis at the University of Panama.',
    'app.theme': 'Toggle theme',
    'anim.title': 'Network animation',
    'anim.play': 'Play',
    'anim.pause': 'Pause',
    'anim.restart': 'Restart the animation',
    'anim.speed': 'Speed',
    'anim.timeline': 'Timeline',
    'anim.openFile': 'Open file',
    'anim.loading': 'Loading trace…',
    'anim.caption': '{nodes} nodes · {events} packet events · t = {from} to {to} s.',
    'anim.timeNote': 'Real propagation takes microseconds: each hop is drawn stretched so it can be seen, exactly as desktop NetAnim does. Order and direction are faithful; the on-screen flight time is not.',
    'anim.emuNote': 'Emulation trace: the packets you see are the real container traffic (ping and iperf3) animated as it crosses the ns-3 devices. The simulator neither generates nor schedules it — it only carries it — but it does record it, so this animation shows real traffic, not modeled traffic.',
    'anim.open': 'Open anim.xml',
    'anim.zoomIn': 'Zoom in',
    'anim.zoomOut': 'Zoom out',
    'anim.fit': 'Fit to view',
    'anim.channel': 'channel',
    'anim.fullscreen': 'Fullscreen',
    'anim.exitFullscreen': 'Exit fullscreen',
    'anim.back': 'Back to the reading',
    'anim.device': 'device',
    'anim.devices': 'Devices',
    'anim.pkt.tx': 'sent',
    'anim.pkt.rx': 'received',
    'anim.pkt.latency': 'latency',
    'anim.pkt.wire': 'on the medium',
    'anim.pkt.fanout': 'broadcast',
    'anim.pkt.receivers': '{n} receivers',
    'anim.topology': 'Topology',
    'anim.close': 'Close the viewer',
    'anim.runHasNoTrace': 'Test {id} recorded no NetAnim trace (it was launched with netanim off). You can still open any other anim.xml from here.',
    'anim.medium': 'Medium',
    'anim.traffic': 'Traffic',
    'anim.topo.serverNote': 'The medium is what carries the bits; the traffic is who talks to whom. Every SSBCV scenario puts the server on n0 (UdpEchoServer in simulation, the iperf3 servers in emulation) and the clients on the rest, so a shared bus carries a star toward the sink — both are true at once. On a shared medium the traffic cannot be deduced from the trace (ns-3 records one arrival per device on the channel, because at L1 every NIC on a bus does see every frame), which is why it comes from the scenario rather than from an inference.',
    'anim.topo.p2p': 'point to point',
    'anim.topo.bus': 'shared bus',
    'anim.topo.star': 'star',
    'anim.topo.mesh': 'mesh',
    'anim.topo.ring': 'ring',
    'anim.topo.tree': 'tree',
    'anim.topo.unknown': 'no links declared',
    'anim.topo.hub': 'hub at {node}',
    'anim.topo.declaredNote': 'The links are the ones the trace declares (a cable or a shared channel).',
    'anim.topo.runNote': 'The topology comes from the scenario the test was launched with, not from guessing: in emulation the trace records no addresses and no channel types (the IPs belong to the containers), so without that fact a shared bus would look like a mesh.',
    'anim.topo.observedNote': 'The trace declares no links: the dashed ones drawn here are observed — A and B exchanged packets, so they were in range — not cables.',
    'anim.topo.hoverNote': 'At this node count, links are drawn only for the node under the cursor.',
    'anim.controlsNote': 'Drag a device to move it, or the background to pan; wheel to zoom. Hover a node or a packet in flight for its details. The on-screen flight time is stretched so it can be seen.',
    'anim.topo.declaredShort': 'The links drawn are the ones the trace declares.',
    'anim.topo.observedShort': 'The dashed links are observed, not cables: A and B exchanged packets.',
    'anim.resetLayout': 'Restore the original positions',
    'anim.viewer': 'NetAnim viewer',
    'anim.viewerDesc': 'Plays any NetAnim trace (.xml) from an ns-3 project. The file is read in your browser; nothing is uploaded.',
    'anim.fullTitle': 'NetAnim Web',
    'anim.awaitingFile': 'Open an anim.xml with "Open file" or load one of the examples. Any ns-3 NetAnim trace works; it is read in your browser and never uploaded.',
  },
}

function detectLang() {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'es' || stored === 'en') return stored
  const nav = (navigator.languages?.[0] || navigator.language || 'en').toLowerCase()
  return nav.startsWith('es') ? 'es' : 'en'
}

function interpolate(str, vars) {
  if (!vars) return str
  return str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

const LanguageContext = createContext(null)

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(detectLang)

  const setLang = useCallback((next) => {
    localStorage.setItem(STORAGE_KEY, next)
    setLangState(next)
    document.documentElement.lang = next
  }, [])

  const t = useCallback(
    (key, vars) => {
      const table = translations[lang] || translations.en
      const str = table[key] ?? translations.en[key] ?? key
      return interpolate(str, vars)
    },
    [lang],
  )

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useI18n() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useI18n must be used within LanguageProvider')
  return ctx
}
