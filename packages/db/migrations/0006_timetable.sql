-- 0006 Timetable: periods, rooms and section slots.
--
-- A slot is one subject taught by one teacher in one room during one period on
-- one weekday. Section, teacher and room double-booking are prevented by unique
-- indexes, so conflicts cannot be committed even if two requests race.

CREATE TABLE timetable_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  academic_year_id UUID NOT NULL,
  name VARCHAR(60) NOT NULL,
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  starts_at TIME NOT NULL,
  ends_at TIME NOT NULL,
  is_break BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_timetable_periods_year_sequence UNIQUE (academic_year_id, sequence_no),
  CONSTRAINT uq_timetable_periods_school_id_id UNIQUE (school_id, id),
  CONSTRAINT uq_timetable_periods_school_year_id UNIQUE (school_id, academic_year_id, id),
  CONSTRAINT chk_timetable_periods_time CHECK (ends_at > starts_at),
  CONSTRAINT fk_timetable_periods_year
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years(school_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER trg_timetable_periods_updated_at BEFORE UPDATE ON timetable_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  capacity INTEGER CHECK (capacity IS NULL OR capacity >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_rooms_school_code UNIQUE (school_id, code),
  CONSTRAINT uq_rooms_school_id_id UNIQUE (school_id, id)
);
CREATE TRIGGER trg_rooms_updated_at BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE timetable_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  academic_year_id UUID NOT NULL,
  section_id UUID NOT NULL,
  period_id UUID NOT NULL,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  subject_id UUID NOT NULL,
  teacher_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  room_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_timetable_slots_section_cell UNIQUE (section_id, day_of_week, period_id),
  CONSTRAINT uq_timetable_slots_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_timetable_slots_year
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_timetable_slots_section
    FOREIGN KEY (school_id, academic_year_id, section_id)
    REFERENCES sections(school_id, academic_year_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_timetable_slots_period
    FOREIGN KEY (school_id, academic_year_id, period_id)
    REFERENCES timetable_periods(school_id, academic_year_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_timetable_slots_subject
    FOREIGN KEY (school_id, subject_id) REFERENCES subjects(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_timetable_slots_room
    FOREIGN KEY (school_id, room_id) REFERENCES rooms(school_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER trg_timetable_slots_updated_at BEFORE UPDATE ON timetable_slots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One teacher and one room cannot be in two places at the same time.
CREATE UNIQUE INDEX uq_timetable_slots_teacher
  ON timetable_slots (academic_year_id, day_of_week, period_id, teacher_user_id);
CREATE UNIQUE INDEX uq_timetable_slots_room
  ON timetable_slots (academic_year_id, day_of_week, period_id, room_id)
  WHERE room_id IS NOT NULL;
CREATE INDEX ix_timetable_slots_school_section
  ON timetable_slots (school_id, section_id, day_of_week, period_id);
CREATE INDEX ix_timetable_slots_teacher_lookup
  ON timetable_slots (school_id, teacher_user_id, academic_year_id);
