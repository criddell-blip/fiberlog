// FiberLog i18n — English / Spanish
// Usage: import { t } from '../../lib/i18n'; then t('key', lang)

const strings = {
  // ── App / Login ────────────────────────────────────────────────────────────
  appName:            { en: 'FiberLog',                   es: 'FiberLog' },
  company:            { en: 'Utah Broadband',             es: 'Utah Broadband' },
  management:         { en: 'Management',                 es: 'Gerencia' },
  crew:               { en: 'Crew',                       es: 'Cuadrilla' },
  owner:              { en: 'Owner',                      es: 'Propietario' },
  manager:            { en: 'Manager',                    es: 'Gerente' },
  signOut:            { en: 'Sign out',                   es: 'Cerrar sesión' },
  close:              { en: 'Close',                      es: 'Cerrar' },

  // ── Crew types ─────────────────────────────────────────────────────────────
  aerial:             { en: '🏗️ Aerial',                  es: '🏗️ Aéreo' },
  underground:        { en: '⛏️ Underground',              es: '⛏️ Subterráneo' },
  splice:             { en: '🔌 Splice',                  es: '🔌 Empalme' },
  drop:               { en: '🏠 Drop',                    es: '🏠 Acometida' },
  locator:            { en: '📡 Locator',                 es: '📡 Localizador' },
  contractor:         { en: '🔧 Contractor',              es: '🔧 Contratista' },

  // ── Project list ───────────────────────────────────────────────────────────
  yourProjects:       { en: 'Your projects',              es: 'Tus proyectos' },
  noProjects:         { en: 'No active projects found',   es: 'No se encontraron proyectos activos' },
  phases:             { en: 'phases',                     es: 'fases' },
  fiberFt:            { en: 'ft fiber',                   es: 'pies de fibra' },
  conduitFt:          { en: 'ft conduit',                 es: 'pies de tubería' },
  pctComplete:        { en: '% complete',                 es: '% completado' },
  tasksDone:          { en: 'tasks done',                 es: 'tareas completadas' },

  // ── Phase list ─────────────────────────────────────────────────────────────
  phasesLabel:        { en: 'Phases',                     es: 'Fases' },
  tasks:              { en: 'tasks',                      es: 'tareas' },

  // ── Task list ──────────────────────────────────────────────────────────────
  activeTasks:        { en: 'Active tasks',               es: 'Tareas activas' },
  noActiveTasks:      { en: 'No active tasks — add one below', es: 'Sin tareas activas — añade una abajo' },
  completed:          { en: 'Completed',                  es: 'Completadas' },
  addTask:            { en: 'Add task to this phase',     es: 'Añadir tarea a esta fase' },
  inProgress:         { en: 'In progress',                es: 'En progreso' },
  done:               { en: 'Done',                       es: 'Hecho' },
  open:               { en: 'Open',                       es: 'Abierto' },

  // ── Add task form ──────────────────────────────────────────────────────────
  addTaskTitle:       { en: 'Add task to phase',          es: 'Añadir tarea a la fase' },
  addTaskSub:         { en: 'Name the section or location you are working on', es: 'Nombra la sección o ubicación donde trabajas' },
  jobType:            { en: 'Job type',                   es: 'Tipo de trabajo' },
  locationName:       { en: 'Section / location name',    es: 'Nombre de sección / ubicación' },
  locationPlaceholder:{ en: 'e.g. Elm St Poles 14–21, Oak Ave MH crossing', es: 'Ej. Postes Elm St 14–21, cruce MH Oak Ave' },
  notesOptional:      { en: 'Notes (optional)',            es: 'Notas (opcional)' },
  notesPlaceholder:   { en: 'e.g. 650ft span, flagged pole at #17', es: 'Ej. tramo 200m, poste marcado en #17' },
  cancel:             { en: 'Cancel',                     es: 'Cancelar' },
  startTask:          { en: 'Start this task',            es: 'Iniciar esta tarea' },
  saving:             { en: 'Saving...',                  es: 'Guardando...' },

  // ── Job types ──────────────────────────────────────────────────────────────
  aerialConstruction: { en: 'Aerial Construction',        es: 'Construcción Aérea' },
  undergroundJob:     { en: 'Underground',                es: 'Subterráneo' },
  spliceJob:          { en: 'Splice',                     es: 'Empalme' },
  fiberPull:          { en: 'Fiber Pull',                 es: 'Jale de Fibra' },
  emergency:          { en: 'Emergency Fix',              es: 'Reparación de Emergencia' },

  // ── Task workspace ─────────────────────────────────────────────────────────
  aerialTab:          { en: 'Aerial',                     es: 'Aéreo' },
  footageTab:         { en: 'Footage / MST',              es: 'Metraje / MST' },
  spliceTab:          { en: 'Splice',                     es: 'Empalme' },
  undergroundTab:     { en: 'Underground',                es: 'Subterráneo' },
  strandLabel:        { en: 'Strand',                     es: 'Mensajero' },
  fiberLabel:         { en: 'Fiber',                      es: 'Fibra' },
  boreLabel:          { en: 'Bore',                       es: 'Perforación' },
  plowLabel:          { en: 'Plow',                       es: 'Arado' },
  polesLabel:         { en: 'poles',                      es: 'postes' },
  conduitSize:        { en: 'Conduit size',               es: 'Tamaño de tubería' },
  fiberCount:         { en: 'Fiber count',                es: 'Conteo de fibra' },
  partTypes:          { en: 'part types',                 es: 'tipos de partes' },
  review:             { en: 'Review',                     es: 'Revisar' },
  wrapUpDay:          { en: 'Wrap up day →',              es: 'Terminar día →' },

  // ── Submit / summary sheet ─────────────────────────────────────────────────
  submitYourDay:      { en: 'Submit your day',            es: 'Enviar tu día' },
  partsAdjust:        { en: 'Parts — adjust qty or remove before submitting', es: 'Partes — ajusta cantidad o elimina antes de enviar' },
  noPartsLogged:      { en: 'No parts logged yet',        es: 'No hay partes registradas aún' },
  hoursWorked:        { en: 'Hours worked',               es: 'Horas trabajadas' },
  noteOptional:       { en: 'Note (optional)',             es: 'Nota (opcional)' },
  noteplaceholder:    { en: 'Anything the manager should know...', es: 'Algo que el gerente deba saber...' },
  keepLogging:        { en: 'Keep logging',               es: 'Seguir registrando' },
  submitDay:          { en: 'Submit day ✓',               es: 'Enviar día ✓' },
  submitting:         { en: 'Submitting...',              es: 'Enviando...' },
  addPartNotInList:   { en: '＋ Add part not in list',    es: '＋ Añadir parte que no está en la lista' },
  searchPartPlaceholder: { en: 'Search by name or SKU...', es: 'Buscar por nombre o SKU...' },

  // ── Toast messages ─────────────────────────────────────────────────────────
  toastSubmitted:     { en: 'Day submitted — pending approval', es: 'Día enviado — pendiente de aprobación' },
  toastTaskAdded:     { en: 'Task added — tap it to start logging', es: 'Tarea añadida — tócala para empezar' },
  toastFailedSave:    { en: 'Failed to save task — check connection', es: 'Error al guardar tarea — verifica conexión' },
  toastSelectUser:    { en: 'Select a crew member first', es: 'Primero selecciona un miembro de la cuadrilla' },

  // ── Sidebar (wide screen) ──────────────────────────────────────────────────
  pickTask:           { en: 'Pick a project from the sidebar', es: 'Elige un proyecto del panel lateral' },
  pickTaskSub:        { en: 'Expand a project → phase → task to start logging', es: 'Expande proyecto → fase → tarea para empezar' },
  projectsLabel:      { en: 'Projects',                   es: 'Proyectos' },
}

export function t(key, lang = 'en') {
  const entry = strings[key]
  if (!entry) return key
  return entry[lang] || entry['en'] || key
}

export default strings
