-- 0022 Transport and fleet management.
--
-- Routes carry an optional link to an existing fee head so transport charges use
-- the fee ledger instead of creating a parallel money table. Capacity is checked
-- inside the allocation transaction against the assigned vehicle. Driver licence
-- and vehicle insurance dates are recorded as supplied by the school; the system
-- does not invent compliance rules or external GPS data.

CREATE TABLE transport_vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  registration_number VARCHAR(40) NOT NULL,
  model VARCHAR(120),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 200),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'maintenance', 'retired')),
  insurance_expires_on DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_transport_vehicles_school_registration UNIQUE (school_id, registration_number),
  CONSTRAINT uq_transport_vehicles_school_id_id UNIQUE (school_id, id)
);

CREATE TRIGGER trg_transport_vehicles_updated_at BEFORE UPDATE ON transport_vehicles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE transport_drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  staff_id UUID,
  full_name VARCHAR(160) NOT NULL,
  phone VARCHAR(40),
  licence_number VARCHAR(80),
  licence_expires_on DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_transport_drivers_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_transport_drivers_staff
    FOREIGN KEY (school_id, staff_id) REFERENCES staff(school_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER trg_transport_drivers_updated_at BEFORE UPDATE ON transport_drivers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE transport_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  vehicle_id UUID,
  driver_id UUID,
  attendant_name VARCHAR(160),
  fee_head_id UUID,
  fee_amount NUMERIC(12, 2) CHECK (fee_amount IS NULL OR fee_amount >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_transport_routes_school_code UNIQUE (school_id, code),
  CONSTRAINT uq_transport_routes_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_transport_routes_vehicle
    FOREIGN KEY (school_id, vehicle_id) REFERENCES transport_vehicles(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_transport_routes_driver
    FOREIGN KEY (school_id, driver_id) REFERENCES transport_drivers(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_transport_routes_fee_head
    FOREIGN KEY (school_id, fee_head_id) REFERENCES fee_heads(school_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER trg_transport_routes_updated_at BEFORE UPDATE ON transport_routes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE transport_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  route_id UUID NOT NULL,
  name VARCHAR(160) NOT NULL,
  sequence_no INTEGER NOT NULL CHECK (sequence_no BETWEEN 1 AND 100),
  scheduled_pickup TIME,
  scheduled_drop TIME,
  landmark VARCHAR(200),
  CONSTRAINT uq_transport_stops_route_sequence UNIQUE (school_id, route_id, sequence_no),
  CONSTRAINT uq_transport_stops_school_route_id UNIQUE (school_id, route_id, id),
  CONSTRAINT uq_transport_stops_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_transport_stops_route
    FOREIGN KEY (school_id, route_id) REFERENCES transport_routes(school_id, id) ON DELETE CASCADE
);

CREATE TABLE student_transport_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  student_id UUID NOT NULL,
  route_id UUID NOT NULL,
  stop_id UUID NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'ended')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_student_transport_allocations_school_id_id UNIQUE (school_id, id),
  CONSTRAINT uq_student_transport_allocations_from UNIQUE (school_id, student_id, effective_from),
  CONSTRAINT fk_student_transport_allocations_student
    FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_student_transport_allocations_route
    FOREIGN KEY (school_id, route_id) REFERENCES transport_routes(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_student_transport_allocations_stop
    FOREIGN KEY (school_id, route_id, stop_id) REFERENCES transport_stops(school_id, route_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_student_transport_allocations_dates
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT chk_student_transport_allocations_status
    CHECK ((status = 'active') = (effective_to IS NULL))
);

CREATE UNIQUE INDEX uq_student_transport_allocations_current
  ON student_transport_allocations (school_id, student_id)
  WHERE effective_to IS NULL;

CREATE INDEX idx_student_transport_allocations_route
  ON student_transport_allocations (school_id, route_id, status);

CREATE TABLE transport_maintenance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  vehicle_id UUID NOT NULL,
  performed_on DATE NOT NULL,
  description VARCHAR(300) NOT NULL,
  cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'completed'
    CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  vendor_name VARCHAR(160),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_transport_maintenance_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_transport_maintenance_vehicle
    FOREIGN KEY (school_id, vehicle_id) REFERENCES transport_vehicles(school_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_transport_maintenance_vehicle
  ON transport_maintenance (school_id, vehicle_id, performed_on DESC);
