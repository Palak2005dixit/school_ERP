import type { Permission } from '@erp/shared';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { lazy, Suspense, type ReactNode } from 'react';
import { useAuth } from './auth/AuthContext';
import { AppShell, RequireAnyPermission, RequirePermission } from './components/AppShell';
import { Spinner } from './components/ui';

// Route-level code splitting keeps the first load small; each screen is fetched
// only when the user opens it.
const LoginPage = lazy(() => import('./pages/LoginPage').then((m) => ({ default: m.LoginPage })));
const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const AcademicYearsPage = lazy(() =>
  import('./pages/AcademicYearsPage').then((m) => ({ default: m.AcademicYearsPage })),
);
const ClassesPage = lazy(() =>
  import('./pages/ClassesPage').then((m) => ({ default: m.ClassesPage })),
);
const SectionsPage = lazy(() =>
  import('./pages/SectionsPage').then((m) => ({ default: m.SectionsPage })),
);
const SubjectsPage = lazy(() =>
  import('./pages/SubjectsPage').then((m) => ({ default: m.SubjectsPage })),
);
const StudentsPage = lazy(() =>
  import('./pages/StudentsPage').then((m) => ({ default: m.StudentsPage })),
);
const AdmissionPage = lazy(() =>
  import('./pages/AdmissionPage').then((m) => ({ default: m.AdmissionPage })),
);
const StudentDetailPage = lazy(() =>
  import('./pages/StudentDetailPage').then((m) => ({ default: m.StudentDetailPage })),
);
const AttendancePage = lazy(() =>
  import('./pages/AttendancePage').then((m) => ({ default: m.AttendancePage })),
);
const AuditPage = lazy(() => import('./pages/AuditPage').then((m) => ({ default: m.AuditPage })));
const PortalPage = lazy(() => import('./pages/PortalPage').then((m) => ({ default: m.PortalPage })));
const ProfilePage = lazy(() =>
  import('./pages/ProfilePage').then((m) => ({ default: m.ProfilePage })),
);
const TimetablePage = lazy(() =>
  import('./pages/TimetablePage').then((m) => ({ default: m.TimetablePage })),
);
const FeesPage = lazy(() => import('./pages/FeesPage').then((m) => ({ default: m.FeesPage })));
const ExamsPage = lazy(() => import('./pages/ExamsPage').then((m) => ({ default: m.ExamsPage })));
const StaffPage = lazy(() => import('./pages/StaffPage').then((m) => ({ default: m.StaffPage })));
const NoticesPage = lazy(() =>
  import('./pages/NoticesPage').then((m) => ({ default: m.NoticesPage })),
);
const ReportsPage = lazy(() =>
  import('./pages/ReportsPage').then((m) => ({ default: m.ReportsPage })),
);
const UsersPage = lazy(() => import('./pages/UsersPage').then((m) => ({ default: m.UsersPage })));
const SafeguardingPage = lazy(() =>
  import('./pages/SafeguardingPage').then((m) => ({ default: m.SafeguardingPage })),
);
const StaffAttendancePage = lazy(() =>
  import('./pages/StaffAttendancePage').then((m) => ({ default: m.StaffAttendancePage })),
);
const RecruitmentPage = lazy(() =>
  import('./pages/RecruitmentPage').then((m) => ({ default: m.RecruitmentPage })),
);
const ProcurementPage = lazy(() =>
  import('./pages/ProcurementPage').then((m) => ({ default: m.ProcurementPage })),
);
const TransportPage = lazy(() =>
  import('./pages/TransportPage').then((m) => ({ default: m.TransportPage })),
);
const LibraryPage = lazy(() =>
  import('./pages/LibraryPage').then((m) => ({ default: m.LibraryPage })),
);
const LearningPage = lazy(() =>
  import('./pages/LearningPage').then((m) => ({ default: m.LearningPage })),
);
const ConcernsPage = lazy(() =>
  import('./pages/ConcernsPage').then((m) => ({ default: m.ConcernsPage })),
);
const NotificationsPage = lazy(() =>
  import('./pages/NotificationsPage').then((m) => ({ default: m.NotificationsPage })),
);
const FeeControlsPage = lazy(() =>
  import('./pages/FeeControlsPage').then((m) => ({ default: m.FeeControlsPage })),
);
const DataToolsPage = lazy(() =>
  import('./pages/DataToolsPage').then((m) => ({ default: m.DataToolsPage })),
);
const NotFoundPage = lazy(() =>
  import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })),
);

