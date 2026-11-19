import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'tareas',
  component: 'Pane',
  requestId: 'tareas',
  props: {
    title: 'Tareas',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// Lo que hay debajo del mod: el almacén en memoria y un motor que responde
// a lo básico. Se registra antes de la primera llamada a `$`.
function mundo(on: any, almacenRoto = false, entradas?: Record<string, unknown>) {
  if (almacenRoto) {
    on('store.get', () => ({ value: undefined }))
    on('store.keys', () => ({ value: [] }))
    on('store.set', () => {
      throw new Error('disco lleno')
    })
  } else {
    mock.store(on, entradas)
  }
  on('command.register', () => ({ value: { command: 'tareas' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/trabajo/mi-proyecto' }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
}

const iniciar = ($: any) =>
  $.session.start({ cwd: '/trabajo/mi-proyecto', surface: 'desktop', isInteractive: true })

test('una tarea que crea Claude aparece como suya, en To do', async ($, on) => {
  mundo(on)
  on('tool.call', () => ({ result: { task: { id: '1', subject: 'Preparar demo' } } }))
  await iniciar($)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Preparar demo', description: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Preparar demo/ }))?.text).toBe('Preparar demo')
  expect(await ui.find({ type: 'Text', text: /Claude/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /mi-proyecto/ })).toBeTruthy()
  await ui.unmount()
})

test('TaskUpdate completed manda la tarea a Done, que va recogida', async ($, on) => {
  mundo(on)
  on('tool.call', (_: unknown, e: { tool: string }) =>
    e.tool === 'TaskCreate'
      ? { result: { task: { id: '1', subject: 'Preparar demo' } } }
      : { result: { success: true, taskId: '1', updatedFields: ['status'] } },
  )
  await iniciar($)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Preparar demo', description: 'x' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Preparar demo/ })).toBeFalsy()
  await ui.unmount()
})

test('/tareas add crea una tarea tuya', async ($, on) => {
  mundo(on)
  await iniciar($)

  await $.command.run({ command: 'tareas', args: 'add Revisar textos EN' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Revisar textos EN/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Yo/ })).toBeTruthy()
  await ui.unmount()
})

test('un fallo del almacén no rompe la llamada de Claude', async ($, on) => {
  mundo(on, true)
  on('tool.call', () => ({ result: { task: { id: '9', subject: 'Algo' } } }))
  await iniciar($)

  const r = await $.tool.call({ tool: 'TaskCreate', subject: 'Algo', description: 'x' })

  expect((r as { result?: unknown }).result).toBeTruthy()
})

test('la herramienta anadir_tarea apunta varias tareas, cada una con su responsable', async ($, on) => {
  mundo(on)
  on('tool.register', () => ({ value: { tool: 'mcp__tareas__anadir_tarea' } }))
  await iniciar($)

  const r = await $.tool.call({
    tool: 'mcp__tareas__anadir_tarea',
    tareas: [
      { texto: 'Arreglar pantalla Create room', owner: 'claude' },
      { texto: 'Revisar textos EN', owner: 'yo', estado: 'waiting' },
    ],
  })

  expect(JSON.stringify(r)).toContain('Añadidas 2')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Arreglar pantalla Create room/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Revisar textos EN/ })).toBeTruthy()
  await ui.unmount()
})

const llamar = ($: any, tool: string, input: Record<string, unknown> = {}) =>
  $.tool.call({ tool: `mcp__tareas__${tool}`, ...input })

test('los ids son globales, correlativos y no se reutilizan al borrar', async ($, on) => {
  mundo(on)
  on('tool.register', () => ({ value: { tool: 'x' } }))
  await iniciar($)

  await llamar($, 'anadir_tarea', {
    tareas: [{ texto: 'Primera' }, { texto: 'Segunda', descripcion: 'Contexto largo de la segunda', proyecto: 'otro' }],
  })

  const lista = JSON.stringify(await llamar($, 'listar_tareas'))
  expect(lista).toContain('#1 [todo] (claude) mi-proyecto: Primera')
  expect(lista).toContain('#2 [todo] (claude) otro: Segunda')

  const ver = JSON.stringify(await llamar($, 'ver_tarea', { id: 2 }))
  expect(ver).toContain('Contexto largo de la segunda')

  await llamar($, 'actualizar_tarea', { id: 1, estado: 'done' })
  expect(JSON.stringify(await llamar($, 'listar_tareas'))).not.toContain('Primera')
  expect(JSON.stringify(await llamar($, 'listar_tareas', { incluir_hechas: true }))).toContain('#1 [done]')

  await llamar($, 'actualizar_tarea', { id: 2, borrar: true })
  await llamar($, 'anadir_tarea', { tareas: [{ texto: 'Tercera' }] })
  expect(JSON.stringify(await llamar($, 'listar_tareas'))).toContain('#3 [todo]')
  expect(JSON.stringify(await llamar($, 'ver_tarea', { id: 2 }))).toContain('no existe')
})

test('una tarea guardada antes de los ids recibe número al arrancar', async ($, on) => {
  mundo(on, false, {
    'p/viejo': [{ id: 'a', project: 'viejo', subject: 'Tarea anterior', owner: 'claude', status: 'todo', at: 1 }],
  })
  on('tool.register', () => ({ value: { tool: 'x' } }))
  await iniciar($)

  expect(JSON.stringify(await llamar($, 'ver_tarea', { id: 1 }))).toContain('Tarea anterior')
})

// --- Gasto y tiempo por tarea ------------------------------------------------------------

const uso = (i: number, o: number, r = 0, w = 0) => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: r,
  cache_creation_input_tokens: w,
  model: 'm',
})

