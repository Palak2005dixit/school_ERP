import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type {
  TransportDriver,
  TransportRoute,
  TransportVehicle,
} from '@erp/shared';
import { useAuth, useSchoolId } from '../auth/AuthContext';
import {
  allocateTransport,
  createDriver,
  createTransportMaintenance,
  createTransportRoute,
  createVehicle,
  endTransportAllocation,
  listFeeHeads,
  listStudents,
  listTransportAllocations,
  listTransportMaintenance,
  listTransportRoutes,
  listVehicles,
  listDrivers,
  updateTransportRoute,
  updateVehicle,
  updateDriver,
} from '../lib/endpoints';
import { errorMessage } from '../lib/api';
import { formatDate, formatMoney, todayIso } from '../lib/format';
import { Dialog } from '../components/Dialog';
import { Tabs } from '../components/Tabs';
import { useToast } from '../components/ToastProvider';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  PageHeader,
  Select,
  TableSkeleton,
  Textarea,
} from '../components/ui';

type Tab = 'vehicles' | 'drivers' | 'routes' | 'allocations' | 'maintenance';

const VEHICLE_STATUSES = ['active', 'maintenance', 'retired'] as const;
const DRIVER_STATUSES = ['active', 'inactive'] as const;
const MAINTENANCE_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;

type StopDraft = {
  name: string;
  sequenceNo: string;
  scheduledPickup: string;
  scheduledDrop: string;
  landmark: string;
};

type DialogState =
  | { kind: 'vehicle'; vehicle?: TransportVehicle }
  | { kind: 'driver'; driver?: TransportDriver }
  | { kind: 'route'; route?: TransportRoute }
  | { kind: 'allocate' }
  | { kind: 'maintenance' }
  | null;

function instantOrNull(value: string): string | null {
  return value ? value : null;
}

