import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Filter, Gasto, Libre, Owner, Periodo, Status, Task } from '../types'

const PANE = 'tareas'
const MAX_POR_PROYECTO = 300
// Las tareas hechas pasan solas al archivo a los 7 días. Las archivadas no caducan: solo se borran a mano.
const DIAS_AUTOARCHIVO = 7 * 24 * 3600 * 1000

// Si cambia la forma de lo guardado, cambia la etiqueta: el valor viejo se descarta.
const tick = atom({ plugin: 'tareas', key: 'tick' } as const, 0, {
  shape: 'tick-1',
})
const run = atom({ plugin: 'tareas', key: 'run' } as const, '', {
  shape: 'run-1',
})
const filter = atom({ plugin: 'tareas', key: 'filter' } as const, 'all' as Filter, {
  shape: 'filter-1',
})
// Pestaña activa en paneles estrechos y tarea desplegada ('' = ninguna).
const tab = atom({ plugin: 'tareas', key: 'tab' } as const, 'todo' as Status, {
  shape: 'tab-1',
})
const open = atom({ plugin: 'tareas', key: 'open' } as const, '', {
  shape: 'open-1',
})
// Tarea en curso de esta sesión ("proyecto|id"). El gasto de cada turno se le imputa.
const activa = atom({ plugin: 'tareas', key: 'activa' } as const, '', {
  shape: 'activa-1',
})
// Tarea a la que se imputa el turno que corre: la activa al empezar, o la última que pasó a
// activa durante él. Así un turno que cierra la tarea (la pasa a Done) sigue contando para ella.
const objetivo = atom({ plugin: 'tareas', key: 'objetivo' } as const, '', {
  shape: 'objetivo-1',
})
// Proyectos elegidos para ver, separados por salto de línea. '' = todos.
const proyectosSel = atom({ plugin: 'tareas', key: 'proyectos' } as const, '', {
  shape: 'proyectos-1',
})
// Secciones plegables del final del panel ('1' = abierta) y el periodo del desglose por tiempo.
const archivoAbierto = atom({ plugin: 'tareas', key: 'archivoAbierto' } as const, '', {
  shape: 'archivoAbierto-1',
})
const desgloseAbierto = atom({ plugin: 'tareas', key: 'desgloseAbierto' } as const, '', {
  shape: 'desgloseAbierto-1',
})
const periodo = atom({ plugin: 'tareas', key: 'periodo' } as const, 'semana' as Periodo, {
  shape: 'periodo-1',
})

const COLUMNAS: { status: Status; titulo: string }[] = [
  { status: 'todo', titulo: 'To do' },
  { status: 'doing', titulo: 'In progress' },
  { status: 'waiting', titulo: 'Waiting' },
  { status: 'done', titulo: 'Done' },
]

const PALETA = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'red']

function colorDe(proyecto: string): string {
  let h = 0
  for (const c of proyecto) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PALETA[h % PALETA.length] ?? 'cyan'
}

function nombreDeProyecto(cwd: string): string {
  const partes = cwd.split(/[\\/]+/).filter(Boolean)
  return partes[partes.length - 1] ?? 'sin-proyecto'
}

const claveDe = (proyecto: string) => `p/${proyecto}`

type Acceso = {
  store: {
    get: (k: string) => Promise<unknown>
    set: (k: string, v: unknown) => Promise<void>
    keys: () => Promise<string[]>
  }
}

async function cargar($: Acceso, proyecto: string): Promise<Task[]> {
  const v = await $.store.get(claveDe(proyecto))
  return Array.isArray(v) ? (v as Task[]) : []
}

async function cargarTodo($: Acceso): Promise<Task[]> {
  const claves = (await $.store.keys()).filter(k => k.startsWith('p/'))
  const listas = await Promise.all(
    claves.map(k => cargar($, k.slice(2))),
  )
  return listas.flat()
}

type Mundo = Acceso & Parameters<typeof update>[0]

// Lee la lista del proyecto, la cambia y la guarda; después fuerza el redibujado.
async function cambiar(
  $: Mundo,
  proyecto: string,
  fn: (lista: Task[]) => Task[] | Promise<Task[]>,
): Promise<void> {
  const ahora = Date.now()
  // Una tarea hecha hace más de 7 días se archiva sola (sin tocar su `at`, que es cuándo se hizo).
  const lista = (await fn(await cargar($, proyecto))).map(t =>
    t.status === 'done' && !t.archivada && ahora - t.at >= DIAS_AUTOARCHIVO ? { ...t, archivada: ahora } : t,
  )
  // El tope de tareas solo recorta las vivas: las archivadas se conservan siempre.
  const nueva = [...lista.filter(t => !t.archivada).slice(-MAX_POR_PROYECTO), ...lista.filter(t => t.archivada)]
  await $.store.set(claveDe(proyecto), nueva)
  await update($, tick, n => n + 1)
}

const CLAVE_META = 'meta'

// Reserva el siguiente número global. Nunca se reutiliza, aunque se borre la tarea.
async function numero($: Acceso): Promise<number> {
  const meta = (await $.store.get(CLAVE_META)) as { next?: number } | undefined
  let siguiente = typeof meta?.next === 'number' ? meta.next : 0
  if (siguiente === 0) {
    const maximo = Math.max(0, ...(await cargarTodo($)).map(t => t.n ?? 0))
    siguiente = maximo + 1
  }
  await $.store.set(CLAVE_META, { next: siguiente + 1 })
  return siguiente
}

// Da número a las tareas guardadas antes de que existieran los ids, de la más antigua a la más nueva.
async function migrarNumeros($: Mundo): Promise<void> {
  const sinNumero = (await cargarTodo($)).filter(t => t.n === undefined).sort((a, b) => a.at - b.at)
  for (const t of sinNumero) {
    const n = await numero($)
    await cambiar($, t.project, l => l.map(x => (x.id === t.id ? { ...x, n } : x)))
  }
}