// Un turno principal entero: empieza, pasa lo que haga falta dentro y termina con su uso.
async function turno($: any, id: string, usage: unknown, durationMs: number, dentro?: () => Promise<void>) {
  await $.turn.start({ text: 'x', turnId: id })
  if (dentro) await dentro()
  await $.turn.complete({ answer: '', durationMs, isAborted: false, turnId: id, reason: 'answer', usage })
}

test('el gasto de un turno va a la tarea en curso, por tipo de token', async ($, on) => {
  mundo(on)
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string; usage?: unknown }) => ({ text: e.answer, usage: e.usage }))
  await iniciar($)
  await llamar($, 'anadir_tarea', { tareas: [{ texto: 'Con gasto', estado: 'doing' }] })

  await turno($, 't1', uso(1000, 500, 20000, 300), 60000)
  await turno($, 't2', uso(200, 100), 30000)

  const ver = JSON.stringify(await llamar($, 'listar_tareas'))
  expect(ver).toContain('Con gasto')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Propios = entrada nueva + salida: 1000+500+200+100 = 1800 → "1.8k tok".
  expect(await ui.find({ type: 'Text', text: /1\.8k tok/ })).toBeTruthy()
  await ui.unmount()
})

test('el turno que cierra la tarea se le sigue imputando, y el siguiente va a "sin tarea"', async ($, on) => {
  mundo(on)
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string; usage?: unknown }) => ({ text: e.answer, usage: e.usage }))
  await iniciar($)
  await llamar($, 'anadir_tarea', { tareas: [{ texto: 'Se cierra', estado: 'doing' }] })

  await turno($, 't1', uso(1000, 0), 1000, async () => {
    await llamar($, 'actualizar_tarea', { id: 1, estado: 'done' })
  })
  await turno($, 't2', uso(400, 0), 1000)

  const ver = JSON.stringify(await llamar($, 'ver_tarea', { id: 1 }))
  expect(ver).toContain('#1 [done]')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /sin tarea 400/ })).toBeTruthy()
  await ui.unmount()
})

test('dos tareas solapadas: el gasto va a la última que pasó a en curso', async ($, on) => {
  mundo(on)
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string; usage?: unknown }) => ({ text: e.answer, usage: e.usage }))
  await iniciar($)
  await llamar($, 'anadir_tarea', { tareas: [{ texto: 'Primera' }, { texto: 'Segunda' }] })

  await llamar($, 'actualizar_tarea', { id: 1, estado: 'doing' })
  await turno($, 't1', uso(100, 0), 1000)
  await llamar($, 'actualizar_tarea', { id: 2, estado: 'doing' })
  await turno($, 't2', uso(700, 0), 1000)

  // Panel ancho: las cuatro columnas a la vez, para ver las dos tarjetas (las dos están en curso).
  const ancho = { ...PANE, props: { ...PANE.props, bodyColumns: 120 } }
  const ui = await $.ui.mount({ ...ancho, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /700 tok/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /100 tok/ })).toBeTruthy()
  await ui.unmount()
})

test('los tokens de un subagente cuentan en la tarea, pero su reloj no', async ($, on) => {
  mundo(on)
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string; usage?: unknown }) => ({ text: e.answer, usage: e.usage }))
  await iniciar($)
  await llamar($, 'anadir_tarea', { tareas: [{ texto: 'Con subagente', estado: 'doing', descripcion: 'd' }] })

  await turno($, 't1', uso(100, 0), 60000, async () => {
    await $.turn.complete({
      answer: '', durationMs: 999999, isAborted: false, turnId: 's1', reason: 'answer',
      agentId: 'ag1', usage: uso(300, 0),
    })
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /400 tok/ })).toBeTruthy()
  await ui.unmount()
})

