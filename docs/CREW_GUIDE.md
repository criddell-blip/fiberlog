# FiberLog — Crew Guide / Guía de Cuadrilla

For field crews logging their daily work. **Manager** features are in a separate guide.
**English first · Español más abajo ⬇**

> 🌐 Open in your browser: **https://criddell-blip.github.io/fiberlog/**
> Works on phone, tablet, and laptop. Saves as you go — you won't lose work if your signal drops.

---

# 🇺🇸 English

**The golden rule (new since July 2026): a task stays in your Active list until a
manager closes it — even after you submit. One task = one stretch of work, with as
many daily submissions ("passdowns") as the job takes. Never re-create a task.**

## The whole day in 5 steps

1. **Sign in** with your username (firstname.lastname) and password
2. **Load parts** from the warehouse onto your truck (📦 *My Stock*)
3. **Pick your task** (Project → Phase → Task, or Project → Site → Task for infra crew)
4. **Log what you used and how many hours** during the day — it auto-saves
5. **Submit your day** when you're done — the task stays put for tomorrow

Manager reviews it, approves it, and the parts you logged transfer from your truck
into the project's bucket automatically.

---

## Signing in

`[screenshot: Login screen]`

1. Username is your **firstname.lastname** (no spaces — e.g. `chad.sperry`) or your company email
2. Password — first time is whatever your manager set
3. Tap **Sign in**

If it doesn't work:
- Wrong password → ask your manager to reset it
- "Could not connect" → check your phone signal, then retry

> 💡 Your username gets remembered next time. Only the password is asked.

> 🌐 **¿Español?** Tap **EN · ES** in the bottom corner of the login screen — or once
> signed in, tap your initials (top right) and pick **Español** next to 🌐 Language.
> Your phone remembers the choice, even across sign-outs.

---

## 📦 My Stock — the material on your truck

Tap **My Stock** in the sidebar (or the 📦 button on phone) to see everything on your
personal truck. Search by name or SKU — multiple words work ("lag bolt box").

> ⚠️ **Red negative numbers** mean the system thinks you used/returned more than you
> loaded. Tell your manager so it gets reconciled.

`[screenshot: My Stock page]`

### Loading parts (warehouse → your truck)

1. Tap **Load**
2. Two ways to find your part:
   - **🔍 Find a part** (default) — search the part, then tap the location that has it
   - **📍 Pick a location** — choose the warehouse/bin first, then the part
3. Type a quantity — the label shows how many are on hand
4. **＋ Add another part** to build a list, then tap **Load** — review and confirm