async function buscarPorNumero($: Acceso, n: number): Promise<Task | undefined> {
  return (await cargarTodo($)).find(t => t.n === n)
}

const ESTADOS: Status[] = ['todo', 'doing', 'waiting', 'done']

// --- Gasto y tiempo ------------------------------------------------------------------------

const CLAVE_LIBRE = 'libre'

const gastoVacio = (): Gasto => ({ i: 0, o: 0, r: 0, w: 0 })

type Uso = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

function sumarGasto(g: Gasto | undefined, u: Uso): Gasto {
  const b = g ?? gastoVacio()
  return {
    i: b.i + (u.input_tokens || 0),
    o: b.o + (u.output_tokens || 0),
    r: b.r + (u.cache_read_input_tokens || 0),
    w: b.w + (u.cache_creation_input_tokens || 0),
  }
}

// "Tokens propios": entrada nueva + salida. La caché leída se repite en cada turno y
// engaña (una tarea tardía de una sesión larga saldría cara solo por el contexto), así que
// va aparte, en el detalle.
const propios = (g?: Gasto) => (g ? g.i + g.o : 0)

function compacto(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${n < 1e4 ? (n / 1e3).toFixed(1).replace('.0', '') : Math.round(n / 1e3)}k`
  return `${(n / 1e6).toFixed(1).replace('.0', '')}M`
}

function duracion(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 1) return ms < 1000 ? '0 min' : '<1 min'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const r = min % 60
  return r === 0 ? `${h} h` : `${h} h ${r} min`
}

// Cambia el estado de una tarea cerrando o abriendo su cronómetro de "en curso".
function conEstado(t: Task, status: Status, ahora: number): Task {
  if (t.status === status) return t
  let ms = t.ms ?? 0
  let desde = t.desde
  if (t.status === 'doing') {
    ms += Math.max(0, ahora - (desde ?? t.at))
    desde = undefined
  }
  if (status === 'doing') desde = ahora
  return { ...t, status, ms, desde, at: ahora }
}

// Tiempo en curso: lo cerrado más lo que lleva la apertura actual.
function enCurso(t: Task, ahora: number): number {
  return (t.ms ?? 0) + (t.status === 'doing' ? Math.max(0, ahora - (t.desde ?? t.at)) : 0)
}

const refDe = (t: Task) => `${t.project}|${t.id}`

// --- Desglose por tiempo -----------------------------------------------------------------------

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const dos = (n: number) => String(n).padStart(2, '0')

// Día local en forma ordenable: 2026-11-19.
function diaDe(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`
}

// Agrupa un día en su periodo; la clave se ordena igual que el tiempo.
function clavePeriodo(dia: string, p: Periodo): string {
  if (p === 'dia') return dia
  if (p === 'mes') return dia.slice(0, 7)
  const [y, m, d] = dia.split('-').map(Number) as [number, number, number]
  const f = new Date(y, m - 1, d)
  f.setDate(f.getDate() - ((f.getDay() + 6) % 7)) // lunes de esa semana
  return diaDe(f.getTime())
}

function etiquetaPeriodo(clave: string, p: Periodo): string {
  const [y, m, d] = clave.split('-')
  const mes = MESES[Number(m) - 1] ?? m
  if (p === 'mes') return `${mes} ${y}`
  return p === 'semana' ? `sem ${Number(d)} ${mes}` : `${Number(d)} ${mes}`
}

// Tokens propios por periodo. Lo que se gastó antes de que se guardara el día va a "sin fecha".
function desglosar(tareas: Task[], libre: Libre | undefined, p: Periodo) {
  const filas = new Map<string, number>()
  let sinFecha = 0
  const sumar = (g: Gasto | undefined, dias: Record<string, number> | undefined) => {
    let fechado = 0
    for (const [dia, n] of Object.entries(dias ?? {})) {
      fechado += n
      const k = clavePeriodo(dia, p)
      filas.set(k, (filas.get(k) ?? 0) + n)
    }
    sinFecha += Math.max(0, propios(g) - fechado)
  }
  for (const t of tareas) sumar(t.gasto, t.dias)
  if (libre) sumar(libre.gasto, libre.dias)
  return {
    filas: [...filas.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)),
    sinFecha,
  }
}

// Al pasar una tarea a En curso pasa a ser la activa; al sacarla de ahí deja de serlo.
async function marcar($: Mundo, t: Task): Promise<void> {
  if (t.status === 'doing') {
    await update($, activa, () => refDe(t))
    await update($, objetivo, () => refDe(t))
  } else if ((await read($, activa)) === refDe(t)) {
    await update($, activa, () => '')
  }
}

// Anota los tokens propios de un turno en el día de hoy, para poder desglosar el gasto por tiempo.
function sumarDia(dias: Record<string, number> | undefined, u: Uso): Record<string, number> {
  const hoy = diaDe(Date.now())
  return { ...(dias ?? {}), [hoy]: ((dias ?? {})[hoy] ?? 0) + (u.input_tokens || 0) + (u.output_tokens || 0) }
}

