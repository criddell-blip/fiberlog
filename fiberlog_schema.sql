-- ============================================================
-- FIBERLOG — COMPLETE DATABASE SCHEMA
-- Run this entire file in Supabase SQL Editor
-- Project: FiberLog v1.0
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- USERS & ROLES
-- ============================================================
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  name          TEXT NOT NULL,
  initials      TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','manager','crew')),
  crew_type     TEXT CHECK (crew_type IN ('aerial','underground','splice','drop','locator','contractor')),
  phone         TEXT,
  pin           TEXT,          -- 4-digit PIN for field login (hashed in production)
  is_contractor BOOLEAN DEFAULT false,
  is_active     BOOLEAN DEFAULT true,
  notes         TEXT
);

-- ============================================================
-- PARTS CATALOG
-- ============================================================
CREATE TABLE parts_catalog (
  id          TEXT PRIMARY KEY,   -- e.g. "CLAMP_D_LASH"
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  name        TEXT NOT NULL,
  unit        TEXT NOT NULL,      -- "ea", "ft", "coil"
  category    TEXT NOT NULL,
  boxhero_id  TEXT,              -- future BoxHero sync
  is_active   BOOLEAN DEFAULT true
);

-- ============================================================
-- ASSEMBLY TEMPLATES
-- ============================================================
CREATE TABLE assemblies (
  id          TEXT PRIMARY KEY,   -- e.g. "lashingIntermediate"
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  label       TEXT NOT NULL,
  crew_type   TEXT,              -- which crew type typically uses this
  is_active   BOOLEAN DEFAULT true
);

CREATE TABLE assembly_parts (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  assembly_id  TEXT NOT NULL REFERENCES assemblies(id) ON DELETE CASCADE,
  part_id      TEXT NOT NULL REFERENCES parts_catalog(id) ON DELETE CASCADE,
  default_qty  NUMERIC NOT NULL DEFAULT 1,
  UNIQUE(assembly_id, part_id)
);

-- ============================================================
-- PROJECT HIERARCHY
-- ============================================================
CREATE TABLE projects (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  name            TEXT NOT NULL,
  region          TEXT NOT NULL,
  total_fiber_ft  NUMERIC DEFAULT 0,
  total_conduit_ft NUMERIC DEFAULT 0,
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','complete','on-hold')),
  contract_end    DATE,
  vetro_project_id TEXT,         -- future Vetro integration
  notes           TEXT
);

CREATE TABLE phases (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  sequence_order  INT NOT NULL DEFAULT 1,
  fiber_ft        NUMERIC DEFAULT 0,
  conduit_ft      NUMERIC DEFAULT 0,
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','complete','on-hold'))
);

CREATE TABLE tasks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  phase_id        UUID NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  task_type       TEXT NOT NULL,  -- maps to TEMPLATES in front end
  status          TEXT DEFAULT 'open' CHECK (status IN ('open','active','done')),
  scope_notes     TEXT,
  assigned_crew_type TEXT,
  clickup_task_id TEXT,           -- future ClickUp integration
  vetro_segment_id TEXT,          -- future Vetro integration
  completed_at    TIMESTAMPTZ,
  completed_by    UUID REFERENCES users(id)
);

CREATE TABLE task_assignments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_date DATE DEFAULT CURRENT_DATE,
  assigned_by UUID REFERENCES users(id),
  UNIQUE(task_id, user_id, assigned_date)
);

-- ============================================================
-- WORK SESSIONS (drives in-progress visibility)
-- ============================================================
CREATE TABLE work_sessions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  user_id       UUID NOT NULL REFERENCES users(id),
  task_id       UUID REFERENCES tasks(id),
  session_date  DATE DEFAULT CURRENT_DATE,
  status        TEXT DEFAULT 'started' CHECK (status IN ('started','in-progress','submitted')),
  entry_count   INT DEFAULT 0,
  footage_total NUMERIC DEFAULT 0,
  hours_worked  NUMERIC,
  submitted_at  TIMESTAMPTZ,
  notes         TEXT
);

