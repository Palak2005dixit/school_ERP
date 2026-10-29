import type { Permission } from '@erp/shared';
import { useState, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { cn, Icon, type IconName } from './ui';
import { roleLabel } from '../lib/format';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  permission?: Permission;
  anyPermission?: Permission[];
  end?: boolean;
}

const NAV_SECTIONS: Array<{ heading: string; items: NavItem[] }> = [
  {
    heading: 'Workspace',
    items: [{ to: '/', label: 'Overview', icon: 'dashboard', end: true }],
  },
  {
    heading: 'Academic',
    items: [
      {
        to: '/academic/years',
        label: 'Academic years',
        icon: 'calendar',
        permission: 'academic.structure.view',
      },
      {
        to: '/academic/classes',
        label: 'Classes',
        icon: 'layers',
        permission: 'academic.structure.view',
      },
      {
        to: '/academic/sections',
        label: 'Sections',
        icon: 'users',
        permission: 'academic.structure.view',
      },
      {
        to: '/academic/subjects',
        label: 'Subjects',
        icon: 'book',
        permission: 'academic.structure.view',
      },
      {
        to: '/academic/timetable',
        label: 'Timetable',
        icon: 'calendar',
        permission: 'academic.structure.view',
      },
    ],
  },
  {
    heading: 'People',
    items: [
      {
        to: '/students',
        label: 'Students',
        icon: 'users',
        permission: 'students.profile.view',
      },
      {
        to: '/attendance',
        label: 'Attendance',
        icon: 'check',
        permission: 'attendance.register.view',
      },
      {
        to: '/students/new',
        label: 'New admission',
        icon: 'clipboard',
        permission: 'students.admission.create',
      },
      {
        to: '/staff',
        label: 'Staff & HR',
        icon: 'user',
        anyPermission: [
          'hr.employee.view',
          'hr.leave.request',
          'hr.leave.approve',
          'hr.leave.configure',
          'hr.employee.salary.view_sensitive',
        ],
      },
      {
        to: '/staff/attendance',
        label: 'Staff attendance',
        icon: 'check',
        anyPermission: [
          'hr.attendance.view',
          'hr.attendance.record',
          'hr.attendance.approve',
          'hr.attendance.configure',
        ],
      },
      {
        to: '/hr/recruitment',
        label: 'Recruitment',
        icon: 'clipboard',
        anyPermission: [
          'hr.recruitment.view',
          'hr.recruitment.manage',
          'hr.onboarding.manage',
          'hr.separation.manage',
          'hr.employee.view',
        ],
      },
      {
        to: '/portal',
        label: 'My children',
        icon: 'child',
        permission: 'guardian.student.view',
      },
    ],
  },
  {
    heading: 'Academics & communication',
    items: [
      {
        to: '/exams',
        label: 'Exams & results',
        icon: 'chart',
        permission: 'exams.view',
      },
      {
        to: '/notices',
        label: 'Notices',
        icon: 'book',
        permission: 'notices.view',
      },
      {
        to: '/learning',
        label: 'Learning & homework',
        icon: 'book',
        anyPermission: ['learning.view', 'learning.manage', 'learning.submit', 'learning.grade'],
      },
      {
        to: '/library',
        label: 'Library',
        icon: 'book',
        anyPermission: [
          'library.view',
          'library.manage',
          'library.circulation.manage',
          'library.settings.manage',
        ],
      },
      {
        to: '/concerns',
        label: 'Concerns & tasks',
        icon: 'clipboard',
        anyPermission: [
          'concerns.view',
          'concerns.manage',
          'concerns.assign',
          'concerns.category.manage',
        ],
      },
      {
        to: '/notifications',
        label: 'Notifications',
        icon: 'paperclip',
        anyPermission: ['notifications.view', 'notifications.manage', 'notifications.send'],
      },
    ],
  },
  {
    heading: 'Operations',
    items: [
      {
        to: '/procurement',
        label: 'Procurement',
        icon: 'layers',
        anyPermission: [
          'procurement.view',
          'procurement.request',
          'procurement.approve',
          'procurement.vendor.manage',
          'procurement.budget.manage',
          'procurement.pay',
        ],
      },
      {
        to: '/transport',
        label: 'Transport & fleet',
        icon: 'calendar',
        anyPermission: ['transport.view', 'transport.manage', 'transport.allocate'],
      },
    ],
  },
  {
    heading: 'Finance',
    items: [
      {
        to: '/fees',
        label: 'Fees',
        icon: 'clipboard',
        permission: 'fees.view',
      },
      {
        to: '/fees/controls',
        label: 'Fee controls',
        icon: 'clipboard',
        permission: 'fees.view',
      },
      {
        to: '/reports',
        label: 'Reports & exports',
        icon: 'chart',
        permission: 'reports.export',
      },
      {
        to: '/data-tools',
        label: 'Saved views & imports',
        icon: 'download',
        anyPermission: ['reports.saved.manage', 'imports.manage'],
      },
    ],
  },
  {
    heading: 'Governance',
    items: [
      { to: '/audit', label: 'Audit log', icon: 'shield', permission: 'audit.view' },
      {
        to: '/users',
        label: 'Users & roles',
        icon: 'shield',
        permission: 'access.roles.manage',
      },
      {
        to: '/safeguarding',
        label: 'Safeguarding',
        icon: 'shield',
        permission: 'safeguarding.case.view',
      },
    ],
  },
];

