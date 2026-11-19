export type Owner = 'claude' | 'yo'
export type Status = 'todo' | 'doing' | 'waiting' | 'done'
export type Filter = 'all' | 'yo' | 'claude'

/** Tokens gastados por tipo: entrada nueva, salida, caché leída y caché escrita. */
export type Gasto = { i: number; o: number; r: number; w: number }

/** Lo que se gasta cuando no hay ninguna tarea en curso. Se guarda en la clave `libre`. */
export type Libre = { gasto: Gasto; sub: number; trabajo: number }

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
  /** Tokens de los turnos (y subagentes) que se hicieron con esta tarea en curso. */
  gasto?: Gasto
  /** De `gasto`, lo que gastaron los subagentes (entrada nueva + salida). */
  sub?: number
  /** Milisegundos que lleva en curso (reloj de pared), ya cerrados. */
  ms?: number
  /** Cuándo pasó a "En curso" la última vez; solo mientras lo está. */
  desde?: number
  /** Milisegundos que Claude estuvo trabajando en turnos de esta tarea. */
  trabajo?: number
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
      /** Tarea en curso de esta sesión ("proyecto|id"), o '' si ninguna. */
      activa: Shaped<string>
      /** Tarea a la que se imputa el turno actual: la activa al empezarlo, o la última que pasó a activa. */
      objetivo: Shaped<string>
    }
  }
}