-- Auto-update updated_at on work_sessions
CREATE OR REPLACE FUNCTION update_session_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER work_sessions_updated_at
  BEFORE UPDATE ON work_sessions
  FOR EACH ROW EXECUTE FUNCTION update_session_timestamp();

-- ============================================================
-- LOG ENTRIES (every tap throughout the day)
-- ============================================================
CREATE TABLE log_entries (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  session_id    UUID NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id),
  task_id       UUID REFERENCES tasks(id),
  entry_type    TEXT NOT NULL CHECK (entry_type IN ('assembly','footage','material','note','issue')),
  assembly_id   TEXT REFERENCES assemblies(id),
  assembly_qty  INT DEFAULT 1,
  footage_amt   NUMERIC,
  footage_type  TEXT,            -- "Aerial — lashing", "Underground — bore" etc
  footage_from  TEXT,            -- "Pole 14"
  footage_to    TEXT,            -- "Pole 21"
  note_type     TEXT,
  note_text     TEXT,
  location_desc TEXT,
  -- Splicer fields (future)
  closure_id    TEXT,            -- e.g. "A-14"
  vetro_node_id TEXT
);

-- ============================================================
-- ENTRY PARTS (parts logged per entry)
-- ============================================================
CREATE TABLE entry_parts (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  entry_id    UUID NOT NULL REFERENCES log_entries(id) ON DELETE CASCADE,
  part_id     TEXT NOT NULL REFERENCES parts_catalog(id),
  quantity    NUMERIC NOT NULL DEFAULT 1,
  is_extra    BOOLEAN DEFAULT false  -- true if added outside assembly template
);

-- ============================================================
-- SUBMISSIONS (end-of-day locked records)
-- ============================================================
CREATE TABLE submissions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  session_id      UUID NOT NULL REFERENCES work_sessions(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  session_date    DATE DEFAULT CURRENT_DATE,
  hours_worked    NUMERIC NOT NULL DEFAULT 8,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','flagged')),
  -- Manager review
  reviewed_by     UUID REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  manager_notes   TEXT,
  flag_reason     TEXT,
  -- Rollup totals (computed on submit)
  total_footage   NUMERIC DEFAULT 0,
  total_assemblies INT DEFAULT 0,
  total_part_types INT DEFAULT 0
);

-- ============================================================
-- MATERIAL CONSUMPTION (rolled up per project, updated on approval)
-- ============================================================
CREATE TABLE material_consumption (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  project_id  UUID NOT NULL REFERENCES projects(id),
  phase_id    UUID REFERENCES phases(id),
  task_id     UUID REFERENCES tasks(id),
  part_id     TEXT NOT NULL REFERENCES parts_catalog(id),
  quantity    NUMERIC NOT NULL DEFAULT 0,
  submission_id UUID REFERENCES submissions(id),
  UNIQUE(submission_id, part_id)
);

-- ============================================================
-- EMERGENCY / FREEFORM LOGS
-- ============================================================
CREATE TABLE emergency_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  user_id       UUID REFERENCES users(id),
  logged_by     UUID REFERENCES users(id),  -- manager who entered it
  work_type     TEXT NOT NULL,
  description   TEXT NOT NULL,
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  project_id    UUID REFERENCES projects(id),  -- nullable until assigned
  status        TEXT DEFAULT 'unassigned' CHECK (status IN ('unassigned','assigned','resolved')),
  manager_notes TEXT
);

CREATE TABLE emergency_log_parts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  emergency_log_id UUID NOT NULL REFERENCES emergency_logs(id) ON DELETE CASCADE,
  part_id         TEXT NOT NULL REFERENCES parts_catalog(id),
  quantity        NUMERIC NOT NULL DEFAULT 1
);