export function AppShell(): ReactNode {
  const { user, membership, memberships, logout, setActiveSchool } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  if (!membership || !user) return <Navigate to="/login" replace />;

  const visibleSections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) =>
        (item.permission ? membership.permissions.includes(item.permission) : true) &&
        (item.anyPermission
          ? item.anyPermission.some((permission) =>
              membership.permissions.includes(permission),
            )
          : true),
    ),
  })).filter((section) => section.items.length > 0);

  const navigation = (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
      {visibleSections.map((section) => (
        <div key={section.heading}>
          <p className="mb-1.5 px-2 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
            {section.heading}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition',
                      isActive
                        ? 'bg-brand-50 text-brand-700'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                    )
                  }
                >
                  <Icon name={item.icon} className="h-4.5 w-4.5" />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-slate-200 bg-white lg:flex">
        <BrandHeader />
        {navigation}
        <div className="border-t border-slate-100 p-3">
          <SchoolSwitcher
            memberships={memberships}
            activeSchoolId={membership.schoolId}
            onChange={setActiveSchool}
          />
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative flex h-full w-64 flex-col border-r border-slate-200 bg-white">
            <BrandHeader />
            {navigation}
            <div className="border-t border-slate-100 p-3">
              <SchoolSwitcher
                memberships={memberships}
                activeSchoolId={membership.schoolId}
                onChange={(id) => {
                  setActiveSchool(id);
                  setMobileOpen(false);
                }}
              />
            </div>
          </aside>
        </div>
      )}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
          <button
            type="button"
            className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Icon name="menu" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-900">{membership.schoolName}</p>
            <p className="truncate text-xs text-slate-500">
              {membership.roles.map(roleLabel).join(' · ') || 'No role assigned'}
            </p>
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                {initials(user.displayName)}
              </span>
              <span className="hidden max-w-40 truncate sm:block">{user.displayName}</span>
            </button>
            {menuOpen && (
              <>
                <button
                  type="button"
                  aria-label="Close menu"
                  className="fixed inset-0 z-10 cursor-default"
                  onClick={() => setMenuOpen(false)}
                />
                <div
                  role="menu"
                  className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
                >
                  <div className="border-b border-slate-100 px-3 py-2">
                    <p className="truncate text-sm font-medium text-slate-900">{user.displayName}</p>
                    <p className="truncate text-xs text-slate-500">{user.email}</p>
                  </div>
                  <NavLink
                    to="/profile"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    role="menuitem"
                  >
                    <Icon name="user" className="h-4 w-4" />
                    Profile & password
                  </NavLink>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void logout();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                  >
                    <Icon name="logout" className="h-4 w-4" />
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>

      <span className="sr-only" aria-live="polite">
        {location.pathname}
      </span>
    </div>
  );
}

function BrandHeader(): ReactNode {
  return (
    <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-4">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
        <Icon name="book" className="h-4.5 w-4.5" />
      </div>
      <div>
        <p className="text-sm font-semibold tracking-tight text-slate-900">School ERP</p>
        <p className="text-[11px] text-slate-500">Operations console</p>
      </div>
    </div>
  );
}

function SchoolSwitcher({
  memberships,
  activeSchoolId,
  onChange,
}: {
  memberships: Array<{ schoolId: string; schoolName: string; schoolCode: string }>;
  activeSchoolId: string;
  onChange: (schoolId: string) => void;
}): ReactNode {
  if (memberships.length <= 1) {
    const current = memberships[0];
    return (
      <div className="rounded-lg bg-slate-50 px-2.5 py-2">
        <p className="text-[11px] font-medium tracking-wide text-slate-400 uppercase">School</p>
        <p className="truncate text-xs font-medium text-slate-700">
          {current ? `${current.schoolName} (${current.schoolCode})` : 'No school'}
        </p>
      </div>
    );
  }

  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium tracking-wide text-slate-400 uppercase">
        School
      </span>
      <select
        className="field-input !py-1.5 text-xs"
        value={activeSchoolId}
        onChange={(event) => onChange(event.target.value)}
      >
        {memberships.map((entry) => (
          <option key={entry.schoolId} value={entry.schoolId}>
            {entry.schoolName}
          </option>
        ))}
      </select>
    </label>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}): ReactNode {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <p className="text-sm font-semibold text-slate-900">Access denied</p>
        <p className="mt-1 text-sm text-slate-500">
          Your role does not include this area. Ask a school administrator if you need access.
        </p>
      </div>
    );
  }
  return children;
}

export function RequireAnyPermission({
  permissions,
  children,
}: {
  permissions: Permission[];
  children: ReactNode;
}): ReactNode {
  const { can } = useAuth();
  if (!permissions.some((permission) => can(permission))) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <p className="text-sm font-semibold text-slate-900">Access denied</p>
        <p className="mt-1 text-sm text-slate-500">
          Your role does not include this area. Ask a school administrator if you need access.
        </p>
      </div>
    );
  }
  return children;
}