// Suma el gasto de un turno a su tarea; si no hay tarea (o ya no existe), a la bolsa "libre".
async function imputar(
  $: Mundo,
  clave: string,
  u: Uso | undefined,
  esSub: boolean,
  trabajoMs: number,
): Promise<void> {
  const propiosSub = u && esSub ? u.input_tokens + u.output_tokens : 0
  const corte = clave.lastIndexOf('|')
  if (corte > 0) {
    const proyecto = clave.slice(0, corte)
    const id = clave.slice(corte + 1)
    let hallada = false
    await cambiar($, proyecto, lista =>
      lista.map(x => {
        if (x.id !== id) return x
        hallada = true
        return {
          ...x,
          gasto: u ? sumarGasto(x.gasto, u) : x.gasto,
          dias: u ? sumarDia(x.dias, u) : x.dias,
          sub: (x.sub ?? 0) + propiosSub,
          trabajo: (x.trabajo ?? 0) + trabajoMs,
        }
      }),
    )
    if (hallada) return
  }
  const previo = (await $.store.get(CLAVE_LIBRE)) as Libre | undefined
  const nuevo: Libre = {
    gasto: u ? sumarGasto(previo?.gasto, u) : (previo?.gasto ?? gastoVacio()),
    dias: u ? sumarDia(previo?.dias, u) : previo?.dias,
    sub: (previo?.sub ?? 0) + propiosSub,
    trabajo: (previo?.trabajo ?? 0) + trabajoMs,
  }
  await $.store.set(CLAVE_LIBRE, nuevo)
  await update($, tick, n => n + 1)
}

const resumen = (t: Task) =>
  `#${t.n ?? '?'} [${t.status}${t.archivada ? ', archivada' : ''}] (${t.owner === 'yo' ? 'yo' : 'claude'}) ${t.project}: ${t.subject}`

const deClaude: Record<string, Status> = {
  pending: 'todo',
  in_progress: 'doing',
  completed: 'done',
}

// El registro de tareas nunca debe romper la llamada de Claude que lo origina.
async function seguro(f: () => Promise<void>): Promise<void> {
  try {
    await f()
  } catch {
    // se pierde esa anotación, la herramienta de Claude sigue su curso
  }
}