-- ============================================================
-- VIEWS (used by manager dashboard)
-- ============================================================

-- Today's crew activity view
CREATE VIEW crew_activity_today AS
SELECT
  u.id as user_id,
  u.name,
  u.initials,
  u.crew_type,
  u.is_contractor,
  ws.id as session_id,
  ws.status as session_status,
  ws.entry_count,
  ws.footage_total,
  ws.updated_at as last_activity,
  ws.task_id,
  t.name as current_task,
  ph.name as current_phase,
  p.name as current_project,
  ws.hours_worked,
  ws.session_date
FROM users u
LEFT JOIN work_sessions ws ON ws.user_id = u.id AND ws.session_date = CURRENT_DATE
LEFT JOIN tasks t ON ws.task_id = t.id
LEFT JOIN phases ph ON t.phase_id = ph.id
LEFT JOIN projects p ON ph.project_id = p.id
WHERE u.role = 'crew' AND u.is_active = true;

-- Project completion view
CREATE VIEW project_completion AS
SELECT
  p.id as project_id,
  p.name as project_name,
  p.total_fiber_ft,
  p.total_conduit_ft,
  COUNT(DISTINCT t.id) as total_tasks,
  COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END) as done_tasks,
  ROUND(
    COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END)::NUMERIC /
    NULLIF(COUNT(DISTINCT t.id), 0) * 100
  , 0) as pct_complete,
  SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as completed_task_count
FROM projects p
LEFT JOIN phases ph ON ph.project_id = p.id
LEFT JOIN tasks t ON t.phase_id = ph.id
WHERE p.status = 'active'
GROUP BY p.id, p.name, p.total_fiber_ft, p.total_conduit_ft;

-- Material usage summary view
CREATE VIEW material_summary AS
SELECT
  mc.project_id,
  p.name as project_name,
  mc.part_id,
  pc.name as part_name,
  pc.unit,
  pc.category,
  SUM(mc.quantity) as total_qty
FROM material_consumption mc
JOIN projects p ON mc.project_id = p.id
JOIN parts_catalog pc ON mc.part_id = pc.id
JOIN submissions s ON mc.submission_id = s.id
WHERE s.status = 'approved'
GROUP BY mc.project_id, p.name, mc.part_id, pc.name, pc.unit, pc.category;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE log_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;

-- For now: allow all authenticated users to read/write
-- Tighten per-role in production
CREATE POLICY "Allow all authenticated" ON users FOR ALL USING (true);
CREATE POLICY "Allow all authenticated" ON work_sessions FOR ALL USING (true);
CREATE POLICY "Allow all authenticated" ON log_entries FOR ALL USING (true);
CREATE POLICY "Allow all authenticated" ON entry_parts FOR ALL USING (true);
CREATE POLICY "Allow all authenticated" ON submissions FOR ALL USING (true);
CREATE POLICY "Allow all authenticated" ON material_consumption FOR ALL USING (true);
CREATE POLICY "Allow all authenticated" ON emergency_logs FOR ALL USING (true);
CREATE POLICY "Allow all authenticated" ON emergency_log_parts FOR ALL USING (true);
CREATE POLICY "Allow all" ON projects FOR ALL USING (true);
CREATE POLICY "Allow all" ON phases FOR ALL USING (true);
CREATE POLICY "Allow all" ON tasks FOR ALL USING (true);
CREATE POLICY "Allow all" ON task_assignments FOR ALL USING (true);
CREATE POLICY "Allow all" ON parts_catalog FOR ALL USING (true);
CREATE POLICY "Allow all" ON assemblies FOR ALL USING (true);
CREATE POLICY "Allow all" ON assembly_parts FOR ALL USING (true);

-- ============================================================
-- REALTIME (enable for live manager dashboard)
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE work_sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE log_entries;
ALTER PUBLICATION supabase_realtime ADD TABLE submissions;
ALTER PUBLICATION supabase_realtime ADD TABLE emergency_logs;

