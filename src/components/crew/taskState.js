// Single source of truth for crew-side task-state predicates.
//
// Under the is_closed model (backlog #2) a task's lifecycle is decoupled
// from submission approval: submissions carry their own pending → approved
// → rejected status, and ONLY the manager's explicit close removes a task
// from the crew's active work. `tasks.status` must never drive these
// predicates — an approved-but-open task is still active (the crew can keep
// logging passdowns against it), and counting it as "complete" in one view
// while it sits in Active in another reads as a bug.
//
// Used by both crew shells (CrewApp / InfraCrewApp) and their list views
// (ProjectList / PhaseList / SitesList). Progress bars = closed / total.

// Editable from the crew workspace until the manager explicitly closes it.
// Only closed tasks go to the read-only TaskSummaryView. Submitting a
// passdown no longer locks the task — the crew can keep logging against it
// day after day until it's closed.
export const isReadOnlyTask = t => !!t.is_closed

// Tasks the crew can still act on (sidebar trees, open-task counts). A task
// drops out of the active list only when the manager closes it — submitted
// or approved passdowns leave the task open so the crew can keep logging.
export const isActiveCrewTask = t => !t.is_closed

// Complete = manager-closed. Feeds the done/total progress math.
export const isCompletedTask = t => !!t.is_closed