function hace(desde: number): string {
  const min = Math.floor((Date.now() - desde) / 60000)
  if (min < 1) return 'ahora'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`
}

function nuevoId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export const register: Register = on => {
  {
    on('session.start', async ($, e, next) => {
      if ((await read($, run)) === '') {
        await update($, run, () => nuevoId())
      }
      await $.tool.register({
        name: 'anadir_tarea',
        description:
          'Añade tareas al panel de tareas del usuario (mod tareas). Úsala cuando el usuario pida apuntar, añadir o recordar tareas. Cada tarea va a un proyecto; si no se indica, al del directorio de trabajo de esta sesión. owner "claude" = la hace Claude, "yo" = la hace el usuario.',
        inputSchema: {
          type: 'object',
          properties: {
            tareas: {
              type: 'array',
              description: 'Una o varias tareas a añadir',
              items: {
                type: 'object',
                properties: {
                  texto: { type: 'string', description: 'Título corto de la tarea, en una línea' },
                  descripcion: {
                    type: 'string',
                    description: 'Contexto largo opcional (el texto completo del encargo); se ve al desplegar la tarea',
                  },
                  owner: { type: 'string', enum: ['claude', 'yo'], description: 'Quién la hace; por defecto claude' },
                  estado: {
                    type: 'string',
                    enum: ['todo', 'doing', 'waiting', 'done'],
                    description: 'Columna inicial; por defecto todo',
                  },
                  proyecto: { type: 'string', description: 'Nombre del proyecto; por defecto el de esta sesión' },
                },
                required: ['texto'],
              },
            },
          },
          required: ['tareas'],
        },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'listar_tareas',
        description:
          'Lista las tareas del panel del usuario (mod tareas), con su número global (#12), estado, responsable y proyecto. Por defecto no incluye las hechas. Úsala cuando el usuario pregunte qué tareas hay o pida "la tarea #N".',
        inputSchema: {
          type: 'object',
          properties: {
            proyecto: { type: 'string', description: 'Solo las de este proyecto' },
            estado: { type: 'string', enum: ESTADOS, description: 'Solo las de esta columna' },
            owner: { type: 'string', enum: ['claude', 'yo'], description: 'Solo las de este responsable' },
            incluir_hechas: { type: 'boolean', description: 'Incluir las de la columna done' },
            incluir_archivadas: { type: 'boolean', description: 'Incluir las archivadas (por defecto no salen)' },
          },
        },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'ver_tarea',
        description: 'Devuelve una tarea del panel por su número global (#12) con título, descripción, estado, responsable y proyecto.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'number', description: 'Número de la tarea, sin la almohadilla' } },
          required: ['id'],
        },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'actualizar_tarea',
        description:
          'Cambia una tarea del panel por su número global (#12): su estado, responsable, título o descripción, o la borra. Úsala al empezar o terminar una tarea que el usuario te pidió por número.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Número de la tarea, sin la almohadilla' },
            estado: { type: 'string', enum: ESTADOS },
            owner: { type: 'string', enum: ['claude', 'yo'] },
            texto: { type: 'string', description: 'Nuevo título' },
            descripcion: { type: 'string', description: 'Nueva descripción' },
            borrar: { type: 'boolean', description: 'Borrar la tarea' },
            archivada: {
              type: 'boolean',
              description: 'true la archiva (sale del panel, conserva su estado y gasto); false la desarchiva',
            },
          },
          required: ['id'],
        },
        isDeferred: false,
      })
      await seguro(() => migrarNumeros($))
      // Pasa al archivo lo que se hizo hace más de 7 días, aunque no se escriba nada más.
      await seguro(async () => {
        for (const proyecto of new Set((await cargarTodo($)).map(t => t.project))) {
          await cambiar($, proyecto, l => l)
        }
      })
      await $.command.register({
        name: 'tareas',
        description:
          'Abre el panel de tareas. "/tareas add texto" añade una tuya; "/tareas claude texto" una para Claude',
      })

      return next(e)
    })

    on('command.run', { command: 'tareas' }, async ($, e) => {
      const m = /^(add|claude)\s+([\s\S]+)$/.exec(e.args.trim())
      if (!m) {
        await $.ui.open({ id: PANE, title: 'Tareas' })
        return { text: 'Panel de tareas abierto.' }
      }
      const proyecto = nombreDeProyecto(await $.session.cwd())
      const owner: Owner = m[1] === 'claude' ? 'claude' : 'yo'
      // "título | descripción larga": lo que va tras la primera barra es la descripción.
      const [titulo, ...resto] = (m[2] ?? '').split('|')
      const subject = (titulo ?? '').trim()
      const desc = resto.join('|').trim() || undefined
      const n = await numero($)
      await cambiar($, proyecto, lista => [
        ...lista,
        { id: nuevoId(), n, desc, project: proyecto, subject, owner, status: 'todo', at: Date.now() },
      ])
      await $.ui.open({ id: PANE, title: 'Tareas' })
      return { text: `Tarea #${n} añadida (${owner === 'yo' ? 'tuya' : 'de Claude'}): ${subject}` }
    })

    // Cada turno principal empieza imputado a la tarea que esté en curso.
    on('turn.start', async ($, e, next) => {
      if (!e.agentId) {
        const actual = await read($, activa)
        await seguro(async () => update($, objetivo, () => actual))
      }
      return next(e)
    })

    // Al acabar un turno (de Claude o de un subagente) se suma su gasto y su tiempo a la tarea.
    // El turno de un subagente corre dentro del principal: sus tokens cuentan, su reloj no
    // (se contaría dos veces).
    on('turn.complete', async ($, e, next) => {
      const resultado = await next(e)
      await seguro(async () => {
        const clave = (await read($, objetivo)) || (await read($, activa))
        const esSub = Boolean(e.agentId)
        await imputar($, clave, e.usage, esSub, esSub ? 0 : e.durationMs)
      })
      if (!e.agentId) await seguro(async () => update($, objetivo, () => ''))
      return resultado
    })

    // La herramienta con la que Claude añade tareas al panel a petición del usuario.
    on('tool.call', { tool: 'mcp__tareas__anadir_tarea' }, async ($, e) => {
      // El motor espera el resultado de una herramienta del mod como texto simple.
      const texto = (m: string, error = false) => ({ result: error ? `Error: ${m}` : m })
      try {
        const entrada = (e as { tareas?: unknown }).tareas
        if (!Array.isArray(entrada) || entrada.length === 0) {
          return texto('Falta "tareas": una lista con al menos una tarea.', true)
        }
        const porDefecto = nombreDeProyecto(await $.session.cwd())
        const nuevas: Task[] = []
        for (const x of entrada as {
          texto?: unknown
          descripcion?: unknown
          owner?: unknown
          estado?: unknown
          proyecto?: unknown
        }[]) {
          const subject = typeof x.texto === 'string' ? x.texto.trim() : ''
          if (!subject) continue
          const ahora = Date.now()
          nuevas.push(
            conEstado(
              {
                id: nuevoId(),
                n: await numero($),
                desc: typeof x.descripcion === 'string' && x.descripcion.trim() ? x.descripcion.trim() : undefined,
                project: typeof x.proyecto === 'string' && x.proyecto.trim() ? x.proyecto.trim() : porDefecto,
                subject,
                owner: x.owner === 'yo' ? 'yo' : 'claude',
                status: 'todo',
                at: ahora,
              },
              ESTADOS.find(s => s === x.estado) ?? 'todo',
              ahora,
            ),
          )
        }
        if (nuevas.length === 0) return texto('Ninguna tarea tenía texto.', true)
        for (const proyecto of new Set(nuevas.map(t => t.project))) {
          await cambiar($, proyecto, lista => [...lista, ...nuevas.filter(t => t.project === proyecto)])
        }
        for (const t of nuevas) await marcar($, t)
        return texto(`Añadidas ${nuevas.length} tareas al panel:\n${nuevas.map(resumen).join('\n')}`)
      } catch {
        return texto('No se pudo guardar en el almacén de tareas.', true)
      }
    })

    on('tool.call', { tool: 'mcp__tareas__listar_tareas' }, async ($, e) => {
      try {
        const f = e as {
          proyecto?: string
          estado?: string
          owner?: string
          incluir_hechas?: boolean
          incluir_archivadas?: boolean
        }
        const lista = (await cargarTodo($))
          .filter(t => f.incluir_archivadas || !t.archivada)
          .filter(t => !f.proyecto || t.project === f.proyecto)
          .filter(t => !f.estado || t.status === f.estado)
          .filter(t => !f.owner || t.owner === f.owner)
          .filter(t => f.incluir_hechas || f.estado === 'done' || t.status !== 'done')
          .sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9))
        return { result: lista.length === 0 ? 'No hay tareas con ese filtro.' : lista.map(resumen).join('\n') }
      } catch {
        return { result: 'Error: no se pudo leer el almacén de tareas.' }
      }
    })

    on('tool.call', { tool: 'mcp__tareas__ver_tarea' }, async ($, e) => {
      try {
        const n = Number((e as { id?: unknown }).id)
        const t = await buscarPorNumero($, n)
        if (!t) return { result: `Error: no existe la tarea #${n}.` }
        return {
          result: [
            resumen(t),
            `Creada/actualizada hace ${hace(t.at)}.`,
            t.desc ? `Descripción:\n${t.desc}` : 'Sin descripción.',
          ].join('\n'),
        }
      } catch {
        return { result: 'Error: no se pudo leer el almacén de tareas.' }
      }
    })

    on('tool.call', { tool: 'mcp__tareas__actualizar_tarea' }, async ($, e) => {
      try {
        const x = e as {
          id?: unknown
          estado?: string
          owner?: string
          texto?: string
          descripcion?: string
          borrar?: boolean
          archivada?: boolean
        }
        const n = Number(x.id)
        const t = await buscarPorNumero($, n)
        if (!t) return { result: `Error: no existe la tarea #${n}.` }
        if (x.borrar) {
          await cambiar($, t.project, l => l.filter(y => y.id !== t.id))
          return { result: `Tarea #${n} borrada.` }
        }
        const ahora = Date.now()
        // Archivar o desarchivar no cuenta como un cambio de la tarea: conserva su `at` (cuándo se hizo).
        const soloArchivo =
          typeof x.archivada === 'boolean' && !x.estado && !x.owner && !x.texto && !x.descripcion
        const nueva: Task = {
          ...conEstado(t, ESTADOS.find(s => s === x.estado) ?? t.status, ahora),
          owner: x.owner === 'yo' || x.owner === 'claude' ? x.owner : t.owner,
          subject: x.texto?.trim() || t.subject,
          desc: x.descripcion?.trim() || t.desc,
          archivada: typeof x.archivada === 'boolean' ? (x.archivada ? (t.archivada ?? ahora) : undefined) : t.archivada,
          at: soloArchivo ? t.at : ahora,
        }
        await cambiar($, t.project, l => l.map(y => (y.id === t.id ? nueva : y)))
        await marcar($, nueva)
        if (nueva.archivada && (await read($, activa)) === refDe(nueva)) await update($, activa, () => '')
        return { result: `Actualizada: ${resumen(nueva)}` }
      } catch {
        return { result: 'Error: no se pudo guardar en el almacén de tareas.' }
      }
    })

    // Tareas que crea Claude con TaskCreate: nacen como "de Claude, to do".
    on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
      const ran = await next(e)
      const r = ran as { result?: { task?: { id?: string } } }
      const ref = r.result?.task?.id
      if (ref && 'subject' in e) {
        await seguro(async () => {
          const proyecto = nombreDeProyecto(await $.session.cwd())
          const marca = `${await read($, run)}:${ref}`
          const subject = String((e as { subject: string }).subject)
          const desc = String((e as { description?: string }).description ?? '').trim() || undefined
          const n = await numero($)
          await cambiar($, proyecto, lista => [
            ...lista.filter(t => t.ref !== marca),
            { id: nuevoId(), n, desc, ref: marca, project: proyecto, subject, owner: 'claude', status: 'todo', at: Date.now() },
          ])
        })
      }
      return ran
    })

    on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
      const ran = await next(e)
      const r = ran as { result?: { success?: boolean } }
      const entrada = e as { taskId?: string; status?: string; subject?: string }
      if (r.result?.success && entrada.taskId) {
        await seguro(async () => {
          const proyecto = nombreDeProyecto(await $.session.cwd())
          const marca = `${await read($, run)}:${entrada.taskId}`
          const ahora = Date.now()
          let tocada: Task | undefined
          await cambiar($, proyecto, lista => {
            if (entrada.status === 'deleted') return lista.filter(t => t.ref !== marca)
            return lista.map(t => {
              if (t.ref !== marca) return t
              const status = entrada.status ? deClaude[entrada.status] : undefined
              tocada = {
                ...conEstado(t, status ?? t.status, ahora),
                subject: entrada.subject ?? t.subject,
                at: ahora,
              }
              return tocada
            })
          })
          if (tocada) await marcar($, tocada)
        })
      }
      return ran
    })

    // TodoWrite entrega la lista completa cada vez: se reemplaza la de esta sesión.
    on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
      const ran = await next(e)
      const todos = (e as { todos?: { content: string; status: string }[] }).todos
      if (Array.isArray(todos)) await seguro(async () => {
        const proyecto = nombreDeProyecto(await $.session.cwd())
        const prefijo = `${await read($, run)}:todo:`
        const ahora = Date.now()
        let hechas: Task[] = []
        await cambiar($, proyecto, async lista => {
          const previas = new Map(lista.filter(t => t.ref?.startsWith(prefijo)).map(t => [t.ref, t]))
          const resto = lista.filter(t => !t.ref?.startsWith(prefijo))
          const nuevas: Task[] = []
          for (const td of todos) {
            const ref = `${prefijo}${td.content}`
            // Parte de la tarea que ya había (conserva su gasto y su tiempo) o de una nueva en To do.
            const base: Task = previas.get(ref) ?? {
              id: nuevoId(),
              n: await numero($),
              ref,
              project: proyecto,
              subject: td.content,
              owner: 'claude',
              status: 'todo',
              at: ahora,
            }
            nuevas.push(conEstado(base, deClaude[td.status] ?? 'todo', ahora))
          }
          hechas = nuevas
          return [...resto, ...nuevas]
        })
        // La última en curso de la lista pasa a ser la activa.
        for (const t of hechas) await marcar($, t)
      })
      return ran
    })

    on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
      const { Box, Text, Button, Select } = $.ui.resolve(e)
      await read($, tick)
      const f = await read($, filter)
      const pestana = await read($, tab)
      const abierta = await read($, open)
      const todas = await cargarTodo($)
      const libre = ((await $.store.get(CLAVE_LIBRE)) as Libre | undefined) ?? undefined
      const ahora = Date.now()
      const archivoOpen = (await read($, archivoAbierto)) === '1'
      const desgloseOpen = (await read($, desgloseAbierto)) === '1'
      const per = await read($, periodo)

      // Filtro de proyectos: solo cuenta lo elegido que aún existe.
      const nombres = [...new Set(todas.map(t => t.project))].sort((a, b) => a.localeCompare(b))
      const sel = (await read($, proyectosSel)).split('\n').filter(p => p && nombres.includes(p))
      const verProyecto = (p: string) => sel.length === 0 || sel.includes(p)
      const alternarProyecto = (p: string) =>
        update($, proyectosSel, v => {
          const actuales = v.split('\n').filter(Boolean)
          return (actuales.includes(p) ? actuales.filter(x => x !== p) : [...actuales, p]).join('\n')
        })
      const gastoDe = (p: string) =>
        todas.filter(t => t.project === p).reduce((s, t) => s + propios(t.gasto), 0)
      // El total sigue al filtro; la bolsa "sin tarea" solo entra cuando se ven todos.
      const totalTok =
        todas.filter(t => verProyecto(t.project)).reduce((s, t) => s + propios(t.gasto), 0) +
        (sel.length === 0 ? propios(libre?.gasto) : 0)

      // Ancho: con sitio, las 4 columnas; en un panel estrecho, una pestaña cada vez.
      const ancho = e.props.bodyColumns
      const enColumnas = ancho >= 90

      // Las archivadas salen de las columnas y de los contadores, pero siguen contando en el gasto.
      const vivas = todas.filter(t => !t.archivada)
      const archivadas = todas.filter(t => t.archivada)
      const visibles = vivas.filter(t => (f === 'all' || t.owner === f) && verProyecto(t.project))
      const archivadasVis = archivadas
        .filter(t => (f === 'all' || t.owner === f) && verProyecto(t.project))
        .sort((a, b) => (b.archivada ?? 0) - (a.archivada ?? 0))
      const cuantas = (s: Status) => visibles.filter(t => t.status === s).length
      const mias = vivas.filter(t => t.owner === 'yo' && t.status !== 'done').length
      const deC = vivas.filter(t => t.owner === 'claude' && t.status !== 'done').length
      const teEsperan = vivas.filter(t => t.owner === 'yo' && t.status === 'waiting')

      const mover = async (t: Task, status: Status) => {
        const nueva = conEstado(t, status, Date.now())
        await cambiar($, t.project, l => l.map(x => (x.id === t.id ? conEstado(x, status, nueva.at) : x)))
        await marcar($, nueva)
      }
      const traspasar = (t: Task) =>
        cambiar($, t.project, l =>
          l.map(x => (x.id === t.id ? { ...x, owner: x.owner === 'yo' ? 'claude' : 'yo' } : x)),
        )
      const borrar = (t: Task) => cambiar($, t.project, l => l.filter(x => x.id !== t.id))
      // Archivar no cambia el estado ni el `at` (cuándo se hizo); una tarea archivada deja de ser la activa.
      const archivar = async (t: Task, valor: boolean) => {
        await cambiar($, t.project, l =>
          l.map(x => (x.id === t.id ? { ...x, archivada: valor ? Date.now() : undefined } : x)),
        )
        if (valor && (await read($, activa)) === refDe(t)) await update($, activa, () => '')
      }
      const alternar = (t: Task) => update($, open, v => (v === t.id ? '' : t.id))

      const filtroBtn = (id: Filter, etiqueta: string) => (
        <Button
          key={`f-${id}`}
          variant={f === id ? 'primary' : 'secondary'}
          onPress={() => void update($, filter, () => id)}
        >
          {etiqueta}
        </Button>
      )

      // Una fila del desglose: etiqueta apagada con ancho fijo y el valor al lado, para que alineen.
      // Cada parte lleva su color: así entrada, salida, caché y tiempo se distinguen y no todo es amarillo.
      type Parte = string | [string, string]
      const dato = (etiqueta: string, partes: Parte[]) => (
        <Box key={`d-${etiqueta}`} gap={1}>
          <Box width={11}>
            <Text dimColor size="footnote">
              {etiqueta}
            </Text>
          </Box>
          <Box flexWrap="wrap" gap={1} flexShrink={1}>
            {partes.map((p, i) => (
              <Text key={`p-${etiqueta}-${i}`} color={typeof p === 'string' ? undefined : p[1]} size="footnote">
                {typeof p === 'string' ? p : p[0]}
              </Text>
            ))}
          </Box>
        </Box>
      )

      // Barra de reparto entre entrada nueva y salida (la caché se deja fuera: aplastaría todo).
      const barra = (g: Gasto) => {
        const total = g.i + g.o
        if (total === 0) return undefined
        const ancho = 16
        let e = Math.round((ancho * g.i) / total)
        if (g.i > 0) e = Math.max(1, e)
        if (g.o > 0) e = Math.min(ancho - 1, e)
        return (
          <Box key="d-reparto" gap={1}>
            <Box width={11}>
              <Text dimColor size="footnote">
                Reparto
              </Text>
            </Box>
            <Box>
              <Text color="cyan" size="footnote">
                {'█'.repeat(e)}
              </Text>
              <Text color="magenta" size="footnote">
                {'█'.repeat(ancho - e)}
              </Text>
            </Box>
          </Box>
        )
      }

      // Una tarea = dos líneas: título recortado y una línea de datos con iconos.
      const fila = (t: Task) => {
        const desplegada = abierta === t.id
        const color = colorDe(t.project)
        return (
          <Box key={`t-${t.id}`} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={color}>▌ </Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text weight="medium" wrap={desplegada ? 'wrap' : 'truncate-end'}>
                  {t.subject}
                </Text>
              </Box>
            </Box>
            <Box gap={1}>
              <Text color={color}>▌</Text>
              <Text dimColor size="footnote">
                {t.n === undefined ? '#?' : `#${t.n}`}
              </Text>
              <Text color={t.owner === 'claude' ? 'magenta' : 'cyan'} size="footnote">
                {t.owner === 'claude' ? '✦ Claude' : '● Yo'}
              </Text>
              <Text dimColor size="footnote">
                {hace(t.at)}
              </Text>
              {propios(t.gasto) > 0 && (
                <Box>
                  <Text color="yellow" size="footnote">
                    ◆{' '}
                  </Text>
                  <Text dimColor size="footnote">{`${compacto(propios(t.gasto))} tok`}</Text>
                </Box>
              )}
              {enCurso(t, ahora) >= 60000 && (
                <Box>
                  <Text color="green" size="footnote">
                    {t.status === 'done' ? '✓ ' : '◷ '}
                  </Text>
                  <Text dimColor size="footnote">
                    {t.status === 'done' ? `hecha en ${duracion(enCurso(t, ahora))}` : duracion(enCurso(t, ahora))}
                  </Text>
                </Box>
              )}
              <Box flexGrow={1} />
              {!t.archivada && t.status !== 'doing' && t.status !== 'done' && (
                <Button key={`d-${t.id}`} plain dimColor onPress={() => void mover(t, 'doing')}>
                  ▶
                </Button>
              )}
              {!t.archivada && t.status !== 'done' && (
                <Button key={`k-${t.id}`} plain dimColor onPress={() => void mover(t, 'done')}>
                  ✓
                </Button>
              )}
              <Button key={`m-${t.id}`} plain dimColor onPress={() => void alternar(t)}>
                {desplegada ? '▴' : '⋯'}
              </Button>
            </Box>
            {desplegada && (t.gasto || t.trabajo || enCurso(t, ahora) > 0) && (
              <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                {t.gasto &&
                  dato('Tokens', [
                    `${compacto(propios(t.gasto))} propios`,
                    [`${compacto(t.gasto.i)} entrada`, 'cyan'],
                    [`${compacto(t.gasto.o)} salida`, 'magenta'],
                  ])}
                {t.gasto && barra(t.gasto)}
                {t.gasto &&
                  dato('Caché', [
                    [`${compacto(t.gasto.r)} leída`, 'blue'],
                    [`${compacto(t.gasto.w)} escrita`, 'blue'],
                  ])}
                {t.sub ? dato('Subagentes', [[`${compacto(t.sub)} tok`, 'yellow']]) : undefined}
                {enCurso(t, ahora) > 0 && dato(t.status === 'done' ? 'Duró' : 'En curso', [[duracion(enCurso(t, ahora)), 'green']])}
                {t.trabajo ? dato('Claude', [['trabajando', 'magenta'], duracion(t.trabajo)]) : undefined}
              </Box>
            )}
            {desplegada && t.desc && (
              <Box paddingLeft={2} marginY={1}>
                <Text dimColor wrap="wrap">
                  {t.desc}
                </Text>
              </Box>
            )}
            {desplegada && (
              <Box flexWrap="wrap" gap={1} paddingLeft={2}>
                {t.archivada && (
                  <Button key={`u-${t.id}`} plain dimColor onPress={() => void archivar(t, false)}>
                    ↺ desarchivar
                  </Button>
                )}
                {!t.archivada && t.status !== 'todo' && (
                  <Button key={`s-${t.id}`} plain dimColor onPress={() => void mover(t, 'todo')}>
                    ↺ a To do
                  </Button>
                )}
                {!t.archivada && t.status !== 'waiting' && (
                  <Button key={`w-${t.id}`} plain dimColor onPress={() => void mover(t, 'waiting')}>
                    ⏸ en espera
                  </Button>
                )}
                {!t.archivada && (
                  <Button key={`o-${t.id}`} plain dimColor onPress={() => void traspasar(t)}>
                    {t.owner === 'yo' ? '→ pasar a Claude' : '→ hacerla yo'}
                  </Button>
                )}
                {!t.archivada && (
                  <Button key={`a-${t.id}`} plain dimColor onPress={() => void archivar(t, true)}>
                    ⌂ archivar
                  </Button>
                )}
                <Button key={`x-${t.id}`} plain dimColor onPress={() => void borrar(t)}>
                  × borrar
                </Button>
              </Box>
            )}
          </Box>
        )
      }

      // Las tareas de un estado, agrupadas por proyecto con su cabecera.
      const lista = (s: Status) => {
        const delEstado = visibles.filter(t => t.status === s).sort((a, b) => b.at - a.at)
        if (delEstado.length === 0) return <Text dimColor>—</Text>
        const proyectos = [...new Set(delEstado.map(t => t.project))]
        return (
          <Box flexDirection="column">
            {proyectos.map(p => (
              <Box key={`g-${s}-${p}`} flexDirection="column">
                <Text color={colorDe(p)} size="footnote" weight="medium">
                  {p}
                </Text>
                {delEstado.filter(t => t.project === p).map(fila)}
              </Box>
            ))}
          </Box>
        )
      }

      const pestanas = (
        <Box flexWrap="wrap" gap={1} marginTop={1}>
          {COLUMNAS.map(c => (
            <Button
              key={`p-${c.status}`}
              variant={pestana === c.status ? 'primary' : 'secondary'}
              onPress={() => void update($, tab, () => c.status)}
            >
              {`${c.titulo} ${cuantas(c.status)}`}
            </Button>
          ))}
        </Box>
      )

      return (
        <Box flexDirection="column">
          <Box flexWrap="wrap" gap={1} justifyContent="space-between">
            <Box gap={1}>
              {filtroBtn('all', 'Todo')}
              {filtroBtn('yo', 'Mías')}
              {filtroBtn('claude', 'De Claude')}
            </Box>
            <Box gap={1}>
              <Text color="cyan">{mias} tuyas</Text>
              <Text dimColor>·</Text>
              <Text color="magenta">{deC} de Claude</Text>
            </Box>
          </Box>
          {nombres.length > 1 && (
            <Box flexWrap="wrap" gap={1} marginTop={1}>
              {sel.length === 0 && <Text dimColor>Todos los proyectos</Text>}
              {sel.map(p => (
                <Button key={`pr-${p}`} variant="primary" onPress={() => void alternarProyecto(p)}>
                  {`${p} ✕`}
                </Button>
              ))}
              {sel.length > 1 && (
                <Button key="pr-limpiar" plain dimColor onPress={() => void update($, proyectosSel, () => '')}>
                  Limpiar
                </Button>
              )}
              {nombres.some(p => !sel.includes(p)) && (
                <Select
                  key="pr-select"
                  options={[
                    { value: '', label: sel.length === 0 ? 'Filtrar por proyecto' : '+ proyecto' },
                    ...nombres
                      .filter(p => !sel.includes(p))
                      .map(p => ({ value: p, label: gastoDe(p) > 0 ? `${p} · ${compacto(gastoDe(p))}` : p })),
                  ]}
                  value=""
                  onSelect={v => {
                    if (v) void alternarProyecto(v)
                  }}
                />
              )}
            </Box>
          )}
          {totalTok > 0 && (
            <Box marginTop={1}>
              <Text color="yellow" size="footnote">
                ◆{' '}
              </Text>
              <Text dimColor size="footnote" wrap="wrap">
                {`Gastado ${compacto(totalTok)} tok${sel.length === 0 && propios(libre?.gasto) > 0 ? ` · sin tarea ${compacto(propios(libre?.gasto))}` : ''}`}
              </Text>
            </Box>
          )}
          {todas.length === 0 && (
            <Box marginTop={1}>
              <Text dimColor>
                Aún no hay tareas. Las que cree Claude aparecerán solas; añade las tuyas con /tareas add texto.
              </Text>
            </Box>
          )}
          {enColumnas ? (
            <Box marginTop={1} flexDirection="row">
              {COLUMNAS.map(c => (
                <Box key={`c-${c.status}`} flexDirection="column" width="25%" paddingRight={1}>
                  <Box justifyContent="space-between" marginBottom={1}>
                    <Text weight="semibold">{c.titulo}</Text>
                    <Text dimColor>{cuantas(c.status)}</Text>
                  </Box>
                  {lista(c.status)}
                </Box>
              ))}
            </Box>
          ) : (
            <Box flexDirection="column">
              {pestanas}
              <Box marginTop={1} flexDirection="column">
                {lista(pestana)}
              </Box>
            </Box>
          )}
          {archivadas.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <Button
                  key="sec-archivo"
                  plain
                  dimColor
                  onPress={() => void update($, archivoAbierto, v => (v === '1' ? '' : '1'))}
                >
                  {`${archivoOpen ? '▾' : '▸'} Archivo (${archivadasVis.length})`}
                </Button>
              </Box>
              {archivoOpen && (
                <Box flexDirection="column" marginTop={1}>
                  {archivadasVis.length === 0 && <Text dimColor>—</Text>}
                  {[...new Set(archivadasVis.map(t => t.project))].map(p => (
                    <Box key={`ga-${p}`} flexDirection="column">
                      <Text color={colorDe(p)} size="footnote" weight="medium">
                        {p}
                      </Text>
                      {archivadasVis.filter(t => t.project === p).map(fila)}
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          )}
          {totalTok > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <Button
                  key="sec-desglose"
                  plain
                  dimColor
                  onPress={() => void update($, desgloseAbierto, v => (v === '1' ? '' : '1'))}
                >
                  {`${desgloseOpen ? '▾' : '▸'} Gasto por tiempo`}
                </Button>
              </Box>
              {desgloseOpen && (() => {
                const des = desglosar(
                  todas.filter(t => verProyecto(t.project)),
                  sel.length === 0 ? libre : undefined,
                  per,
                )
                const filas = des.filas.slice(0, 12)
                const maximo = Math.max(1, des.sinFecha, ...filas.map(x => x[1]))
                const fila2 = (clave: string, etiqueta: string, n: number) => (
                  <Box key={`dt-${clave}`} gap={1}>
                    <Box width={11}>
                      <Text dimColor size="footnote">
                        {etiqueta}
                      </Text>
                    </Box>
                    <Text color="yellow" size="footnote">
                      {'█'.repeat(Math.max(1, Math.round((14 * n) / maximo)))}
                    </Text>
                    <Text dimColor size="footnote">
                      {compacto(n)}
                    </Text>
                  </Box>
                )
                return (
                  <Box flexDirection="column" marginTop={1}>
                    <Box gap={1} marginBottom={1}>
                      {(['dia', 'semana', 'mes'] as Periodo[]).map(x => (
                        <Button
                          key={`per-${x}`}
                          variant={per === x ? 'primary' : 'secondary'}
                          onPress={() => void update($, periodo, () => x)}
                        >
                          {x === 'dia' ? 'Día' : x === 'semana' ? 'Semana' : 'Mes'}
                        </Button>
                      ))}
                    </Box>
                    {filas.map(([clave, n]) => fila2(clave, etiquetaPeriodo(clave, per), n))}
                    {des.sinFecha > 0 && fila2('sin-fecha', 'sin fecha', des.sinFecha)}
                  </Box>
                )
              })()}
            </Box>
          )}
          {teEsperan.length > 0 && (
            <Box marginTop={1} borderStyle="round" borderColor="warning" paddingX={1}>
              <Text color="warning" wrap="truncate-end">
                Te esperan {teEsperan.length}: {teEsperan.map(t => t.subject).join(' · ')}
              </Text>
            </Box>
          )}
        </Box>
      )
    })
  }
}