-- ============================================================
-- SEED DATA — PARTS CATALOG
-- ============================================================
INSERT INTO parts_catalog (id, name, unit, category) VALUES
-- Strand / Lashing
('STRAND_EHS_1_4',    'Strand EHS 1/4" 5000'' Reel',           'ft',   'Strand / Lashing'),
('CLAMP_B_SUS_5_8',   'Clamp B Suspension 5/8"',               'ea',   'Strand / Lashing'),
('LASH_WIRE_045T430', 'Lashing Wire .045T430 1200'' Coil',     'ea',   'Strand / Lashing'),
('CLAMP_D_LASH',      'Clamp D Cable Lashing Bug Nut',         'ea',   'Strand / Lashing'),
('STRAP_LASH_16',     'Strap Cable Lashing 16" Stainless',     'ea',   'Strand / Lashing'),
('SPACER_LASH_1_2',   'Spacer 1/2" Lashing Strap',            'ea',   'Strand / Lashing'),
('STRAP_LASH_10',     'Strap Cable Lashing 10" Stainless',     'ea',   'Strand / Lashing'),
('SPACER_STACK_1_2',  '1/2" Stackable Cable Spacer',          'ea',   'Strand / Lashing'),
('STRAND_SPLICE_1_4', 'Strand Splice 1/4" Preformed',          'ea',   'Strand / Lashing'),
('SNOWSHOE_16',       'Fiber Storage Unit 16" Snowshoe',       'ea',   'Strand / Lashing'),
-- Bolts / Nuts / Washers
('BOLT_5_8x12',       'Bolt Machine 5/8" x 12"',              'ea',   'Bolts / Nuts / Washers'),
('BOLT_5_8x14',       'Bolt Machine 5/8" x 14"',              'ea',   'Bolts / Nuts / Washers'),
('BOLT_5_8x16',       'Bolt Machine 5/8" x 16"',              'ea',   'Bolts / Nuts / Washers'),
('BOLT_5_8x18',       'Bolt Machine 5/8" x 18"',              'ea',   'Bolts / Nuts / Washers'),
('BOLT_TE_5_8x12',    'Bolt Thimble Eye 5/8" x 12"',          'ea',   'Bolts / Nuts / Washers'),
('BOLT_TE_5_8x14',    'Bolt Thimble Eye 5/8" x 14"',          'ea',   'Bolts / Nuts / Washers'),
('BOLT_TE_5_8x16',    'Bolt Thimble Eye 5/8" x 16"',          'ea',   'Bolts / Nuts / Washers'),
('BOLT_TE_3_4x18',    'Bolt Thimble Eye 3/4" x 18"',          'ea',   'Bolts / Nuts / Washers'),
('NUT_THIMBLE_5_8',   'Nut Thimble Eye 5/8"',                 'ea',   'Bolts / Nuts / Washers'),
('NUT_SQUARE_5_8',    'Nut Square 5/8"',                      'ea',   'Bolts / Nuts / Washers'),
('WASHER_SQUARE_2x2', 'Washer Square 2" x 2"',                'ea',   'Bolts / Nuts / Washers'),
-- Guy Hardware
('HOOK_B_GUY_5_8',    'Hook B Guy 5/8" Rams Head',            'ea',   'Guy Hardware'),
('ANCHOR_ROD_3_4x66', 'Anchor Rod 3/4" x 66"',               'ea',   'Guy Hardware'),
('GUY_INSULATOR',     'Guy Insulator 3.5" x 2.5"',           'ea',   'Guy Hardware'),
('GUY_GUARD_96',      'Guy Guard 96" Yellow',                  'ea',   'Guy Hardware'),
('GRIP_DEADEND_1_4',  'Grip Deadend Guy 1/4" Strand',         'ea',   'Guy Hardware'),
-- Riser / Conduit
('STANDOFF_12_STEEL', 'Standoff 12" Steel Diamond Mount',     'ea',   'Riser / Conduit'),
('STANDOFF_V_6',      '6" V-Style Standoff',                  'ea',   'Riser / Conduit'),
('RIGID_COND_2x10',   'Rigid Metal Conduit 2" x 10''',        'ea',   'Riser / Conduit'),
('PVC_COND_2x10',     'PVC Conduit 2" x 10''',                'ea',   'Riser / Conduit'),
('STRUT_CLAMP_2IN',   'Strut Pipe Clamp 2"',                  'ea',   'Riser / Conduit'),
('RIGID_COUPLER_2IN', 'Rigid Coupler 2"',                     'ea',   'Riser / Conduit'),
('PVC_COUPLER_2IN',   'PVC Coupler 2"',                       'ea',   'Riser / Conduit'),
-- Fiber Cables
('FIBER_SM_288',      'Fiber Cable Singlemode 288ct',         'ft',   'Fiber Cables'),
('FIBER_SM_144',      'Fiber Cable Singlemode 144ct',         'ft',   'Fiber Cables'),
('FIBER_SM_72',       'Fiber Cable Singlemode 72ct',          'ft',   'Fiber Cables'),
('FIBER_SM_12',       'Fiber Cable Singlemode 12ct',          'ft',   'Fiber Cables'),
-- Splice / Closures
('A4_CASE',           'A4 Case FOSC450-A4-2-24-1-A1V',        'ea',   'Splice'),
('A6_CASE',           'A6 Case',                              'ea',   'Splice'),
('A8_CASE',           'A8 Case',                              'ea',   'Splice'),
('A_TRAY',            'A Tray FOSC-ACC-A-TRAY-24',            'ea',   'Splice'),
('B6_CASE',           'B6 Case',                              'ea',   'Splice'),
('B8_CASE',           'B8 Case',                              'ea',   'Splice'),
('B_TRAY',            'B Tray',                               'ea',   'Splice'),
('C4_CASE',           'C4 Case',                              'ea',   'Splice'),
('C6_CASE',           'C6 Case FOSC450',                      'ea',   'Splice'),
('C8_CASE',           'C8 Case',                              'ea',   'Splice'),
('C12_CASE',          'C12 Case',                             'ea',   'Splice'),
('C_TRAY',            'C Tray CC-C-TRAY-FOSC-A24',            'ea',   'Splice'),
('D6_CASE',           'D6 Case FOSC450-D6-6-NT-0-D6V',        'ea',   'Splice'),
('D_TRAY',            'D Tray FOSC-ACC-D-TRAY-72-KIT',        'ea',   'Splice'),
('DROP_GEL_SEAL',     'Drop Gel Seal Kit',                    'ea',   'Splice'),
('PLC_1x2',           '1x2 Bare PLC Splitter',               'ea',   'Splice'),
('PLC_1x4',           '1x4 Bare PLC Splitter',               'ea',   'Splice'),
('PLC_1x8',           '1x8 Bare PLC Splitter',               'ea',   'Splice'),
-- Underground
('VAULT_LARGE',           'Vault Large 17x30x18',             'ea',   'Underground'),
('VAULT_SMALL',           'Vault Small 13x24x12',             'ea',   'Underground'),
('HANDHOLE_POLY',         'Handhole Polymer 13x24x12',        'ea',   'Underground'),
('HANDHOLE_PLASTIC',      'Handhole Plastic 14x19',           'ea',   'Underground'),
('CONDUIT_SDR11_1_1_4',   'SDR11 1-1/4" HDPE Conduit',       'ft',   'Underground'),
('CONDUIT_SDR11_2',       'SDR11 2" HDPE Conduit',            'ft',   'Underground'),
('TRACER_WIRE',           'Tracer Wire',                      'ft',   'Underground'),
('MULE_TAPE',             'Mule Tape',                        'ft',   'Underground'),
('COND_COUPLER_1_1_4',    'Conduit Coupler 1-1/4"',           'ea',   'Underground'),
('COND_COUPLER_2',        'Conduit Coupler 2"',               'ea',   'Underground'),
('COND_COUPLER_3_4',      'Conduit Coupler 3/4"',             'ea',   'Underground'),
-- MST / HST
('MST_6P_100',   'MST 6P 100ft',   'ea',  'MST / HST'),
('MST_6P_300',   'MST 6P 300ft',   'ea',  'MST / HST'),
('MST_6P_500',   'MST 6P 500ft',   'ea',  'MST / HST'),
('MST_6P_700',   'MST 6P 700ft',   'ea',  'MST / HST'),
('MST_6P_1000',  'MST 6P 1000ft',  'ea',  'MST / HST'),
('MST_2P_50',    'MST 2P 50ft',    'ea',  'MST / HST'),
('MST_2P_100',   'MST 2P 100ft',   'ea',  'MST / HST'),
('MST_2P_300',   'MST 2P 300ft',   'ea',  'MST / HST'),
('MST_2P_400',   'MST 2P 400ft',   'ea',  'MST / HST'),
('MST_2P_500',   'MST 2P 500ft',   'ea',  'MST / HST'),
('MST_2P_700',   'MST 2P 700ft',   'ea',  'MST / HST'),
('MST_2P_800',   'MST 2P 800ft',   'ea',  'MST / HST'),
('MST_2P_1000',  'MST 2P 1000ft',  'ea',  'MST / HST'),
('HST_6P_100',   'HST 6P 100ft',   'ea',  'MST / HST'),
('HST_6P_700',   'HST 6P 700ft',   'ea',  'MST / HST'),
('HST_2P_50',    'HST 2P 50ft',    'ea',  'MST / HST'),
('HST_2P_100',   'HST 2P 100ft',   'ea',  'MST / HST'),
('HST_2P_300',   'HST 2P 300ft',   'ea',  'MST / HST');

