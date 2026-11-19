import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Filter, Owner, Status, Task } from '../types'

const PANE = 'tareas'
const MAX_POR_PROYECTO = 300
const MESES_DONE = 30 * 24 * 3600 * 1000

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
  const nueva = (await fn(await cargar($, proyecto)))
    .filter(t => t.status !== 'done' || ahora - t.at < MESES_DONE)
    .slice(-MAX_POR_PROYECTO)
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

const resumen = (t: Task) =>
  `#${t.n ?? '?'} [${t.status}] (${t.owner === 'yo' ? 'yo' : 'claude'}) ${t.project}: ${t.subject}`

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
          },
          required: ['id'],
        },
        isDeferred: false,
      })
      await seguro(() => migrarNumeros($))
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
          nuevas.push({
            id: nuevoId(),
            n: await numero($),
            desc: typeof x.descripcion === 'string' && x.descripcion.trim() ? x.descripcion.trim() : undefined,
            project: typeof x.proyecto === 'string' && x.proyecto.trim() ? x.proyecto.trim() : porDefecto,
            subject,
            owner: x.owner === 'yo' ? 'yo' : 'claude',
            status: ESTADOS.find(s => s === x.estado) ?? 'todo',
            at: Date.now(),
          })
        }
        if (nuevas.length === 0) return texto('Ninguna tarea tenía texto.', true)
        for (const proyecto of new Set(nuevas.map(t => t.project))) {
          await cambiar($, proyecto, lista => [...lista, ...nuevas.filter(t => t.project === proyecto)])
        }
        return texto(`Añadidas ${nuevas.length} tareas al panel:\n${nuevas.map(resumen).join('\n')}`)
      } catch {
        return texto('No se pudo guardar en el almacén de tareas.', true)
      }
    })

    on('tool.call', { tool: 'mcp__tareas__listar_tareas' }, async ($, e) => {
      try {
        const f = e as { proyecto?: string; estado?: string; owner?: string; incluir_hechas?: boolean }
        const lista = (await cargarTodo($))
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
        }
        const n = Number(x.id)
        const t = await buscarPorNumero($, n)
        if (!t) return { result: `Error: no existe la tarea #${n}.` }
        if (x.borrar) {
          await cambiar($, t.project, l => l.filter(y => y.id !== t.id))
          return { result: `Tarea #${n} borrada.` }
        }
        const nueva: Task = {
          ...t,
          status: ESTADOS.find(s => s === x.estado) ?? t.status,
          owner: x.owner === 'yo' || x.owner === 'claude' ? x.owner : t.owner,
          subject: x.texto?.trim() || t.subject,
          desc: x.descripcion?.trim() || t.desc,
          at: Date.now(),
        }
        await cambiar($, t.project, l => l.map(y => (y.id === t.id ? nueva : y)))
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
          await cambiar($, proyecto, lista => {
            if (entrada.status === 'deleted') return lista.filter(t => t.ref !== marca)
            return lista.map(t => {
              if (t.ref !== marca) return t
              const status = entrada.status ? deClaude[entrada.status] : undefined
              return {
                ...t,
                subject: entrada.subject ?? t.subject,
                status: status ?? t.status,
                at: Date.now(),
              }
            })
          })
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
        await cambiar($, proyecto, async lista => {
          const previas = new Map(lista.filter(t => t.ref?.startsWith(prefijo)).map(t => [t.ref, t]))
          const resto = lista.filter(t => !t.ref?.startsWith(prefijo))
          const nuevas: Task[] = []
          for (const td of todos) {
            const ref = `${prefijo}${td.content}`
            const antes = previas.get(ref)
            nuevas.push({
              id: antes?.id ?? nuevoId(),
              n: antes?.n ?? (await numero($)),
              desc: antes?.desc,
              ref,
              project: proyecto,
              subject: td.content,
              owner: antes?.owner ?? 'claude',
              status: deClaude[td.status] ?? 'todo',
              at: antes && antes.status === (deClaude[td.status] ?? 'todo') ? antes.at : Date.now(),
            })
          }
          return [...resto, ...nuevas]
        })
      })
      return ran
    })

    on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
      const { Box, Text, Button } = $.ui.resolve(e)
      await read($, tick)
      const f = await read($, filter)
      const pestana = await read($, tab)
      const abierta = await read($, open)
      const todas = await cargarTodo($)

      // Ancho: con sitio, las 4 columnas; en un panel estrecho, una pestaña cada vez.
      const ancho = e.props.bodyColumns
      const enColumnas = ancho >= 90

      const visibles = todas.filter(t => f === 'all' || t.owner === f)
      const cuantas = (s: Status) => visibles.filter(t => t.status === s).length
      const mias = todas.filter(t => t.owner === 'yo' && t.status !== 'done').length
      const deC = todas.filter(t => t.owner === 'claude' && t.status !== 'done').length
      const teEsperan = todas.filter(t => t.owner === 'yo' && t.status === 'waiting')

      const mover = (t: Task, status: Status) =>
        cambiar($, t.project, l => l.map(x => (x.id === t.id ? { ...x, status, at: Date.now() } : x)))
      const traspasar = (t: Task) =>
        cambiar($, t.project, l =>
          l.map(x => (x.id === t.id ? { ...x, owner: x.owner === 'yo' ? 'claude' : 'yo' } : x)),
        )
      const borrar = (t: Task) => cambiar($, t.project, l => l.filter(x => x.id !== t.id))
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
              <Box flexGrow={1} />
              {t.status !== 'doing' && t.status !== 'done' && (
                <Button key={`d-${t.id}`} plain dimColor onPress={() => void mover(t, 'doing')}>
                  ▶
                </Button>
              )}
              {t.status !== 'done' && (
                <Button key={`k-${t.id}`} plain dimColor onPress={() => void mover(t, 'done')}>
                  ✓
                </Button>
              )}
              <Button key={`m-${t.id}`} plain dimColor onPress={() => void alternar(t)}>
                {desplegada ? '▴' : '⋯'}
              </Button>
            </Box>
            {desplegada && t.desc && (
              <Box paddingLeft={2} marginY={1}>
                <Text dimColor wrap="wrap">
                  {t.desc}
                </Text>
              </Box>
            )}
            {desplegada && (
              <Box flexWrap="wrap" gap={1} paddingLeft={2}>
                {t.status !== 'todo' && (
                  <Button key={`s-${t.id}`} plain dimColor onPress={() => void mover(t, 'todo')}>
                    ↺ a To do
                  </Button>
                )}
                {t.status !== 'waiting' && (
                  <Button key={`w-${t.id}`} plain dimColor onPress={() => void mover(t, 'waiting')}>
                    ⏸ en espera
                  </Button>
                )}
                <Button key={`o-${t.id}`} plain dimColor onPress={() => void traspasar(t)}>
                  {t.owner === 'yo' ? '→ pasar a Claude' : '→ hacerla yo'}
                </Button>
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