export function TransportPage(): ReactNode {
  const schoolId = useSchoolId();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canView = can('transport.view');
  const canManage = can('transport.manage');
  const canAllocate = can('transport.allocate');

  const [tab, setTab] = useState<Tab>('vehicles');
  const [allocationFilter, setAllocationFilter] = useState<'active' | 'all'>('active');
  const [routeFilter, setRouteFilter] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [formError, setFormError] = useState('');

  const vehicles = useQuery({
    queryKey: ['transport-vehicles', schoolId],
    queryFn: () => listVehicles(schoolId),
    enabled: canView,
  });
  const drivers = useQuery({
    queryKey: ['transport-drivers', schoolId],
    queryFn: () => listDrivers(schoolId),
    enabled: canView,
  });
  const routes = useQuery({
    queryKey: ['transport-routes', schoolId],
    queryFn: () => listTransportRoutes(schoolId),
    enabled: canView,
  });
  const allocations = useQuery({
    queryKey: ['transport-allocations', schoolId, allocationFilter, routeFilter],
    queryFn: () =>
      listTransportAllocations(schoolId, {
        activeOnly: allocationFilter === 'active',
        routeId: routeFilter || undefined,
      }),
    enabled: canView && tab === 'allocations',
  });
  const maintenance = useQuery({
    queryKey: ['transport-maintenance', schoolId],
    queryFn: () => listTransportMaintenance(schoolId),
    enabled: canView && tab === 'maintenance',
  });
  const students = useQuery({
    queryKey: ['students', schoolId, 'transport-picker'],
    queryFn: () => listStudents(schoolId, { pageSize: 200 }),
    enabled: canAllocate && tab === 'allocations',
  });
  const feeHeads = useQuery({
    queryKey: ['fee-heads', schoolId],
    queryFn: () => listFeeHeads(schoolId),
    enabled: canManage && dialog?.kind === 'route',
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['transport-vehicles', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['transport-drivers', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['transport-routes', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['transport-allocations', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['transport-maintenance', schoolId] });
  };

  function action<TInput, TResult>(fn: (input: TInput) => Promise<TResult>, message: string) {
    return useMutation({
      mutationFn: fn,
      onSuccess: () => {
        toast.notify('success', message);
        setDialog(null);
        invalidate();
      },
      onError: (error) => setFormError(errorMessage(error)),
    });
  }

  const saveVehicle = action(
    (input: { id?: string; body: Parameters<typeof createVehicle>[1] }) =>
      input.id
        ? updateVehicle(schoolId, input.id, input.body)
        : createVehicle(schoolId, input.body),
    'Vehicle saved.',
  );
  const saveDriver = action(
    (input: { id?: string; body: Parameters<typeof createDriver>[1] }) =>
      input.id
        ? updateDriver(schoolId, input.id, input.body)
        : createDriver(schoolId, input.body),
    'Driver saved.',
  );
  const saveRoute = action(
    (input: { id?: string; body: Parameters<typeof createTransportRoute>[1] }) =>
      input.id
        ? updateTransportRoute(schoolId, input.id, input.body)
        : createTransportRoute(schoolId, input.body),
    'Route saved.',
  );
  const allocate = action(
    (body: Parameters<typeof allocateTransport>[1]) => allocateTransport(schoolId, body),
    'Student allocated to transport.',
  );
  const endAllocation = action(
    (id: string) => endTransportAllocation(schoolId, id, { effectiveTo: todayIso() }),
    'Transport allocation ended.',
  );
  const saveMaintenance = action(
    (body: Parameters<typeof createTransportMaintenance>[1]) =>
      createTransportMaintenance(schoolId, body),
    'Maintenance recorded.',
  );

  const vehicleOptions = vehicles.data?.items ?? [];
  const driverOptions = drivers.data?.items ?? [];
  const routeOptions = routes.data?.items ?? [];
  const allocationOptions = allocations.data?.items ?? [];
  const studentOptions = students.data?.items ?? [];

  const tabs: Array<{ value: Tab; label: string }> = [
    { value: 'vehicles', label: 'Vehicles' },
    { value: 'drivers', label: 'Drivers' },
    { value: 'routes', label: 'Routes & stops' },
    { value: 'allocations', label: 'Allocations' },
    { value: 'maintenance', label: 'Maintenance' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transport & fleet"
        description="Vehicles, drivers, routes and student allocations. Capacity is enforced against active allocations; route stops cannot be replaced while students are allocated."
        actions={
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <>
                <Button variant="secondary" onClick={() => setDialog({ kind: 'vehicle' })}>
                  <Icon name="plus" className="h-4 w-4" />
                  Vehicle
                </Button>
                <Button variant="secondary" onClick={() => setDialog({ kind: 'route' })}>
                  Route
                </Button>
              </>
            )}
            {canAllocate && (
              <Button onClick={() => setDialog({ kind: 'allocate' })}>
                <Icon name="users" className="h-4 w-4" />
                Allocate student
              </Button>
            )}
          </div>
        }
      />

      <Tabs value={tab} onChange={setTab} tabs={tabs} label="Transport views" />

      {tab === 'vehicles' && canView && (
        <Card>
          <CardHeader
            title="Vehicles"
            description="Capacity is the maximum number of allocated students. Reducing capacity below the active allocation count is blocked."
            actions={
              canManage ? (
                <Button size="sm" onClick={() => setDialog({ kind: 'vehicle' })}>
                  New vehicle
                </Button>
              ) : undefined
            }
          />
          {vehicles.isPending ? (
            <TableSkeleton rows={4} columns={6} />
          ) : vehicles.isError ? (
            <ErrorState message={errorMessage(vehicles.error)} onRetry={() => void vehicles.refetch()} />
          ) : vehicleOptions.length === 0 ? (
            <EmptyState title="No vehicles" description="Add a bus or van to the fleet." icon="users" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Registration</th>
                    <th>Model</th>
                    <th className="text-right">Capacity</th>
                    <th>Insurance expires</th>
                    <th>Status</th>
                    <th className="text-right">Routes</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {vehicleOptions.map((row) => (
                    <tr key={row.id}>
                      <td className="font-mono text-xs">{row.registrationNumber}</td>
                      <td className="font-medium text-slate-900">{row.model ?? '—'}</td>
                      <td className="text-right tabular-nums">{row.capacity}</td>
                      <td>{formatDate(row.insuranceExpiresOn)}</td>
                      <td>
                        <Badge tone={row.status === 'active' ? 'success' : row.status === 'retired' ? 'neutral' : 'warning'}>
                          {row.status}
                        </Badge>
                      </td>
                      <td className="text-right tabular-nums">{row.assignedRouteCount}</td>
                      <td className="text-right">
                        {canManage && (
                          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'vehicle', vehicle: row })}>
                            Edit
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'drivers' && canView && (
        <Card>
          <CardHeader
            title="Drivers"
            description="Link a driver to a staff record when they are an employee."
            actions={
              canManage ? (
                <Button size="sm" onClick={() => setDialog({ kind: 'driver' })}>
                  New driver
                </Button>
              ) : undefined
            }
          />
          {drivers.isPending ? (
            <TableSkeleton rows={4} columns={5} />
          ) : drivers.isError ? (
            <ErrorState message={errorMessage(drivers.error)} onRetry={() => void drivers.refetch()} />
          ) : driverOptions.length === 0 ? (
            <EmptyState title="No drivers" description="Add a driver before assigning a route." icon="user" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Phone</th>
                    <th>Licence</th>
                    <th>Expires</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {driverOptions.map((row) => (
                    <tr key={row.id}>
                      <td className="font-medium text-slate-900">{row.fullName}</td>
                      <td className="text-sm text-slate-600">{row.phone ?? '—'}</td>
                      <td className="font-mono text-xs">{row.licenceNumber ?? '—'}</td>
                      <td>{formatDate(row.licenceExpiresOn)}</td>
                      <td>
                        <Badge tone={row.status === 'active' ? 'success' : 'neutral'}>{row.status}</Badge>
                      </td>
                      <td className="text-right">
                        {canManage && (
                          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'driver', driver: row })}>
                            Edit
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'routes' && canView && (
        <Card>
          <CardHeader
            title="Routes & stops"
            description="Stops are ordered by sequence. A route with active allocations keeps its stop list frozen."
            actions={
              canManage ? (
                <Button size="sm" onClick={() => setDialog({ kind: 'route' })}>
                  New route
                </Button>
              ) : undefined
            }
          />
          {routes.isPending ? (
            <TableSkeleton rows={4} columns={5} />
          ) : routes.isError ? (
            <ErrorState message={errorMessage(routes.error)} onRetry={() => void routes.refetch()} />
          ) : routeOptions.length === 0 ? (
            <EmptyState title="No routes" description="Create a route with its stops." icon="calendar" />
          ) : (
            <div className="space-y-3 p-4">
              {routeOptions.map((row) => (
                <div key={row.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-slate-900">
                        {row.name} <span className="font-mono text-xs text-slate-500">{row.code}</span>
                      </p>
                      <p className="text-xs text-slate-500">
                        {row.vehicleRegistration ?? 'No vehicle'} · {row.driverName ?? 'No driver'} ·{' '}
                        {row.allocatedStudents}
                        {row.capacity ? `/${row.capacity}` : ''} students
                        {row.feeAmount !== null && ` · ${formatMoney(row.feeAmount)}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={row.status === 'active' ? 'success' : 'neutral'}>{row.status}</Badge>
                      {canManage && (
                        <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'route', route: row })}>
                          Edit
                        </Button>
                      )}
                    </div>
                  </div>
                  {row.stops.length > 0 && (
                    <ol className="mt-2 grid gap-1 text-sm text-slate-600 sm:grid-cols-2">
                      {row.stops.map((stop) => (
                        <li key={stop.id}>
                          <span className="font-mono text-xs text-slate-400">{stop.sequenceNo}.</span>{' '}
                          {stop.name}
                          {stop.scheduledPickup && ` · pick ${stop.scheduledPickup}`}
                          {stop.scheduledDrop && ` · drop ${stop.scheduledDrop}`}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'allocations' && canView && (
        <Card>
          <CardHeader
            title="Student allocations"
            description="Ending an allocation keeps the history. Capacity is checked against active allocations only."
            actions={
              <div className="flex flex-wrap gap-2">
                <Select
                  aria-label="Allocation status"
                  value={allocationFilter}
                  onChange={(event) => setAllocationFilter(event.target.value as 'active' | 'all')}
                  className="w-36"
                >
                  <option value="active">Active only</option>
                  <option value="all">All</option>
                </Select>
                <Select
                  aria-label="Filter by route"
                  value={routeFilter}
                  onChange={(event) => setRouteFilter(event.target.value)}
                  className="w-44"
                >
                  <option value="">All routes</option>
                  {routeOptions.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </Select>
                {canAllocate && (
                  <Button size="sm" onClick={() => setDialog({ kind: 'allocate' })}>
                    Allocate
                  </Button>
                )}
              </div>
            }
          />
          {allocations.isPending ? (
            <TableSkeleton rows={5} columns={6} />
          ) : allocations.isError ? (
            <ErrorState message={errorMessage(allocations.error)} onRetry={() => void allocations.refetch()} />
          ) : allocationOptions.length === 0 ? (
            <EmptyState title="No allocations" description="Allocate a student to a route and stop." icon="users" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Route</th>
                    <th>Stop</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {allocationOptions.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <p className="font-medium text-slate-900">{row.studentName}</p>
                        <p className="font-mono text-xs text-slate-500">{row.admissionNumber}</p>
                      </td>
                      <td>{row.routeName}</td>
                      <td>{row.stopName}</td>
                      <td>{formatDate(row.effectiveFrom)}</td>
                      <td>{formatDate(row.effectiveTo)}</td>
                      <td>
                        <Badge tone={row.status === 'active' ? 'success' : 'neutral'}>{row.status}</Badge>
                      </td>
                      <td className="text-right">
                        {canAllocate && row.status === 'active' && (
                          <Button size="sm" variant="ghost" onClick={() => endAllocation.mutate(row.id)}>
                            End
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'maintenance' && canView && (
        <Card>
          <CardHeader
            title="Maintenance"
            description="Scheduled and completed maintenance by vehicle."
            actions={
              canManage ? (
                <Button size="sm" onClick={() => setDialog({ kind: 'maintenance' })}>
                  Record maintenance
                </Button>
              ) : undefined
            }
          />
          {maintenance.isPending ? (
            <TableSkeleton rows={4} columns={5} />
          ) : maintenance.isError ? (
            <ErrorState message={errorMessage(maintenance.error)} onRetry={() => void maintenance.refetch()} />
          ) : (maintenance.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="No maintenance records" description="Record scheduled or completed maintenance." icon="clipboard" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vehicle</th>
                    <th>Description</th>
                    <th>Performed</th>
                    <th className="text-right">Cost</th>
                    <th>Vendor</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {maintenance.data!.items.map((row) => (
                    <tr key={row.id}>
                      <td className="font-mono text-xs">{row.vehicleRegistration}</td>
                      <td>{row.description}</td>
                      <td>{formatDate(row.performedOn)}</td>
                      <td className="text-right tabular-nums">{formatMoney(row.cost)}</td>
                      <td className="text-sm text-slate-600">{row.vendorName ?? '—'}</td>
                      <td>
                        <Badge tone={row.status === 'completed' ? 'success' : row.status === 'cancelled' ? 'neutral' : 'warning'}>
                          {row.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {dialog?.kind === 'vehicle' && (
        <VehicleDialog
          key={dialog.vehicle?.id ?? 'new-vehicle'}
          vehicle={dialog.vehicle}
          error={formError}
          saving={saveVehicle.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveVehicle.mutate({ id: dialog.vehicle?.id, body })}
        />
      )}

      {dialog?.kind === 'driver' && (
        <DriverDialog
          key={dialog.driver?.id ?? 'new-driver'}
          driver={dialog.driver}
          error={formError}
          saving={saveDriver.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveDriver.mutate({ id: dialog.driver?.id, body })}
        />
      )}

      {dialog?.kind === 'route' && (
        <RouteDialog
          key={dialog.route?.id ?? 'new-route'}
          route={dialog.route}
          vehicles={vehicleOptions}
          drivers={driverOptions}
          feeHeads={feeHeads.data?.items ?? []}
          error={formError}
          saving={saveRoute.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveRoute.mutate({ id: dialog.route?.id, body })}
        />
      )}

      {dialog?.kind === 'allocate' && (
        <AllocationDialog
          students={studentOptions}
          routes={routeOptions}
          error={formError}
          saving={allocate.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => allocate.mutate(body)}
        />
      )}

      {dialog?.kind === 'maintenance' && (
        <MaintenanceDialog
          vehicles={vehicleOptions}
          error={formError}
          saving={saveMaintenance.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveMaintenance.mutate(body)}
        />
      )}
    </div>
  );
}

function VehicleDialog({
  vehicle,
  error,
  saving,
  onClose,
  onSave,
}: {
  vehicle?: TransportVehicle;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof createVehicle>[1]) => void;
}): ReactNode {
  const [registrationNumber, setRegistrationNumber] = useState(vehicle?.registrationNumber ?? '');
  const [model, setModel] = useState(vehicle?.model ?? '');
  const [capacity, setCapacity] = useState(String(vehicle?.capacity ?? 30));
  const [status, setStatus] = useState<(typeof VEHICLE_STATUSES)[number]>(vehicle?.status ?? 'active');
  const [insuranceExpiresOn, setInsuranceExpiresOn] = useState(vehicle?.insuranceExpiresOn ?? '');
  const [notes, setNotes] = useState(vehicle?.notes ?? '');

  return (
    <Dialog
      open
      onClose={onClose}
      title={vehicle ? 'Edit vehicle' : 'New vehicle'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="vehicle-form" loading={saving}>
            Save vehicle
          </Button>
        </>
      }
    >
      <form
        id="vehicle-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            registrationNumber,
            model: model || undefined,
            capacity: Number(capacity),
            status,
            insuranceExpiresOn: instantOrNull(insuranceExpiresOn),
            notes: notes || undefined,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Registration number" htmlFor="veh-reg" required>
            <Input id="veh-reg" value={registrationNumber} onChange={(event) => setRegistrationNumber(event.target.value)} required />
          </Field>
          <Field label="Model" htmlFor="veh-model">
            <Input id="veh-model" value={model} onChange={(event) => setModel(event.target.value)} />
          </Field>
          <Field label="Capacity" htmlFor="veh-capacity" required>
            <Input id="veh-capacity" type="number" min={1} max={200} value={capacity} onChange={(event) => setCapacity(event.target.value)} required />
          </Field>
          <Field label="Status" htmlFor="veh-status">
            <Select id="veh-status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
              {VEHICLE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Insurance expires" htmlFor="veh-insurance">
            <Input id="veh-insurance" type="date" value={insuranceExpiresOn} onChange={(event) => setInsuranceExpiresOn(event.target.value)} />
          </Field>
        </div>
        <Field label="Notes" htmlFor="veh-notes">
          <Textarea id="veh-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} />
        </Field>
      </form>
    </Dialog>
  );
}

function DriverDialog({
  driver,
  error,
  saving,
  onClose,
  onSave,
}: {
  driver?: TransportDriver;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof createDriver>[1]) => void;
}): ReactNode {
  const [fullName, setFullName] = useState(driver?.fullName ?? '');
  const [phone, setPhone] = useState(driver?.phone ?? '');
  const [licenceNumber, setLicenceNumber] = useState(driver?.licenceNumber ?? '');
  const [licenceExpiresOn, setLicenceExpiresOn] = useState(driver?.licenceExpiresOn ?? '');
  const [status, setStatus] = useState<(typeof DRIVER_STATUSES)[number]>(driver?.status ?? 'active');

  return (
    <Dialog
      open
      onClose={onClose}
      title={driver ? 'Edit driver' : 'New driver'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="driver-form" loading={saving}>
            Save driver
          </Button>
        </>
      }
    >
      <form
        id="driver-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            fullName,
            phone: phone || undefined,
            licenceNumber: licenceNumber || undefined,
            licenceExpiresOn: instantOrNull(licenceExpiresOn),
            status,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" htmlFor="drv-name" required>
            <Input id="drv-name" value={fullName} onChange={(event) => setFullName(event.target.value)} required />
          </Field>
          <Field label="Phone" htmlFor="drv-phone">
            <Input id="drv-phone" value={phone} onChange={(event) => setPhone(event.target.value)} />
          </Field>
          <Field label="Licence number" htmlFor="drv-licence">
            <Input id="drv-licence" value={licenceNumber} onChange={(event) => setLicenceNumber(event.target.value)} />
          </Field>
          <Field label="Licence expires" htmlFor="drv-expiry">
            <Input id="drv-expiry" type="date" value={licenceExpiresOn} onChange={(event) => setLicenceExpiresOn(event.target.value)} />
          </Field>
          <Field label="Status" htmlFor="drv-status">
            <Select id="drv-status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
              {DRIVER_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </form>
    </Dialog>
  );
}

function RouteDialog({
  route,
  vehicles,
  drivers,
  feeHeads,
  error,
  saving,
  onClose,
  onSave,
}: {
  route?: TransportRoute;
  vehicles: TransportVehicle[];
  drivers: TransportDriver[];
  feeHeads: Array<{ id: string; name: string }>;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof createTransportRoute>[1]) => void;
}): ReactNode {
  const [code, setCode] = useState(route?.code ?? '');
  const [name, setName] = useState(route?.name ?? '');
  const [vehicleId, setVehicleId] = useState(route?.vehicleId ?? '');
  const [driverId, setDriverId] = useState(route?.driverId ?? '');
  const [attendantName, setAttendantName] = useState(route?.attendantName ?? '');
  const [feeHeadId, setFeeHeadId] = useState(route?.feeHeadId ?? '');
  const [feeAmount, setFeeAmount] = useState(route?.feeAmount !== null && route?.feeAmount !== undefined ? String(route.feeAmount) : '');
  const [status, setStatus] = useState<'active' | 'inactive'>(route?.status ?? 'active');
  const [notes, setNotes] = useState(route?.notes ?? '');
  const [stops, setStops] = useState<StopDraft[]>(
    route?.stops.map((stop) => ({
      name: stop.name,
      sequenceNo: String(stop.sequenceNo),
      scheduledPickup: stop.scheduledPickup ?? '',
      scheduledDrop: stop.scheduledDrop ?? '',
      landmark: stop.landmark ?? '',
    })) ?? [],
  );

  const stopsLocked = (route?.allocatedStudents ?? 0) > 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title={route ? 'Edit route' : 'New route'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="route-form" loading={saving}>
            Save route
          </Button>
        </>
      }
    >
      <form
        id="route-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            code,
            name,
            vehicleId: vehicleId || null,
            driverId: driverId || null,
            attendantName: attendantName || undefined,
            feeHeadId: feeHeadId || null,
            feeAmount: feeAmount ? Number(feeAmount) : null,
            status,
            notes: notes || undefined,
            stops: stops.map((stop, index) => ({
              name: stop.name,
              sequenceNo: Number(stop.sequenceNo || index + 1),
              scheduledPickup: stop.scheduledPickup || null,
              scheduledDrop: stop.scheduledDrop || null,
              landmark: stop.landmark || undefined,
            })),
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        {stopsLocked && (
          <Alert tone="warning">
            This route has active allocations. The stop list is frozen; end the allocations first to
            change stops.
          </Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" htmlFor="rt-code" required hint="Lowercase letters, numbers, _ or -.">
            <Input id="rt-code" value={code} onChange={(event) => setCode(event.target.value)} pattern="[a-z0-9_-]+" required />
          </Field>
          <Field label="Name" htmlFor="rt-name" required>
            <Input id="rt-name" value={name} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Field label="Vehicle" htmlFor="rt-vehicle">
            <Select id="rt-vehicle" value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}>
              <option value="">No vehicle</option>
              {vehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.registrationNumber} ({vehicle.capacity} seats)
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Driver" htmlFor="rt-driver">
            <Select id="rt-driver" value={driverId} onChange={(event) => setDriverId(event.target.value)}>
              <option value="">No driver</option>
              {drivers.map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.fullName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Attendant" htmlFor="rt-attendant">
            <Input id="rt-attendant" value={attendantName} onChange={(event) => setAttendantName(event.target.value)} />
          </Field>
          <Field label="Status" htmlFor="rt-status">
            <Select id="rt-status" value={status} onChange={(event) => setStatus(event.target.value as 'active' | 'inactive')}>
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </Select>
          </Field>
          <Field label="Fee head" htmlFor="rt-fee-head">
            <Select id="rt-fee-head" value={feeHeadId} onChange={(event) => setFeeHeadId(event.target.value)}>
              <option value="">No transport fee</option>
              {feeHeads.map((head) => (
                <option key={head.id} value={head.id}>
                  {head.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fee amount" htmlFor="rt-fee-amount">
            <Input id="rt-fee-amount" type="number" min={0} step="0.01" value={feeAmount} onChange={(event) => setFeeAmount(event.target.value)} />
          </Field>
        </div>
        <Field label="Notes" htmlFor="rt-notes">
          <Textarea id="rt-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} />
        </Field>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-slate-800">Stops</p>
            {!stopsLocked && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() =>
                  setStops((current) => [
                    ...current,
                    {
                      name: '',
                      sequenceNo: String(current.length + 1),
                      scheduledPickup: '',
                      scheduledDrop: '',
                      landmark: '',
                    },
                  ])
                }
              >
                Add stop
              </Button>
            )}
          </div>
          {stops.length === 0 ? (
            <p className="text-sm text-slate-500">No stops yet.</p>
          ) : (
            <div className="space-y-2">
              {stops.map((stop, index) => (
                <div key={index} className="grid gap-2 rounded-lg border border-slate-200 p-2 sm:grid-cols-6">
                  <Input
                    aria-label={`Stop ${index + 1} name`}
                    placeholder="Stop name"
                    value={stop.name}
                    onChange={(event) => {
                      const next = [...stops];
                      next[index] = { ...stop, name: event.target.value };
                      setStops(next);
                    }}
                    disabled={stopsLocked}
                    required
                  />
                  <Input
                    aria-label={`Stop ${index + 1} sequence`}
                    type="number"
                    min={1}
                    max={100}
                    value={stop.sequenceNo}
                    onChange={(event) => {
                      const next = [...stops];
                      next[index] = { ...stop, sequenceNo: event.target.value };
                      setStops(next);
                    }}
                    disabled={stopsLocked}
                  />
                  <Input
                    aria-label={`Stop ${index + 1} pickup time`}
                    type="time"
                    value={stop.scheduledPickup}
                    onChange={(event) => {
                      const next = [...stops];
                      next[index] = { ...stop, scheduledPickup: event.target.value };
                      setStops(next);
                    }}
                    disabled={stopsLocked}
                  />
                  <Input
                    aria-label={`Stop ${index + 1} drop time`}
                    type="time"
                    value={stop.scheduledDrop}
                    onChange={(event) => {
                      const next = [...stops];
                      next[index] = { ...stop, scheduledDrop: event.target.value };
                      setStops(next);
                    }}
                    disabled={stopsLocked}
                  />
                  <Input
                    aria-label={`Stop ${index + 1} landmark`}
                    placeholder="Landmark"
                    value={stop.landmark}
                    onChange={(event) => {
                      const next = [...stops];
                      next[index] = { ...stop, landmark: event.target.value };
                      setStops(next);
                    }}
                    disabled={stopsLocked}
                  />
                  {!stopsLocked && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setStops(stops.filter((_, position) => position !== index))}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </form>
    </Dialog>
  );
}

function AllocationDialog({
  students,
  routes,
  error,
  saving,
  onClose,
  onSave,
}: {
  students: Array<{ id: string; admissionNumber: string; firstName: string; lastName: string | null }>;
  routes: TransportRoute[];
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof allocateTransport>[1]) => void;
}): ReactNode {
  const [studentId, setStudentId] = useState('');
  const [routeId, setRouteId] = useState('');
  const [stopId, setStopId] = useState('');
  const selectedRoute = routes.find((row) => row.id === routeId);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Allocate student to transport"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="allocation-form" loading={saving}>
            Allocate
          </Button>
        </>
      }
    >
      <form
        id="allocation-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ studentId, routeId, stopId });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Student" htmlFor="all-student" required>
          <Select id="all-student" value={studentId} onChange={(event) => setStudentId(event.target.value)} required>
            <option value="">Select student</option>
            {students.map((student) => (
              <option key={student.id} value={student.id}>
                {student.firstName} {student.lastName ?? ''} · {student.admissionNumber}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Route" htmlFor="all-route" required>
          <Select
            id="all-route"
            value={routeId}
            onChange={(event) => {
              setRouteId(event.target.value);
              setStopId('');
            }}
            required
          >
            <option value="">Select route</option>
            {routes.map((route) => (
              <option key={route.id} value={route.id}>
                {route.name} ({route.allocatedStudents}
                {route.capacity ? `/${route.capacity}` : ''})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Stop" htmlFor="all-stop" required>
          <Select id="all-stop" value={stopId} onChange={(event) => setStopId(event.target.value)} required disabled={!selectedRoute}>
            <option value="">Select stop</option>
            {(selectedRoute?.stops ?? []).map((stop) => (
              <option key={stop.id} value={stop.id}>
                {stop.sequenceNo}. {stop.name}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}

function MaintenanceDialog({
  vehicles,
  error,
  saving,
  onClose,
  onSave,
}: {
  vehicles: TransportVehicle[];
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof createTransportMaintenance>[1]) => void;
}): ReactNode {
  const [vehicleId, setVehicleId] = useState('');
  const [performedOn, setPerformedOn] = useState(todayIso());
  const [description, setDescription] = useState('');
  const [cost, setCost] = useState('0');
  const [status, setStatus] = useState<(typeof MAINTENANCE_STATUSES)[number]>('completed');
  const [vendorName, setVendorName] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title="Record maintenance"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="maintenance-form" loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="maintenance-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            vehicleId,
            performedOn,
            description,
            cost: Number(cost),
            status,
            vendorName: vendorName || undefined,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Vehicle" htmlFor="mnt-vehicle" required>
            <Select id="mnt-vehicle" value={vehicleId} onChange={(event) => setVehicleId(event.target.value)} required>
              <option value="">Select vehicle</option>
              {vehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.registrationNumber}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Performed on" htmlFor="mnt-date" required>
            <Input id="mnt-date" type="date" value={performedOn} onChange={(event) => setPerformedOn(event.target.value)} required />
          </Field>
          <Field label="Status" htmlFor="mnt-status">
            <Select id="mnt-status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
              {MAINTENANCE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Cost" htmlFor="mnt-cost">
            <Input id="mnt-cost" type="number" min={0} step="0.01" value={cost} onChange={(event) => setCost(event.target.value)} />
          </Field>
          <Field label="Vendor" htmlFor="mnt-vendor">
            <Input id="mnt-vendor" value={vendorName} onChange={(event) => setVendorName(event.target.value)} />
          </Field>
        </div>
        <Field label="Description" htmlFor="mnt-desc" required>
          <Textarea id="mnt-desc" value={description} onChange={(event) => setDescription(event.target.value)} required />
        </Field>
      </form>
    </Dialog>
  );
}