-- ============================================================
-- SEED DATA — ASSEMBLIES
-- ============================================================
INSERT INTO assemblies (id, label, crew_type) VALUES
('terminalPole',         'Terminal Pole — strand & hardware',         'aerial'),
('intermediatePole',     'Intermediate Pole — strand & hardware',     'aerial'),
('lashingIntermediate',  'Intermediate Lashing — fiber & hardware',   'aerial'),
('lashingTerminal',      'Terminal Pole Lashing — fiber & hardware',  'aerial'),
('downGuy',              'Down Guy Installation',                     'aerial'),
('caseSplice',           'Case Splice',                               'splice'),
('poleRiser',            'Pole Riser',                               'aerial'),
('snowshoe',             'Snowshoe',                                  'aerial');

INSERT INTO assembly_parts (assembly_id, part_id, default_qty) VALUES
-- Terminal Pole
('terminalPole',        'BOLT_TE_5_8x14',    1),
('terminalPole',        'NUT_SQUARE_5_8',    1),
('terminalPole',        'WASHER_SQUARE_2x2', 1),
('terminalPole',        'GRIP_DEADEND_1_4',  1),
-- Intermediate Pole
('intermediatePole',    'NUT_SQUARE_5_8',    2),
('intermediatePole',    'WASHER_SQUARE_2x2', 2),
('intermediatePole',    'BOLT_5_8x14',       1),
('intermediatePole',    'CLAMP_B_SUS_5_8',   1),
-- Intermediate Lashing
('lashingIntermediate', 'CLAMP_D_LASH',      2),
('lashingIntermediate', 'SPACER_LASH_1_2',   2),
('lashingIntermediate', 'STRAP_LASH_16',     2),
-- Terminal Lashing
('lashingTerminal',     'CLAMP_D_LASH',      2),
('lashingTerminal',     'SPACER_LASH_1_2',   2),
('lashingTerminal',     'STRAP_LASH_16',     3),
('lashingTerminal',     'GRIP_DEADEND_1_4',  1),
-- Down Guy
('downGuy',             'STRAND_EHS_1_4',    20),
('downGuy',             'GRIP_DEADEND_1_4',  4),
('downGuy',             'ANCHOR_ROD_3_4x66', 1),
('downGuy',             'GUY_INSULATOR',     1),
('downGuy',             'GUY_GUARD_96',      1),
('downGuy',             'HOOK_B_GUY_5_8',    1),
-- Case Splice
('caseSplice',          'C6_CASE',           1),
('caseSplice',          'C_TRAY',            4),
-- Pole Riser
('poleRiser',           'RIGID_COND_2x10',   2),
('poleRiser',           'STRUT_CLAMP_2IN',   2),
('poleRiser',           'STANDOFF_V_6',      2),
-- Snowshoe
('snowshoe',            'STRAP_LASH_16',     5),
('snowshoe',            'SNOWSHOE_16',       1);

