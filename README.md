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
