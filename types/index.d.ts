export type Owner = 'claude' | 'yo'
export type Status = 'todo' | 'doing' | 'waiting' | 'done'
export type Filter = 'all' | 'yo' | 'claude'

export type Task = {
  id: string
  /** Número global y corto (#12) con el que se pide la tarea en el chat. Las anteriores a los ids no lo tienen hasta migrarse. */
  n?: number
  /** Contexto largo opcional, que no cabe en el título. */
  desc?: string
  /** Identificador de la tarea dentro de la sesión de Claude que la creó. */
  ref?: string
  project: string
  subject: string
  owner: Owner
  status: Status
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    tareas: {
      /** Contador que fuerza el redibujado del panel tras cada escritura. */
      tick: Shaped<number>
      /** Marca de esta sesión, para distinguir ids de tarea repetidos entre sesiones. */
      run: Shaped<string>
      filter: Shaped<Filter>
      /** Pestaña activa cuando el panel es estrecho. */
      tab: Shaped<Status>
      /** Id de la tarea desplegada, o '' si ninguna. */
      open: Shaped<string>
    }
  }
}