-- ============================================================
-- SEED DATA — PROJECTS, PHASES, TASKS
-- ============================================================
-- Projects
INSERT INTO projects (id, name, region, total_fiber_ft, total_conduit_ft, status) VALUES
('a1b2c3d4-0001-0001-0001-000000000001', 'West Mountain',  'West Mountain', 45000, 8200,  'active'),
('a1b2c3d4-0002-0002-0002-000000000002', 'Ogden Valley',   'Ogden Valley',  32000, 5400,  'active'),
('a1b2c3d4-0003-0003-0003-000000000003', 'Heber',          'Heber',         28000, 4100,  'active');

-- West Mountain Phases
INSERT INTO phases (id, project_id, name, sequence_order, fiber_ft, conduit_ft) VALUES
('b1000001-0001-0001-0001-000000000001', 'a1b2c3d4-0001-0001-0001-000000000001', 'Phase 1 — Main Trunk',     1, 18000, 3200),
('b1000002-0001-0001-0001-000000000001', 'a1b2c3d4-0001-0001-0001-000000000001', 'Phase 2 — Oak Ave Branch', 2, 14000, 2800),
('b1000003-0001-0001-0001-000000000001', 'a1b2c3d4-0001-0001-0001-000000000001', 'Phase 3 — Distribution',  3, 13000, 2200);

