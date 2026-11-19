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
