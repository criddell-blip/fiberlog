// ============================================================
// FIBERLOG — SUPABASE CONNECTION LAYER
// fiberlog-db.js
//
// Import this file in all three apps:
//
//   <!-- Add both of these to <head> of each HTML file -->
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="fiberlog-db.js"></script>
//
// Project: fiberlog
// Supabase URL: https://attduslwidxecmjifsnl.supabase.co
// Key type: Publishable (safe for browser use)
// ============================================================

const SUPABASE_URL = 'https://attduslwidxecmjifsnl.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_RkQElhXYGUEw6iUtXmcn5w_URF87Qp0';

// ─── CLIENT INIT ─────────────────────────────────────────────
// Supabase new publishable key format (2025+)
// Uses the CDN build — no build step needed
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  }
});

// ============================================================
// AUTH — PIN-BASED LOGIN
// Crew members log in with their name + 4-digit PIN
// ============================================================
const Auth = {

  // Get all active crew (for the user picker dropdown)
  async getCrewList() {
    const { data, error } = await db
      .from('users')
      .select('id, name, initials, role, crew_type, is_contractor')
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    return data;
  },

  // Simple PIN login — returns user or null
  async loginWithPin(userId, pin) {
    const { data, error } = await db
      .from('users')
      .select('*')
      .eq('id', userId)
      .eq('pin', pin)
      .single();
    if (error) return null;
    // Store in session
    sessionStorage.setItem('fiberlog_user', JSON.stringify(data));
    return data;
  },

  // Get current user from session
  getCurrentUser() {
    const stored = sessionStorage.getItem('fiberlog_user');
    return stored ? JSON.parse(stored) : null;
  },

  // Set current user (for PIN-less dev mode)
  setCurrentUser(user) {
    sessionStorage.setItem('fiberlog_user', JSON.stringify(user));
  },

  logout() {
    sessionStorage.removeItem('fiberlog_user');
  }
};