export function App(): ReactNode {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedLayout />}>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route
              path="academic/years"
              element={
                <Guarded permission="academic.structure.view">
                  <AcademicYearsPage />
                </Guarded>
              }
            />
            <Route
              path="academic/classes"
              element={
                <Guarded permission="academic.structure.view">
                  <ClassesPage />
                </Guarded>
              }
            />
            <Route
              path="academic/sections"
              element={
                <Guarded permission="academic.structure.view">
                  <SectionsPage />
                </Guarded>
              }
            />
            <Route
              path="academic/subjects"
              element={
                <Guarded permission="academic.structure.view">
                  <SubjectsPage />
                </Guarded>
              }
            />
            <Route
              path="academic/timetable"
              element={
                <Guarded permission="academic.structure.view">
                  <TimetablePage />
                </Guarded>
              }
            />
            <Route
              path="students"
              element={
                <Guarded permission="students.profile.view">
                  <StudentsPage />
                </Guarded>
              }
            />
            <Route
              path="students/new"
              element={
                <Guarded permission="students.admission.create">
                  <AdmissionPage />
                </Guarded>
              }
            />
            <Route
              path="students/:id"
              element={
                <Guarded permission="students.profile.view">
                  <StudentDetailPage />
                </Guarded>
              }
            />
            <Route
              path="attendance"
              element={
                <Guarded permission="attendance.register.view">
                  <AttendancePage />
                </Guarded>
              }
            />
            <Route
              path="audit"
              element={
                <Guarded permission="audit.view">
                  <AuditPage />
                </Guarded>
              }
            />
            <Route
              path="portal"
              element={
                <Guarded permission="guardian.student.view">
                  <PortalPage />
                </Guarded>
              }
            />
            <Route
              path="fees"
              element={
                <Guarded permission="fees.view">
                  <FeesPage />
                </Guarded>
              }
            />
            <Route
              path="exams"
              element={
                <Guarded permission="exams.view">
                  <ExamsPage />
                </Guarded>
              }
            />
            <Route
              path="staff"
              element={
                <GuardAny
                  permissions={[
                    'hr.employee.view',
                    'hr.leave.request',
                    'hr.leave.approve',
                    'hr.leave.configure',
                    'hr.employee.salary.view_sensitive',
                  ]}
                >
                  <StaffPage />
                </GuardAny>
              }
            />
            <Route
              path="notices"
              element={
                <Guarded permission="notices.view">
                  <NoticesPage />
                </Guarded>
              }
            />
            <Route
              path="reports"
              element={
                <Guarded permission="reports.export">
                  <ReportsPage />
                </Guarded>
              }
            />
            <Route
              path="users"
              element={
                <Guarded permission="access.roles.manage">
                  <UsersPage />
                </Guarded>
              }
            />
            <Route
              path="safeguarding"
              element={
                <Guarded permission="safeguarding.case.view">
                  <SafeguardingPage />
                </Guarded>
              }
            />
            <Route
              path="staff/attendance"
              element={
                <GuardAny
                  permissions={[
                    'hr.attendance.view',
                    'hr.attendance.record',
                    'hr.attendance.approve',
                    'hr.attendance.configure',
                  ]}
                >
                  <StaffAttendancePage />
                </GuardAny>
              }
            />
            <Route
              path="hr/recruitment"
              element={
                <GuardAny
                  permissions={[
                    'hr.recruitment.view',
                    'hr.recruitment.manage',
                    'hr.onboarding.manage',
                    'hr.separation.manage',
                    'hr.employee.view',
                  ]}
                >
                  <RecruitmentPage />
                </GuardAny>
              }
            />
            <Route
              path="procurement"
              element={
                <GuardAny
                  permissions={[
                    'procurement.view',
                    'procurement.request',
                    'procurement.approve',
                    'procurement.vendor.manage',
                    'procurement.budget.manage',
                    'procurement.pay',
                  ]}
                >
                  <ProcurementPage />
                </GuardAny>
              }
            />
            <Route
              path="transport"
              element={
                <GuardAny
                  permissions={['transport.view', 'transport.manage', 'transport.allocate']}
                >
                  <TransportPage />
                </GuardAny>
              }
            />
            <Route
              path="library"
              element={
                <GuardAny
                  permissions={[
                    'library.view',
                    'library.manage',
                    'library.circulation.manage',
                    'library.settings.manage',
                  ]}
                >
                  <LibraryPage />
                </GuardAny>
              }
            />
            <Route
              path="learning"
              element={
                <GuardAny
                  permissions={[
                    'learning.view',
                    'learning.manage',
                    'learning.submit',
                    'learning.grade',
                  ]}
                >
                  <LearningPage />
                </GuardAny>
              }
            />
            <Route
              path="concerns"
              element={
                <GuardAny
                  permissions={[
                    'concerns.view',
                    'concerns.manage',
                    'concerns.assign',
                    'concerns.category.manage',
                  ]}
                >
                  <ConcernsPage />
                </GuardAny>
              }
            />
            <Route
              path="notifications"
              element={
                <GuardAny
                  permissions={[
                    'notifications.view',
                    'notifications.manage',
                    'notifications.send',
                  ]}
                >
                  <NotificationsPage />
                </GuardAny>
              }
            />
            <Route
              path="fees/controls"
              element={
                <Guarded permission="fees.view">
                  <FeeControlsPage />
                </Guarded>
              }
            />
            <Route
              path="data-tools"
              element={
                <GuardAny permissions={['reports.saved.manage', 'imports.manage']}>
                  <DataToolsPage />
                </GuardAny>
              }
            />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}

function RouteFallback(): ReactNode {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-3 text-slate-500">
        <Spinner className="h-6 w-6" />
        <p className="text-sm">Loading…</p>
      </div>
    </div>
  );
}

function ProtectedLayout(): ReactNode {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3 text-slate-500">
          <Spinner className="h-6 w-6" />
          <p className="text-sm">Checking your session…</p>
        </div>
      </div>
    );
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <Outlet />;
}

function Guarded({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}): ReactNode {
  return <RequirePermission permission={permission}>{children}</RequirePermission>;
}

function GuardAny({
  permissions,
  children,
}: {
  permissions: Permission[];
  children: ReactNode;
}): ReactNode {
  return <RequireAnyPermission permissions={permissions}>{children}</RequireAnyPermission>;
}