test('lo guardado antes del gasto sigue funcionando y no inventa cifras', async ($, on) => {
  mundo(on, false, {
    'p/viejo': [{ id: 'a', n: 1, project: 'viejo', subject: 'Sin gasto', owner: 'yo', status: 'todo', at: 1 }],
  })
  on('tool.register', () => ({ value: { tool: 'x' } }))
  await iniciar($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Sin gasto/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /tok/ })).toBeFalsy()
  await ui.unmount()
})

test('el filtro de proyectos deja ver solo el elegido', async ($, on) => {
  mundo(on)
  on('tool.register', () => ({ value: { tool: 'x' } }))
  await iniciar($)
  await llamar($, 'anadir_tarea', {
    tareas: [{ texto: 'Del primero', proyecto: 'uno' }, { texto: 'Del segundo', proyecto: 'dos' }],
  })

  const ancho = { ...PANE, props: { ...PANE.props, bodyColumns: 120 } }
  const ui = await $.ui.mount({ ...ancho, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Del primero/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Del segundo/ })).toBeTruthy()

  expect(await ui.find({ type: 'Select' })).toBeTruthy()

  await ui.select({ key: 'pr-select', value: 'dos' })

  expect(await ui.find({ type: 'Text', text: /Del segundo/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Del primero/ })).toBeFalsy()
  await ui.unmount()
})

// --- Archivo y desglose por tiempo ---------------------------------------------------------

const DIA = 24 * 3600 * 1000
const gasto = (i: number, o = 0) => ({ i, o, r: 0, w: 0 })
const ancho = { ...PANE, props: { ...PANE.props, bodyColumns: 120 } }

test('archivar a mano saca la tarea de las columnas, pero su gasto sigue contando', async ($, on) => {
  mundo(on, false, {
    'p/uno': [
      { id: 'a', n: 1, project: 'uno', subject: 'Se archiva', owner: 'yo', status: 'todo', at: Date.now(), gasto: gasto(500) },
      { id: 'b', n: 2, project: 'uno', subject: 'Se queda', owner: 'yo', status: 'todo', at: Date.now() },
    ],
  })
  on('tool.register', () => ({ value: { tool: 'x' } }))
  await iniciar($)

  await llamar($, 'actualizar_tarea', { id: 1, archivada: true })

  const ui = await $.ui.mount({ ...ancho, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Se archiva/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /Se queda/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /Archivo \(1\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Gastado 500 tok/ })).toBeTruthy()

  await ui.press({ key: 'sec-archivo' })
  expect(await ui.find({ type: 'Text', text: /Se archiva/ })).toBeTruthy()
  await ui.unmount()

  // Se puede desarchivar, y archivar no toca cuándo se hizo.
  await llamar($, 'actualizar_tarea', { id: 1, archivada: false })
  expect(JSON.stringify(await llamar($, 'listar_tareas'))).toContain('Se archiva')
})

test('las hechas hace más de 7 días se archivan solas y las archivadas no caducan', async ($, on) => {
  mundo(on, false, {
    'p/uno': [
      { id: 'a', n: 1, project: 'uno', subject: 'Hecha hace 10 días', owner: 'yo', status: 'done', at: Date.now() - 10 * DIA },
      { id: 'b', n: 2, project: 'uno', subject: 'Hecha hace 90 días', owner: 'yo', status: 'done', at: Date.now() - 90 * DIA },
      { id: 'c', n: 3, project: 'uno', subject: 'Hecha ayer', owner: 'yo', status: 'done', at: Date.now() - DIA },
    ],
  })
  on('tool.register', () => ({ value: { tool: 'x' } }))
  await iniciar($)

  const normal = JSON.stringify(await llamar($, 'listar_tareas', { incluir_hechas: true }))
  expect(normal).toContain('Hecha ayer')
  expect(normal).not.toContain('Hecha hace 10 días')

  const todas = JSON.stringify(await llamar($, 'listar_tareas', { incluir_hechas: true, incluir_archivadas: true }))
  expect(todas).toContain('#1 [done, archivada]')
  expect(todas).toContain('#2 [done, archivada]')
  expect(todas).not.toContain('#3 [done, archivada]')
})