// ============================================================
// PROJECTS — load hierarchy for crew navigation
// ============================================================
const Projects = {

  // Load all active projects with phases and tasks
  async getFullTree() {
    const { data: projects, error: pErr } = await db
      .from('projects')
      .select('*')
      .eq('status', 'active')
      .order('name');
    if (pErr) throw pErr;

    const { data: phases, error: phErr } = await db
      .from('phases')
      .select('*')
      .order('sequence_order');
    if (phErr) throw phErr;

    const { data: tasks, error: tErr } = await db
      .from('tasks')
      .select('*')
      .order('name');
    if (tErr) throw tErr;

    // Build tree
    return projects.map(proj => ({
      ...proj,
      phases: phases
        .filter(ph => ph.project_id === proj.id)
        .map(ph => ({
          ...ph,
          tasks: tasks.filter(t => t.phase_id === ph.id)
        }))
    }));
  },

  // Get project completion stats
  async getCompletionStats() {
    const { data, error } = await db
      .from('project_completion')
      .select('*');
    if (error) throw error;
    return data;
  },

  // Mark a task done
  async markTaskDone(taskId, userId) {
    const { error } = await db
      .from('tasks')
      .update({
        status: 'done',
        completed_at: new Date().toISOString(),
        completed_by: userId
      })
      .eq('id', taskId);
    if (error) throw error;
  },

  // Add a new task (freeform / crew-created)
  async addTask(phaseId, name, taskType, notes, userId) {
    const { data, error } = await db
      .from('tasks')
      .insert({
        phase_id: phaseId,
        name,
        task_type: taskType,
        status: 'open',
        scope_notes: notes,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }
};

// ============================================================
// ASSEMBLIES — load templates with parts
// ============================================================
const Assemblies = {

  async getAll() {
    const { data: assemblies, error: aErr } = await db
      .from('assemblies')
      .select('*')
      .eq('is_active', true);
    if (aErr) throw aErr;

    const { data: parts, error: pErr } = await db
      .from('assembly_parts')
      .select(`
        assembly_id,
        default_qty,
        parts_catalog ( id, name, unit, category )
      `);
    if (pErr) throw pErr;

    // Build templates object matching front end ASSEMBLIES shape
    const templates = {};
    assemblies.forEach(a => {
      templates[a.id] = {
        label: a.label,
        crewType: a.crew_type,
        parts: parts
          .filter(p => p.assembly_id === a.id)
          .map(p => ({
            id: p.parts_catalog.id,
            name: p.parts_catalog.name,
            unit: p.parts_catalog.unit,
            qty: p.default_qty
          }))
      };
    });
    return templates;
  }
};

// ============================================================
// PARTS CATALOG
// ============================================================
const Parts = {

  async getAll() {
    const { data, error } = await db
      .from('parts_catalog')
      .select('*')
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    return data;
  },

  async search(query) {
    const { data, error } = await db
      .from('parts_catalog')
      .select('*')
      .or(`name.ilike.%${query}%,id.ilike.%${query}%`)
      .eq('is_active', true)
      .limit(12);
    if (error) throw error;
    return data;
  }
};

// ============================================================
// WORK SESSIONS — drives in-progress visibility
// ============================================================
const Sessions = {

  // Start or resume today's session for a user
  async startSession(userId, taskId) {
    const today = new Date().toISOString().split('T')[0];

    // Check for existing session today
    const { data: existing } = await db
      .from('work_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('session_date', today)
      .single();

    if (existing) {
      // Update task if changed
      if (taskId && existing.task_id !== taskId) {
        await db
          .from('work_sessions')
          .update({ task_id: taskId, status: 'in-progress' })
          .eq('id', existing.id);
      }
      return existing;
    }

    // Create new session
    const { data, error } = await db
      .from('work_sessions')
      .insert({
        user_id: userId,
        task_id: taskId,
        session_date: today,
        status: taskId ? 'started' : 'started'
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  // Update session status and counts
  async updateSession(sessionId, updates) {
    const { error } = await db
      .from('work_sessions')
      .update(updates)
      .eq('id', sessionId);
    if (error) throw error;
  },

  // Get all sessions for today (manager view)
  async getTodaySessions() {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await db
      .from('crew_activity_today')
      .select('*');
    if (error) throw error;
    return data;
  },

  // Real-time subscription for manager — fires on any session update
  subscribeToSessions(callback) {
    return db
      .channel('work_sessions_live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'work_sessions' },
        (payload) => callback(payload)
      )
      .subscribe();
  }
};

// ============================================================
// LOG ENTRIES — individual taps throughout the day
// ============================================================
const Entries = {

  // Save a single log entry and its parts
  async saveEntry(sessionId, userId, taskId, entryData) {
    // 1. Insert log entry
    const { data: entry, error: eErr } = await db
      .from('log_entries')
      .insert({
        session_id: sessionId,
        user_id: userId,
        task_id: taskId,
        entry_type: entryData.type,
        assembly_id: entryData.assemblyKey || null,
        assembly_qty: entryData.qty || 1,
        footage_amt: entryData.footage || null,
        footage_type: entryData.footageType || null,
        footage_from: entryData.from || null,
        footage_to: entryData.to || null,
        note_type: entryData.noteType || null,
        note_text: entryData.text || null,
        location_desc: entryData.location || null,
        closure_id: entryData.closureId || null,
      })
      .select()
      .single();
    if (eErr) throw eErr;

    // 2. Insert parts
    if (entryData.parts && entryData.parts.length > 0) {
      const partRows = entryData.parts.map(p => ({
        entry_id: entry.id,
        part_id: p.id,
        quantity: p.qty,
        is_extra: p.isExtra || false
      }));
      const { error: pErr } = await db
        .from('entry_parts')
        .insert(partRows);
      if (pErr) throw pErr;
    }

    // 3. Update session counts
    const footageAdded = entryData.footage || 0;
    await db.rpc('increment_session_counts', {
      p_session_id: sessionId,
      p_entry_count: 1,
      p_footage: footageAdded
    });

    return entry;
  },

  // Update session counter via RPC
  // (Create this function in Supabase SQL editor)
  async loadEntries(sessionId) {
    const { data, error } = await db
      .from('log_entries')
      .select(`
        *,
        entry_parts (
          part_id,
          quantity,
          is_extra,
          parts_catalog ( id, name, unit )
        )
      `)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data;
  }
};

// ============================================================
// SUBMISSIONS — end-of-day submit and approval flow
// ============================================================
const Submissions = {

  // Submit end of day — creates submission record
  async submitDay(sessionId, userId, hoursWorked, totals) {
    // 1. Create submission
    const { data: sub, error: sErr } = await db
      .from('submissions')
      .insert({
        session_id: sessionId,
        user_id: userId,
        session_date: new Date().toISOString().split('T')[0],
        hours_worked: hoursWorked,
        status: 'pending',
        total_footage: totals.footage,
        total_assemblies: totals.assemblies,
        total_part_types: totals.partTypes
      })
      .select()
      .single();
    if (sErr) throw sErr;

    // 2. Lock session as submitted
    await db
      .from('work_sessions')
      .update({
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        hours_worked: hoursWorked
      })
      .eq('id', sessionId);

    return sub;
  },

  // Get all pending submissions (manager)
  async getPending() {
    const { data, error } = await db
      .from('submissions')
      .select(`
        *,
        users ( name, initials, crew_type, is_contractor ),
        work_sessions (
          task_id,
          tasks ( name, task_type,
            phases ( name,
              projects ( name )
            )
          )
        )
      `)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  },

  // Get submission with full parts breakdown
  async getWithParts(submissionId) {
    const { data: sub, error } = await db
      .from('submissions')
      .select(`
        *,
        users ( name, initials, crew_type ),
        work_sessions (
          task_id,
          entry_count,
          footage_total,
          log_entries (
            entry_type, assembly_id, assembly_qty,
            footage_amt, footage_type, note_text,
            entry_parts (
              quantity, is_extra,
              parts_catalog ( id, name, unit, category )
            )
          ),
          tasks ( name, phases ( name, projects ( name ) ) )
        )
      `)
      .eq('id', submissionId)
      .single();
    if (error) throw error;
    return sub;
  },

  // Approve a submission
  async approve(submissionId, managerId, notes) {
    const { data: sub, error: sErr } = await db
      .from('submissions')
      .update({
        status: 'approved',
        reviewed_by: managerId,
        reviewed_at: new Date().toISOString(),
        manager_notes: notes || null
      })
      .eq('id', submissionId)
      .select()
      .single();
    if (sErr) throw sErr;

    // Roll up material consumption
    await Submissions._rollupConsumption(submissionId);
    return sub;
  },

  // Flag a submission
  async flag(submissionId, managerId, reason) {
    const { error } = await db
      .from('submissions')
      .update({
        status: 'flagged',
        reviewed_by: managerId,
        reviewed_at: new Date().toISOString(),
        flag_reason: reason
      })
      .eq('id', submissionId);
    if (error) throw error;
  },

  // Internal — aggregate parts into material_consumption on approval
  async _rollupConsumption(submissionId) {
    // Load full submission data
    const sub = await Submissions.getWithParts(submissionId);
    const session = sub.work_sessions;
    const task = session?.tasks;
    const phase = task?.phases;
    const project = phase?.projects;

    // Aggregate all parts across entries
    const partTotals = {};
    (session?.log_entries || []).forEach(entry => {
      (entry.entry_parts || []).forEach(ep => {
        const id = ep.parts_catalog.id;
        if (!partTotals[id]) partTotals[id] = 0;
        partTotals[id] += ep.quantity;
      });
    });

    // Get IDs for FK references
    const { data: taskData } = await db
      .from('tasks')
      .select('id, phase_id, phases(project_id)')
      .eq('name', task?.name)
      .single();

    if (!taskData) return;

    const rows = Object.entries(partTotals).map(([partId, qty]) => ({
      project_id: taskData.phases.project_id,
      phase_id: taskData.phase_id,
      task_id: taskData.id,
      part_id: partId,
      quantity: qty,
      submission_id: submissionId
    }));

    if (rows.length > 0) {
      await db.from('material_consumption').insert(rows);
    }
  },

  // Real-time subscription for managers
  subscribeToSubmissions(callback) {
    return db
      .channel('submissions_live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'submissions' },
        (payload) => callback(payload)
      )
      .subscribe();
  }
};

// ============================================================
// EMERGENCY LOGS
// ============================================================
const Emergency = {

  async getUnassigned() {
    const { data, error } = await db
      .from('emergency_logs')
      .select(`
        *,
        users ( name, crew_type ),
        emergency_log_parts (
          quantity,
          parts_catalog ( id, name, unit )
        )
      `)
      .eq('status', 'unassigned')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  },

  async submit(userId, loggedBy, workType, description, startedAt, endedAt, parts) {
    // 1. Create log
    const { data: log, error: lErr } = await db
      .from('emergency_logs')
      .insert({
        user_id: userId,
        logged_by: loggedBy,
        work_type: workType,
        description,
        started_at: startedAt,
        ended_at: endedAt,
        status: 'unassigned'
      })
      .select()
      .single();
    if (lErr) throw lErr;

    // 2. Insert parts
    if (parts && parts.length > 0) {
      await db.from('emergency_log_parts').insert(
        parts.map(p => ({
          emergency_log_id: log.id,
          part_id: p.id,
          quantity: p.qty
        }))
      );
    }
    return log;
  },

  async assign(logId, projectId) {
    const { error } = await db
      .from('emergency_logs')
      .update({ project_id: projectId, status: 'assigned' })
      .eq('id', logId);
    if (error) throw error;
  }
};

// ============================================================
// MATERIAL REPORTS
// ============================================================
const Materials = {

  // Get all consumption for a project (approved only)
  async getByProject(projectId) {
    const { data, error } = await db
      .from('material_summary')
      .select('*')
      .eq('project_id', projectId)
      .order('category')
      .order('part_name');
    if (error) throw error;
    return data;
  },

  // Get consumption by category for a project
  async getByCategory(projectId, category) {
    const { data, error } = await db
      .from('material_summary')
      .select('*')
      .eq('project_id', projectId)
      .eq('category', category);
    if (error) throw error;
    return data;
  }
};

// ============================================================
// SUPABASE RPC — run this SQL in Supabase SQL Editor too
// ============================================================
/*

-- Increment session entry count and footage (called on each entry save)
CREATE OR REPLACE FUNCTION increment_session_counts(
  p_session_id UUID,
  p_entry_count INT DEFAULT 1,
  p_footage NUMERIC DEFAULT 0
)
RETURNS void AS $$
BEGIN
  UPDATE work_sessions
  SET
    entry_count = entry_count + p_entry_count,
    footage_total = footage_total + p_footage,
    status = CASE
      WHEN status = 'started' THEN 'in-progress'
      ELSE status
    END,
    updated_at = NOW()
  WHERE id = p_session_id;
END;
$$ LANGUAGE plpgsql;

*/

// ============================================================
// REALTIME MANAGER HELPERS
// ============================================================
const Realtime = {
  channels: [],

  // Subscribe to all live updates manager needs
  subscribeAll(callbacks) {
    // Work sessions (in-progress status)
    const sessionChannel = db
      .channel('manager_sessions')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'work_sessions' },
        (payload) => callbacks.onSessionUpdate && callbacks.onSessionUpdate(payload)
      )
      .subscribe();

    // New submissions
    const subChannel = db
      .channel('manager_submissions')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'submissions' },
        (payload) => callbacks.onNewSubmission && callbacks.onNewSubmission(payload)
      )
      .subscribe();

    // Emergency logs
    const emergencyChannel = db
      .channel('manager_emergency')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'emergency_logs' },
        (payload) => callbacks.onEmergency && callbacks.onEmergency(payload)
      )
      .subscribe();

    this.channels = [sessionChannel, subChannel, emergencyChannel];
    return this.channels;
  },

  unsubscribeAll() {
    this.channels.forEach(ch => db.removeChannel(ch));
    this.channels = [];
  }
};

// ============================================================
// UTILITY
// ============================================================
const Utils = {
  // Format timestamp for display
  formatTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit'
    });
  },

  formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
    });
  },

  today() {
    return new Date().toISOString().split('T')[0];
  },

  // Build parts summary from log entries
  buildPartsSummary(entries) {
    const totals = {};
    entries.forEach(entry => {
      (entry.entry_parts || []).forEach(ep => {
        const part = ep.parts_catalog;
        if (!totals[part.id]) {
          totals[part.id] = { id: part.id, name: part.name, unit: part.unit, qty: 0 };
        }
        totals[part.id].qty += ep.quantity;
      });
    });
    return Object.values(totals);
  }
};

// Export everything
window.FiberLog = {
  db,
  Auth,
  Projects,
  Assemblies,
  Parts,
  Sessions,
  Entries,
  Submissions,
  Emergency,
  Materials,
  Realtime,
  Utils
};

console.log('FiberLog DB layer loaded ✓');