-- Ogden Valley Phases
INSERT INTO phases (id, project_id, name, sequence_order, fiber_ft, conduit_ft) VALUES
('b2000001-0002-0002-0002-000000000002', 'a1b2c3d4-0002-0002-0002-000000000002', 'Phase 1 — Valley Road', 1, 20000, 3000),
('b2000002-0002-0002-0002-000000000002', 'a1b2c3d4-0002-0002-0002-000000000002', 'Phase 2 — Side Roads',  2, 12000, 2400);

-- Heber Phases
INSERT INTO phases (id, project_id, name, sequence_order, fiber_ft, conduit_ft) VALUES
('b3000001-0003-0003-0003-000000000003', 'a1b2c3d4-0003-0003-0003-000000000003', 'Phase 1 — Main St', 1, 15000, 2200);

-- West Mountain Tasks
INSERT INTO tasks (phase_id, name, task_type, status, scope_notes, assigned_crew_type) VALUES
('b1000001-0001-0001-0001-000000000001', 'Elm St — Intermediate Poles 1–45',    'intermediatePole',    'active', '650ft span, 45 poles total',          'aerial'),
('b1000001-0001-0001-0001-000000000001', 'Elm St — Terminal Poles',             'terminalPole',        'open',   'Both ends of Elm St segment',          'aerial'),
('b1000001-0001-0001-0001-000000000001', 'Elm St — Down Guys Poles 8,17,31,40', 'downGuy',             'done',   'All 4 anchor locations complete',      'aerial'),
('b1000001-0001-0001-0001-000000000001', 'Elm St — Intermediate Lashing',       'lashingIntermediate', 'open',   'Follow strand after poles complete',   'aerial'),
('b1000002-0001-0001-0001-000000000001', 'Oak Ave — Intermediate Poles 1–30',   'intermediatePole',    'open',   '',                                     'aerial'),
('b1000002-0001-0001-0001-000000000001', 'Oak Ave — Terminal Poles',            'terminalPole',        'open',   '',                                     'aerial'),
('b1000002-0001-0001-0001-000000000001', 'Oak Ave — UG Crossing MH1–MH3',       'underground',         'open',   '180ft bore under Maple Ave',           'underground'),
('b1000003-0001-0001-0001-000000000001', 'Block A — Terminal Lashing',          'lashingTerminal',     'open',   '',                                     'aerial'),
('b1000003-0001-0001-0001-000000000001', 'Block B — Splicing',                  'caseSplice',          'open',   '6 splice points planned',              'splice');