test('el desglose por tiempo suma por día y deja aparte lo que no tiene fecha', async ($, on) => {
  mundo(on, false, {
    'p/uno': [
      { id: 'a', n: 1, project: 'uno', subject: 'Con fechas', owner: 'claude', status: 'doing', at: Date.now(),
        gasto: gasto(400), dias: { '2026-11-18': 100, '2026-11-19': 300 } },
      { id: 'b', n: 2, project: 'uno', subject: 'Sin fechas', owner: 'claude', status: 'todo', at: Date.now(),
        gasto: gasto(50) },
    ],
  })
  on('tool.register', () => ({ value: { tool: 'x' } }))
  await iniciar($)

  const ui = await $.ui.mount({ ...ancho, surface: 'desktop' })
  await ui.press({ key: 'sec-desglose' })
  await ui.press({ key: 'per-dia' })
  expect(await ui.find({ type: 'Text', text: /^19 nov$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^18 nov$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^sin fecha$/ })).toBeTruthy()

  await ui.press({ key: 'per-mes' })
  expect(await ui.find({ type: 'Text', text: /^nov 2026$/ })).toBeTruthy()
  await ui.unmount()
})

test('cada turno anota sus tokens en el día de hoy', async ($, on) => {
  mundo(on)
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string; usage?: unknown }) => ({ text: e.answer, usage: e.usage }))
  await iniciar($)
  await llamar($, 'anadir_tarea', { tareas: [{ texto: 'Hoy', estado: 'doing' }] })
  await turno($, 't1', uso(300, 100), 1000)

  const ui = await $.ui.mount({ ...ancho, surface: 'desktop' })
  await ui.press({ key: 'sec-desglose' })
  await ui.press({ key: 'per-dia' })
  expect(await ui.find({ type: 'Text', text: /^\d+ (ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^sin fecha$/ })).toBeFalsy()
  await ui.unmount()
})

test('se puede crear una tarea desde el propio panel', async ($, on) => {
  mundo(on)
  on('tool.register', () => ({ value: { tool: 'x' } }))
  await iniciar($)

  const ui = await $.ui.mount({ ...ancho, surface: 'desktop' })
  await ui.press({ key: 'nueva-abrir' })
  await ui.input({ key: 'nueva-titulo', text: 'Hecha desde el panel', kind: 'change' })
  await ui.input({ key: 'nueva-desc', text: 'Con detalle', kind: 'change' })
  await ui.press({ key: 'nueva-claude' })
  await ui.press({ key: 'nueva-crear' })

  expect(await ui.find({ type: 'Text', text: /Hecha desde el panel/ })).toBeTruthy()
  await ui.unmount()
  const lista = JSON.stringify(await llamar($, 'listar_tareas'))
  expect(lista).toContain('(claude) mi-proyecto: Hecha desde el panel')
  expect(JSON.stringify(await llamar($, 'ver_tarea', { id: 1 }))).toContain('Con detalle')
})

test('"Añadir y empezar" la deja en curso y en un proyecto nuevo', async ($, on) => {
  mundo(on)
  on('tool.register', () => ({ value: { tool: 'x' } }))
  await iniciar($)

  const ui = await $.ui.mount({ ...ancho, surface: 'desktop' })
  await ui.press({ key: 'nueva-abrir' })
  await ui.input({ key: 'nueva-titulo', text: 'Arrancar ya', kind: 'change' })
  await ui.input({ key: 'nueva-otro', text: 'otro-proyecto', kind: 'change' })
  await ui.press({ key: 'nueva-empezar' })
  await ui.unmount()

  expect(JSON.stringify(await llamar($, 'listar_tareas'))).toContain('#1 [doing] (yo) otro-proyecto: Arrancar ya')
})

test('sin título no se crea nada', async ($, on) => {
  mundo(on)
  on('tool.register', () => ({ value: { tool: 'x' } }))
  await iniciar($)

  const ui = await $.ui.mount({ ...ancho, surface: 'desktop' })
  await ui.press({ key: 'nueva-abrir' })
  await ui.press({ key: 'nueva-crear' })
  await ui.unmount()

  expect(JSON.stringify(await llamar($, 'listar_tareas'))).toContain('No hay tareas')
})

test('Enter en el título crea la tarea', async ($, on) => {
  mundo(on)
  on('tool.register', () => ({ value: { tool: 'x' } }))
  await iniciar($)

  const ui = await $.ui.mount({ ...ancho, surface: 'desktop' })
  await ui.press({ key: 'nueva-abrir' })
  await ui.input({ key: 'nueva-titulo', text: 'Con Enter', kind: 'change' })
  await ui.input({ key: 'nueva-titulo', text: 'Con Enter', kind: 'submit' })
  await ui.unmount()

  expect(JSON.stringify(await llamar($, 'listar_tareas'))).toContain('#1 [todo] (yo) mi-proyecto: Con Enter')
})