Things you might see while loading:
- **Amber warning "…will go negative"** — you asked for more than the system shows on
  hand. You *can* proceed (you'll get a review step), but only do it when the material
  is truly in your hands and the count is wrong.
- **A greyed part with "Not loadable for your crew"** — that department isn't on your
  crew type's list. Talk to your manager if you need it.

### Returning parts (your truck → warehouse)

1. On any part row tap **Return** (quantity pre-fills to everything you have — dial it
   down if you're keeping some), or use the top **Return** button
2. Pick the destination warehouse/bin, review, confirm

> ⚠️ **Return unused parts at end of day** or your truck inventory drifts from reality.

### Found material that isn't in the system

**My Stock → Report found inventory** → search the part (or add it as new), enter the
quantity + destination warehouse, and send. A manager approves it before it counts —
nothing moves until then.

---

## Finding your work

The sidebar shows your projects. It reopens on the project you used last.

- **Fiber crew:** Project → Phase → Task (e.g. `Heber → Phase 2 → Set new pole 1247`)
- **Infra crew:** Project → Site → Task (e.g. `Fixed Wireless → Alexis Tower → Replace UPS battery`)
  — sites have type icons: 📡 wireless, 🏢 fiber-served building

The task list has two sections:
- **Active tasks** — everything you can still log against. Pills show the latest
  passdown's state: **Submitted** (amber), **Approved** (green), **Flagged** (red).
  A task with a pill is still open — keep working it.
- **Completed** (collapsed at the bottom) — tasks a manager closed. Tap to review
  what was submitted; read-only.

### Creating a new task

Only when the work isn't already on the list: tap **＋ Add task**, name it after the
section/location, pick the closest job type, add scope notes if useful.

---

## Logging your day in a task

Tap a task to open it. This is your workspace for the day.

`[screenshot: Task workspace]`

### Counting kits (assemblies)

The tabs (**Aerial / Footage / Splice / Underground**) group **kits** of parts that go
together (e.g. "Down guy kit" pulls its bolts, washers, anchor).

- Tap **＋** next to a kit to count one, **−** to remove one
- Footage kits (fiber, strand, conduit) take a number — type how many feet

### Adding a part not in any kit

1. Tap **＋ Add part not in list**
2. Search and pick the part, type a quantity

### Hours and notes

Hours default to 8 — adjust with **＋/−**. Drop a **note** for anything the manager
should know (damage, site conditions, parts you couldn't find).

> 🔄 **It auto-saves.** Close the app, restart your phone, hand off to another crew —
> the counts are saved on the task and will be there when it's reopened.

### If the top of the workspace shows other people's work

Tasks are shared on purpose (crew swaps, several guys on one job):

- **"N passdowns submitted · view ›" strip** — what's already been turned in on this
  task, by you or others ("includes ___" names them). Tap to see each passdown's
  status, hours, and parts. Submitted passdowns can't be edited by anyone.
- **Warning when entering:** *"This task has UNSUBMITTED work by ___"* — a coworker
  left unsent counts here. Continuing means you're editing **their** draft — only do
  it if you're taking over their day. Backing out changes nothing.
- **Amber banner "Editing ___'s UNSUBMITTED draft"** — you're inside their draft now.

---

## Submitting your day

1. Tap **Wrap up day →**
2. In **Submit your day**: check the parts list (adjust or remove lines), set hours,
   add a note if needed
3. Tap **Submit day ✓** to confirm — or **Keep logging** to back out

`[screenshot: Submit-day summary]`

> 🔒 **A submitted passdown is final** — you can't edit it afterward. If something's
> wrong, tell your manager; they flag it and you re-submit (below).

After submitting:
- **The task stays in your Active list** with an amber *Submitted* pill — that's
  correct. Tomorrow you open the same task, get a fresh blank form, and log a new
  passdown. **Don't re-create the task.**
- The manager approves or flags each passdown from their queue
- On approval, the parts transfer truck → project bucket automatically
- When the whole job is done, the **manager** closes the task and it moves to Completed

---

## If your manager flags your passdown

A flag means something needs fixing — wrong quantity, missing part, etc.

You'll see a **red banner** on the task with the manager's reason **and the numbers
you originally sent** ("What you submitted: 8 hrs · 5× Lashing Wire…").

1. Open the task — the form is blank on purpose
2. Re-enter the day **correctly**, using the banner's numbers as reference
3. **Submit day ✓** — your new passdown replaces the flagged one

---

## Account: language, password, sign out

Tap your **initials circle** (top of sidebar, or avatar in the top bar on phone):

- 🌐 **Language** — EN / Español (remembered on this device)
- 🔑 **Change password**
- **Sign out**

---

## Quick troubleshooting

| Problem | Fix |
|---|---|
| "My task disappeared!" | It didn't — check the **Completed** section (a manager closed it), or look for the *Submitted* pill in Active. **Never re-create it**; ask your manager to reopen if needed. |
| I submitted wrong numbers | Tell your manager — they flag the passdown and you re-submit. |
| Search finds nothing | Check spelling — multi-word search works. If the part shows greyed, its department isn't on your crew's list. |
| "Quantity exceeds what's on hand" warning | You can proceed — but only if the material is really in your hands. It sends the source negative and your manager will see it. |
| My truck shows wrong stock numbers | Refresh the page — My Stock doesn't live-update when a manager moves stock. Still wrong? Tell your manager. |
| Task should be under a different project | Use the **"Routing materials to:"** picker in the workspace — materials route to the picked project's bucket at approval. Ask if unsure. |
| App is slow / acting weird | Hard refresh (pull-to-refresh, or Ctrl+Shift+R). Then sign back in. |

## Who to ask

- **App trouble, password, wrong data:** Chris (or your manager)
- **Which kit to use, what parts to grab:** your lead crew member

---
---

# 🇲🇽 Español

**La regla de oro (nueva desde julio 2026): la tarea se queda en tu lista de Activas
hasta que un encargado la cierre — incluso después de enviar. Una tarea = un tramo de
trabajo, con tantas jornadas diarias como haga falta. Nunca vuelvas a crear una tarea.**

## Todo el día en 5 pasos

1. **Inicia sesión** con tu usuario (nombre.apellido) y contraseña
2. **Carga piezas** de la bodega a tu camión (📦 *Mi Material*)
3. **Elige tu tarea** (Proyecto → Fase → Tarea; infraestructura: Proyecto → Sitio → Tarea)
4. **Registra lo que usaste y tus horas** durante el día — se guarda solo
5. **Envía tu día** al terminar — la tarea se queda para mañana

El encargado la revisa, la aprueba, y las piezas que registraste pasan de tu camión al
proyecto automáticamente.

---

## Iniciar sesión

1. Tu usuario es **nombre.apellido** (sin espacios — ej. `chad.sperry`) o tu correo de la empresa
2. Contraseña — la primera vez es la que puso tu encargado
3. Toca **Sign in / Iniciar sesión**

Si no funciona:
- Contraseña equivocada → pide a tu encargado que la restablezca
- "No se pudo conectar" → revisa tu señal y reintenta

> 🌐 **¿Español?** Toca **EN · ES** en la esquina inferior de la pantalla de inicio —
> o ya adentro, toca tus iniciales (arriba a la derecha) y elige **Español** junto a
> 🌐 Idioma. Tu teléfono recuerda la elección, incluso al cerrar sesión.

---

## 📦 Mi Material — lo que trae tu camión

Toca **Mi Material** en el menú lateral (o el botón 📦 en el teléfono) para ver todo lo
de tu camión. Busca por nombre o SKU — varias palabras funcionan.

> ⚠️ **Números rojos negativos** = el sistema cree que usaste/devolviste más de lo que
> cargaste. Avísale a tu encargado para cuadrarlo.

### Cargar piezas (bodega → tu camión)

1. Toca **Cargar**
2. Dos formas de encontrar la pieza:
   - **🔍 Buscar pieza** (predeterminado) — busca la pieza y toca la ubicación que la tiene
   - **📍 Elegir ubicación** — primero bodega/estante, luego la pieza
3. Pon la cantidad — la etiqueta muestra cuántas hay disponibles
4. **＋ Agregar otra pieza** para armar la lista, luego **Cargar** — revisa y confirma

Cosas que puedes ver al cargar:
- **Advertencia ámbar "…quedará en negativo"** — pediste más de lo que el sistema
  muestra. *Puedes* continuar (con un paso de revisión), pero solo si de verdad tienes
  el material en la mano y el conteo está mal.
- **Pieza gris con "No disponible para tu cuadrilla"** — ese departamento no está en la
  lista de tu tipo de cuadrilla. Habla con tu encargado si la necesitas.

### Devolver piezas (tu camión → bodega)

1. En cualquier pieza toca **Devolver** (la cantidad se llena con todo lo que tienes —
   bájale si te quedas con algo), o usa el botón **Devolver** de arriba
2. Elige la bodega/estante de destino, revisa y confirma

> ⚠️ **Devuelve las piezas sin usar al final del día**, o el inventario de tu camión se
> aleja de la realidad.

### Material encontrado que no está en el sistema

**Mi Material → Reportar material encontrado** → busca la pieza (o agrégala como
nueva), pon la cantidad y a qué bodega va, y envía. Un encargado lo aprueba antes de
que cuente.

---

## Encontrar tu trabajo

El menú lateral muestra tus proyectos. Se abre en el último proyecto que usaste.

- **Cuadrilla de fibra:** Proyecto → Fase → Tarea
- **Infraestructura:** Proyecto → Sitio → Tarea — los sitios tienen íconos:
  📡 inalámbrico, 🏢 edificio con fibra

La lista de tareas tiene dos secciones:
- **Tareas activas** — todo en lo que aún puedes registrar. Las etiquetas muestran el
  estado de la última jornada: **Enviada** (ámbar), **Aprobada** (verde), **Marcada**
  (roja). Una tarea con etiqueta sigue abierta — sigue trabajándola.
- **Completadas** (abajo, plegado) — tareas que un encargado cerró. Solo lectura.

### Crear una tarea nueva

Solo cuando el trabajo no está en la lista: toca **＋ Añadir tarea**, ponle el nombre
de la sección/ubicación, elige el tipo de trabajo más parecido.

---

## Registrar tu día en una tarea

Toca una tarea para abrirla. Esta es tu área de trabajo del día.

### Contar kits (ensambles)

Las pestañas (**Aéreo / Metraje / Empalme / Subterráneo**) agrupan **kits** de piezas
que van juntas.

- Toca **＋** junto a un kit para contar uno, **−** para quitar
- Los kits de metraje (fibra, cable, conducto) llevan un número — escribe los pies

### Agregar una pieza que no está en ningún kit

1. Toca **＋ Agregar pieza**
2. Búscala, elígela, pon la cantidad

### Horas y notas

Las horas empiezan en 8 — ajusta con **＋/−**. Deja una **nota** para lo que el
encargado deba saber.

> 🔄 **Se guarda solo.** Cierra la app, reinicia el teléfono, pásale la tarea a otro —
> los conteos quedan guardados en la tarea.

### Si arriba aparece trabajo de otras personas

Las tareas son compartidas a propósito (cambios de cuadrilla, varios en un trabajo):

- **Franja "N jornadas enviadas · ver ›"** — lo ya enviado en esta tarea, tuyo o de
  otros ("incluye a ___" los nombra). Tócala para ver cada jornada. Las jornadas
  enviadas no las puede editar nadie.
- **Advertencia al entrar:** *"Esta tarea tiene trabajo SIN ENVIAR de ___"* — un
  compañero dejó conteos sin enviar. Continuar significa editar **su** borrador — solo
  si estás tomando su día. Si regresas, no cambia nada.
- **Franja ámbar "Editando el borrador SIN ENVIAR de ___"** — estás dentro de su
  borrador ahora.

---

## Enviar tu día

1. Toca **Terminar día →**
2. En **Enviar tu día**: revisa la lista de piezas (ajusta o quita líneas), pon las
   horas, agrega nota si hace falta
3. Toca **Enviar día ✓** para confirmar — o **Seguir registrando** para regresar

> 🔒 **Una jornada enviada es final** — no se puede editar después. Si algo está mal,
> dile a tu encargado; él la marca y tú la vuelves a enviar (abajo).

Después de enviar:
- **La tarea se queda en Activas** con la etiqueta ámbar *Enviada* — así debe ser.
  Mañana abres la misma tarea, sale el formulario en blanco, y registras una jornada
  nueva. **No vuelvas a crear la tarea.**
- El encargado aprueba o marca cada jornada desde su cola
- Al aprobar, las piezas pasan camión → proyecto automáticamente
- Cuando todo el trabajo termina, el **encargado** cierra la tarea y pasa a Completadas

---

## Si el encargado marca tu jornada

Una marca significa que algo hay que corregir — cantidad equivocada, pieza faltante, etc.

Verás una **franja roja** en la tarea con el motivo del encargado **y los números que
enviaste** ("Lo que enviaste: 8 hrs · 5× …").

1. Abre la tarea — el formulario está en blanco a propósito
2. Vuelve a capturar el día **correctamente**, usando los números de la franja
3. **Enviar día ✓** — tu jornada nueva reemplaza a la marcada

---

## Cuenta: idioma, contraseña, cerrar sesión

Toca tu **círculo de iniciales** (arriba del menú lateral, o el avatar en el teléfono):

- 🌐 **Idioma** — EN / Español (se recuerda en este dispositivo)
- 🔑 **Cambiar contraseña**
- **Cerrar sesión**

---

## Solución rápida de problemas

| Problema | Solución |
|---|---|
| "¡Mi tarea desapareció!" | No desapareció — revisa **Completadas** (un encargado la cerró) o busca la etiqueta *Enviada* en Activas. **Nunca la vuelvas a crear**; pide al encargado que la reabra. |
| Envié números equivocados | Avísale a tu encargado — él marca la jornada y tú la vuelves a enviar. |
| La búsqueda no encuentra nada | Revisa la ortografía — la búsqueda de varias palabras funciona. Si la pieza sale gris, su departamento no está en la lista de tu cuadrilla. |
| Advertencia "la cantidad excede lo disponible" | Puedes continuar — pero solo si de verdad tienes el material en la mano. Deja la fuente en negativo y tu encargado lo verá. |
| Mi camión muestra números equivocados | Actualiza la página — Mi Material no se actualiza solo cuando un encargado mueve material. ¿Sigue mal? Avísale a tu encargado. |
| La tarea debería ir a otro proyecto | Usa el selector **"Materiales asignados a:"** en el área de trabajo. Pregunta si tienes duda. |
| La app está lenta / rara | Actualiza fuerte (desliza para actualizar, o Ctrl+Shift+R). Vuelve a iniciar sesión. |

## A quién preguntar

- **Problemas con la app, contraseña, datos equivocados:** Chris (o tu encargado)
- **Qué kit usar, qué piezas llevar:** tu líder de cuadrilla

---

*Last updated / Última actualización: July 2026*