-- Ogden Valley Tasks
INSERT INTO tasks (phase_id, name, task_type, status, scope_notes, assigned_crew_type) VALUES
('b2000001-0002-0002-0002-000000000002', 'Valley Rd — Strand Poles 1–60',   'intermediatePole',    'open', '',              'aerial'),
('b2000001-0002-0002-0002-000000000002', 'Valley Rd — Lashing',             'lashingIntermediate', 'open', '',              'aerial'),
('b2000001-0002-0002-0002-000000000002', 'Valley Rd — UG Segment A',        'underground',         'open', '320ft SDR11',   'underground'),
('b2000002-0002-0002-0002-000000000002', 'Canyon Rd — Poles & Strand',      'intermediatePole',    'open', '',              'aerial');

-- Heber Tasks
INSERT INTO tasks (phase_id, name, task_type, status, scope_notes, assigned_crew_type) VALUES
('b3000001-0003-0003-0003-000000000003', 'Main St — Intermediate Poles', 'intermediatePole', 'open', '', 'aerial'),
('b3000001-0003-0003-0003-000000000003', 'Main St — Terminal Lashing',   'lashingTerminal',  'open', '', 'aerial');

-- ============================================================
-- SEED DATA — USERS
-- ============================================================
INSERT INTO users (name, initials, role, crew_type, is_contractor, is_active) VALUES
-- Owner
('Site Owner',    'SO', 'owner',   null,          false, true),
-- Managers
('J. Rodriguez',  'JR', 'manager', null,          false, true),
('K. Thompson',   'KT', 'manager', null,          false, true),
('S. Patel',      'SP', 'manager', null,          false, true),
-- Aerial crew
('Marcus W.',     'MW', 'crew',    'aerial',      false, true),
('Tony G.',       'TG', 'crew',    'aerial',      false, true),
('Rico B.',       'RB', 'crew',    'aerial',      false, true),
('M. Johnson',    'MJ', 'crew',    'aerial',      false, true),
('R. Davis',      'RD', 'crew',    'aerial',      false, true),
-- Underground crew
('J. Salazar',    'JS', 'crew',    'underground', false, true),
('S. Kim',        'SK', 'crew',    'underground', false, true),
-- Splicers
('D. Park',       'DP', 'crew',    'splice',      false, true),
('L. Chen',       'LC', 'crew',    'splice',      false, true),
-- Drop crew
('T. Vasquez',    'TV', 'crew',    'drop',        false, true),
('J. Morales',    'JM', 'crew',    'drop',        false, true),
-- Locator
('K. Williams',   'KW', 'crew',    'locator',     false, true),
-- Contractors
('A. Reyes',      'AR', 'crew',    'aerial',      true,  true),
('B. Torres',     'BT', 'crew',    'aerial',      true,  true),
('C. Nguyen',     'CN', 'crew',    'underground', true,  true),
('P. Martinez',   'PM', 'crew',    'aerial',      true,  true);

-- ============================================================
-- Done! Check Tables section in Supabase to confirm.
-- ============================================================
