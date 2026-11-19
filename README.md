# tareas

Mod de Claude Code: un panel con las tareas de todos los proyectos, separadas entre las que hace Claude y las tuyas.

## Instalación

Desde el prompt de una sesión de terminal:

```
/plugin install tareas --marketplace NoelDNathan/claude-mods
```

Desde una shell:

```
claude plugin install tareas --marketplace NoelDNathan/claude-mods
```

La primera vez pide añadir el marketplace (`y`) y elegir el ámbito.

## Actualizar

Cada cuenta conserva su copia hasta que se actualiza:

```
claude plugin update tareas
```

Las tareas se guardan en cada cuenta, así que una cuenta nueva empieza vacía.

## Gasto y tiempo por tarea (desde 0.3.0)

Cada tarjeta muestra los tokens propios (entrada nueva + salida) y el tiempo en curso; al desplegarla,
el desglose (entrada, salida, caché leída y escrita), lo de los subagentes y el tiempo de Claude trabajando.

- El gasto se suma al acabar cada turno (`turn.complete`) a la tarea en curso de la sesión: la última
  que pasó a *In progress*. Sin tarea en curso va a «sin tarea».
- Los tokens de los subagentes cuentan; su reloj no, porque corre dentro del turno principal.
- Son estimaciones, no la factura. Lo guardado antes de 0.3.0 no tiene cifras.

## Filtro por proyecto y desglose (desde 0.4.0)

- Con dos o más proyectos aparece una fila con los proyectos elegidos como etiquetas (pulsa una para quitarla)
  y un desplegable para añadir más; sin ninguno elegido se ven todos. El desplegable lleva el gasto de cada
  proyecto y el total de arriba sigue al filtro.
- El desglose usa un color por tipo (entrada, salida, caché, tiempo) y una barra de reparto entrada/salida.
- Las tareas hechas muestran cuánto duraron.

## Archivo y gasto por tiempo (desde 0.5.0)

- **Archivar** es una marca aparte: la tarea conserva su estado y su gasto, pero sale de las columnas y de los
  contadores. Se archiva a mano (`⌂ archivar` al desplegar cualquier tarjeta, o `archivada: true` desde Claude) y
  sola: las hechas pasan al archivo a los 7 días. Las archivadas no caducan; solo se borran a mano.
- La sección plegable **Archivo (N)** del final del panel las lista, con `↺ desarchivar` y `× borrar`.
- Los tokens de las archivadas siguen contando en el total. **Gasto por tiempo** los desglosa por día, semana o mes;
  lo gastado antes de 0.5.0 no tiene fecha y sale como «sin fecha».
