import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type {
  LibraryBook,
  LibraryCategory,
  LibraryCopy,
  LibraryLoan,
  LibraryMember,
  LibrarySettings,
} from '@erp/shared';
import { useAuth, useSchoolId } from '../auth/AuthContext';
import {
  createLibraryBook,
  createLibraryCategory,
  createLibraryCopy,
  createLibraryFine,
  createLibraryMember,
  createLibraryReservation,
  decideLibraryFine,
  getLibrarySettings,
  issueLibraryLoan,
  listLibraryBooks,
  listLibraryCategories,
  listLibraryCopies,
  listLibraryFines,
  listLibraryLoans,
  listLibraryMembers,
  listLibraryReservations,
  listStaff,
  listStudents,
  renewLibraryLoan,
  returnLibraryLoan,
  saveLibrarySettings,
  updateLibraryBook,
  updateLibraryMember,
  updateLibraryReservation,
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
  StatCard,
  TableSkeleton,
  Textarea,
} from '../components/ui';

type Tab = 'catalogue' | 'members' | 'circulation' | 'fines' | 'reservations' | 'settings';

const BOOK_STATUSES = ['active', 'inactive'] as const;
const MEMBER_STATUSES = ['active', 'suspended', 'inactive'] as const;
const RESERVATION_STATUSES = ['pending', 'ready', 'fulfilled', 'cancelled', 'expired'] as const;
const FINE_REASONS = ['overdue', 'lost', 'damaged'] as const;
const RETURN_CONDITIONS = ['ok', 'damaged', 'lost'] as const;

type DialogState =
  | { kind: 'book'; book?: LibraryBook }
  | { kind: 'copies'; book: LibraryBook }
  | { kind: 'member'; member?: LibraryMember }
  | { kind: 'loan' }
  | { kind: 'return'; loan: LibraryLoan }
  | { kind: 'fine' }
  | { kind: 'reservation' }
  | null;

export function LibraryPage(): ReactNode {
  const schoolId = useSchoolId();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canView = can('library.view');
  const canManage = can('library.manage');
  const canCirculate = can('library.circulation.manage');
  const canConfigure = can('library.settings.manage');

  const [tab, setTab] = useState<Tab>('catalogue');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [bookStatus, setBookStatus] = useState('');
  const [memberSearch, setMemberSearch] = useState('');
  const [loanFilter, setLoanFilter] = useState<'open' | 'returned' | 'all'>('open');
  const [fineStatus, setFineStatus] = useState('pending');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [formError, setFormError] = useState('');

  const categories = useQuery({
    queryKey: ['library-categories', schoolId],
    queryFn: () => listLibraryCategories(schoolId),
    enabled: canView,
  });
  const books = useQuery({
    queryKey: ['library-books', schoolId, search, categoryFilter, bookStatus],
    queryFn: () =>
      listLibraryBooks(schoolId, {
        search: search || undefined,
        categoryId: categoryFilter || undefined,
        status: bookStatus || undefined,
      }),
    enabled: canView && (tab === 'catalogue' || dialog?.kind === 'loan'),
  });
  const members = useQuery({
    queryKey: ['library-members', schoolId, memberSearch],
    queryFn: () => listLibraryMembers(schoolId, memberSearch || undefined),
    enabled: canView && (tab === 'members' || dialog?.kind === 'loan' || dialog?.kind === 'reservation'),
  });
  const loans = useQuery({
    queryKey: ['library-loans', schoolId, loanFilter],
    queryFn: () =>
      listLibraryLoans(schoolId, {
        openOnly: loanFilter === 'open' ? true : loanFilter === 'returned' ? false : undefined,
        status: loanFilter === 'returned' ? 'returned' : undefined,
      }),
    enabled: canView && (tab === 'circulation' || dialog?.kind === 'fine'),
  });
  const fines = useQuery({
    queryKey: ['library-fines', schoolId, fineStatus],
    queryFn: () => listLibraryFines(schoolId, fineStatus || undefined),
    enabled: canView && tab === 'fines',
  });
  const reservations = useQuery({
    queryKey: ['library-reservations', schoolId],
    queryFn: () => listLibraryReservations(schoolId),
    enabled: canView && tab === 'reservations',
  });
  const settings = useQuery({
    queryKey: ['library-settings', schoolId],
    queryFn: () => getLibrarySettings(schoolId),
    enabled: canView && tab === 'settings',
  });
  const copies = useQuery({
    queryKey: ['library-copies', schoolId, dialog?.kind === 'copies' ? dialog.book.id : ''],
    queryFn: () => listLibraryCopies(schoolId, dialog?.kind === 'copies' ? dialog.book.id : ''),
    enabled: canView && dialog?.kind === 'copies',
  });
  const students = useQuery({
    queryKey: ['students', schoolId, 'library-picker'],
    queryFn: () => listStudents(schoolId, { pageSize: 200 }),
    enabled: canManage && dialog?.kind === 'member',
  });
  const staff = useQuery({
    queryKey: ['staff', schoolId, 'library-picker'],
    queryFn: () => listStaff(schoolId),
    enabled: canManage && dialog?.kind === 'member',
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['library-categories', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['library-books', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['library-copies', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['library-members', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['library-loans', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['library-fines', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['library-reservations', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['library-settings', schoolId] });
  };

  const saveBook = useMutation({
    mutationFn: (input: { id?: string; body: Record<string, unknown> }) =>
      input.id
        ? updateLibraryBook(schoolId, input.id, input.body)
        : createLibraryBook(schoolId, input.body),
    onSuccess: () => {
      toast.notify('success', 'Book saved.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const saveCategory = useMutation({
    mutationFn: (input: { code: string; name: string }) => createLibraryCategory(schoolId, input),
    onSuccess: () => {
      toast.notify('success', 'Category added.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });
  const saveCopy = useMutation({
    mutationFn: (input: { bookId: string; accessionNumber: string; acquiredOn?: string }) =>
      createLibraryCopy(schoolId, input.bookId, {
        accessionNumber: input.accessionNumber,
        acquiredOn: input.acquiredOn,
      }),
    onSuccess: () => {
      toast.notify('success', 'Copy added.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });
  const saveMember = useMutation({
    mutationFn: (input: { id?: string; body: Record<string, unknown> }) =>
      input.id
        ? updateLibraryMember(schoolId, input.id, input.body)
        : createLibraryMember(schoolId, input.body as Parameters<typeof createLibraryMember>[1]),
    onSuccess: () => {
      toast.notify('success', 'Member saved.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const issue = useMutation({
    mutationFn: (input: Parameters<typeof issueLibraryLoan>[1]) => issueLibraryLoan(schoolId, input),
    onSuccess: () => {
      toast.notify('success', 'Copy issued.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const doReturn = useMutation({
    mutationFn: (input: { id: string; body: Parameters<typeof returnLibraryLoan>[2] }) =>
      returnLibraryLoan(schoolId, input.id, input.body),
    onSuccess: () => {
      toast.notify('success', 'Copy returned.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const renew = useMutation({
    mutationFn: (id: string) => renewLibraryLoan(schoolId, id),
    onSuccess: () => {
      toast.notify('success', 'Loan renewed.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });
  const saveFine = useMutation({
    mutationFn: (input: Parameters<typeof createLibraryFine>[1]) => createLibraryFine(schoolId, input),
    onSuccess: () => {
      toast.notify('success', 'Fine recorded.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const decideFine = useMutation({
    mutationFn: (input: { id: string; decision: 'pay' | 'waive' }) =>
      decideLibraryFine(schoolId, input.id, input.decision),
    onSuccess: () => {
      toast.notify('success', 'Fine updated.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });
  const saveReservation = useMutation({
    mutationFn: (input: Parameters<typeof createLibraryReservation>[1]) =>
      createLibraryReservation(schoolId, input),
    onSuccess: () => {
      toast.notify('success', 'Reservation created.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const setReservationStatus = useMutation({
    mutationFn: (input: { id: string; status: string }) =>
      updateLibraryReservation(schoolId, input.id, input.status),
    onSuccess: () => {
      toast.notify('success', 'Reservation updated.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });
  const saveSettings = useMutation({
    mutationFn: (input: LibrarySettings) => saveLibrarySettings(schoolId, input),
    onSuccess: () => {
      toast.notify('success', 'Library settings saved.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });

  const categoryOptions = categories.data?.items ?? [];
  const bookOptions = books.data?.items ?? [];
  const memberOptions = members.data?.items ?? [];

  const tabs: Array<{ value: Tab; label: string }> = [
    { value: 'catalogue', label: 'Catalogue' },
    { value: 'members', label: 'Members' },
    { value: 'circulation', label: 'Circulation' },
    { value: 'fines', label: 'Fines' },
    { value: 'reservations', label: 'Reservations' },
    ...(canConfigure ? [{ value: 'settings' as Tab, label: 'Settings' }] : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Library"
        description="Catalogue, copies, members and circulation. Loan periods, fines and borrowing limits are explicit school settings; overdue fines are assessed on return only."
        actions={
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <>
                <Button variant="secondary" onClick={() => setDialog({ kind: 'book' })}>
                  <Icon name="book" className="h-4 w-4" />
                  New book
                </Button>
                <Button onClick={() => setDialog({ kind: 'member' })}>
                  <Icon name="users" className="h-4 w-4" />
                  New member
                </Button>
              </>
            )}
            {canCirculate && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'loan' })}>
                <Icon name="check" className="h-4 w-4" />
                Issue copy
              </Button>
            )}
          </div>
        }
      />

      <Tabs value={tab} onChange={setTab} tabs={tabs} label="Library views" />

      {tab === 'catalogue' && canView && (
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Categories"
              description="Optional grouping used to filter the catalogue."
            />
            <div className="space-y-3 p-4">
              <div className="flex flex-wrap gap-2">
                {categoryOptions.length === 0 ? (
                  <p className="text-sm text-slate-500">No categories yet.</p>
                ) : (
                  categoryOptions.map((category) => (
                    <span
                      key={category.id}
                      className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700"
                    >
                      {category.name} · {category.bookCount}
                    </span>
                  ))
                )}
              </div>
              {canManage && <CategoryForm onSubmit={(input) => saveCategory.mutate(input)} saving={saveCategory.isPending} />}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Catalogue"
              description="Copies are individual accession numbers. Adding copies here is additive; editing a book never changes existing copies."
              actions={
                <div className="flex flex-wrap gap-2">
                  <Input
                    aria-label="Search catalogue"
                    placeholder="Search title, author or ISBN"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="w-56"
                  />
                  <Select
                    aria-label="Filter by category"
                    value={categoryFilter}
                    onChange={(event) => setCategoryFilter(event.target.value)}
                    className="w-44"
                  >
                    <option value="">All categories</option>
                    {categoryOptions.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label="Filter by book status"
                    value={bookStatus}
                    onChange={(event) => setBookStatus(event.target.value)}
                    className="w-36"
                  >
                    <option value="">All statuses</option>
                    {BOOK_STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                </div>
              }
            />
            {books.isPending ? (
              <TableSkeleton rows={6} columns={6} />
            ) : books.isError ? (
              <ErrorState message={errorMessage(books.error)} onRetry={() => void books.refetch()} />
            ) : bookOptions.length === 0 ? (
              <EmptyState title="No books" description="Add a book and its copies to start circulating." icon="book" />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Author</th>
                      <th>Category</th>
                      <th className="text-right">Copies</th>
                      <th className="text-right">Available</th>
                      <th>Status</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bookOptions.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <p className="font-medium text-slate-900">{row.title}</p>
                          {row.isbn && <p className="font-mono text-xs text-slate-500">{row.isbn}</p>}
                        </td>
                        <td className="text-sm text-slate-600">{row.author ?? '—'}</td>
                        <td className="text-sm text-slate-600">{row.categoryName ?? '—'}</td>
                        <td className="text-right tabular-nums">{row.totalCopies}</td>
                        <td className="text-right tabular-nums">{row.availableCopies}</td>
                        <td>
                          <Badge tone={row.status === 'active' ? 'success' : 'neutral'}>{row.status}</Badge>
                        </td>
                        <td>
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'copies', book: row })}>
                              Copies
                            </Button>
                            {canManage && (
                              <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'book', book: row })}>
                                Edit
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'members' && canView && (
        <Card>
          <CardHeader
            title="Members"
            description="Members are linked to a student or a staff record. The borrowing limit defaults from library settings."
            actions={
              <div className="flex flex-wrap gap-2">
                <Input
                  aria-label="Search members"
                  placeholder="Search name or code"
                  value={memberSearch}
                  onChange={(event) => setMemberSearch(event.target.value)}
                  className="w-52"
                />
                {canManage && (
                  <Button size="sm" onClick={() => setDialog({ kind: 'member' })}>
                    New member
                  </Button>
                )}
              </div>
            }
          />
          {members.isPending ? (
            <TableSkeleton rows={6} columns={5} />
          ) : members.isError ? (
            <ErrorState message={errorMessage(members.error)} onRetry={() => void members.refetch()} />
          ) : memberOptions.length === 0 ? (
            <EmptyState title="No members" description="Register a student or staff member to borrow books." icon="users" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Code</th>
                    <th className="text-right">Limit</th>
                    <th className="text-right">Open loans</th>
                    <th>Joined</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {memberOptions.map((row) => (
                    <tr key={row.id}>
                      <td className="font-medium text-slate-900">{row.memberName}</td>
                      <td className="font-mono text-xs">{row.memberCode}</td>
                      <td className="text-right tabular-nums">{row.borrowingLimit}</td>
                      <td className="text-right tabular-nums">{row.openLoans}</td>
                      <td>{formatDate(row.joinedOn)}</td>
                      <td>
                        <Badge tone={row.status === 'active' ? 'success' : row.status === 'suspended' ? 'danger' : 'neutral'}>
                          {row.status}
                        </Badge>
                      </td>
                      <td className="text-right">
                        {canManage && (
                          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'member', member: row })}>
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

      {tab === 'circulation' && canView && (
        <Card>
          <CardHeader
            title="Loans"
            description="A copy can only be on one open loan. Overdue fines are assessed on return when the library fine rate is configured."
            actions={
              <div className="flex flex-wrap gap-2">
                <Select
                  aria-label="Loan filter"
                  value={loanFilter}
                  onChange={(event) => setLoanFilter(event.target.value as typeof loanFilter)}
                  className="w-36"
                >
                  <option value="open">Open loans</option>
                  <option value="returned">Returned</option>
                  <option value="all">All</option>
                </Select>
                {canCirculate && (
                  <Button size="sm" onClick={() => setDialog({ kind: 'loan' })}>
                    Issue copy
                  </Button>
                )}
              </div>
            }
          />
          {loans.isPending ? (
            <TableSkeleton rows={6} columns={7} />
          ) : loans.isError ? (
            <ErrorState message={errorMessage(loans.error)} onRetry={() => void loans.refetch()} />
          ) : (loans.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="No loans" description="Issue a copy to a member." icon="book" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Book</th>
                    <th>Member</th>
                    <th>Issued</th>
                    <th>Due</th>
                    <th>Returned</th>
                    <th className="text-right">Renewals</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loans.data!.items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <p className="font-medium text-slate-900">{row.bookTitle}</p>
                        <p className="font-mono text-xs text-slate-500">{row.accessionNumber}</p>
                      </td>
                      <td className="text-sm text-slate-700">{row.memberName}</td>
                      <td>{formatDate(row.issuedOn)}</td>
                      <td>{formatDate(row.dueOn)}</td>
                      <td>{formatDate(row.returnedOn)}</td>
                      <td className="text-right tabular-nums">{row.renewedCount}</td>
                      <td>
                        <Badge tone={row.status === 'returned' ? 'success' : row.overdueDays > 0 ? 'danger' : 'warning'}>
                          {row.status === 'issued' && row.overdueDays > 0 ? `overdue ${row.overdueDays}d` : row.status}
                        </Badge>
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-2">
                          {canCirculate && row.status === 'issued' && (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'return', loan: row })}>
                                Return
                              </Button>
                              <Button size="sm" variant="ghost" loading={renew.isPending} onClick={() => renew.mutate(row.id)}>
                                Renew
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'fines' && canView && (
        <Card>
          <CardHeader
            title="Fines"
            description="Fines are recorded against a loan and settled manually as paid or waived."
            actions={
              <div className="flex flex-wrap gap-2">
                <Select
                  aria-label="Filter fines by status"
                  value={fineStatus}
                  onChange={(event) => setFineStatus(event.target.value)}
                  className="w-36"
                >
                  <option value="">All statuses</option>
                  <option value="pending">Pending</option>
                  <option value="paid">Paid</option>
                  <option value="waived">Waived</option>
                </Select>
                {canCirculate && (
                  <Button size="sm" onClick={() => setDialog({ kind: 'fine' })}>
                    Record fine
                  </Button>
                )}
              </div>
            }
          />
          {fines.isPending ? (
            <TableSkeleton rows={5} columns={6} />
          ) : fines.isError ? (
            <ErrorState message={errorMessage(fines.error)} onRetry={() => void fines.refetch()} />
          ) : (fines.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="No fines" description="Overdue or damaged loans can attract a fine." icon="alert" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Book</th>
                    <th>Reason</th>
                    <th className="text-right">Amount</th>
                    <th>Assessed</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {fines.data!.items.map((row) => (
                    <tr key={row.id}>
                      <td className="font-medium text-slate-900">{row.memberName}</td>
                      <td className="text-sm text-slate-600">{row.bookTitle}</td>
                      <td className="text-sm text-slate-600">{row.reason}</td>
                      <td className="text-right tabular-nums">{formatMoney(row.amount)}</td>
                      <td>{formatDate(row.assessedOn)}</td>
                      <td>
                        <Badge tone={row.status === 'paid' ? 'success' : row.status === 'waived' ? 'neutral' : 'warning'}>
                          {row.status}
                        </Badge>
                      </td>
                      <td>
                        {canCirculate && row.status === 'pending' && (
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button size="sm" onClick={() => decideFine.mutate({ id: row.id, decision: 'pay' })}>
                              Mark paid
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => decideFine.mutate({ id: row.id, decision: 'waive' })}>
                              Waive
                            </Button>
                          </div>
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

      {tab === 'reservations' && canView && (
        <Card>
          <CardHeader
            title="Reservations"
            description="Reservations hold a title for a member. They never allocate a specific copy automatically."
            actions={
              canCirculate ? (
                <Button size="sm" onClick={() => setDialog({ kind: 'reservation' })}>
                  New reservation
                </Button>
              ) : undefined
            }
          />
          {reservations.isPending ? (
            <TableSkeleton rows={5} columns={5} />
          ) : reservations.isError ? (
            <ErrorState message={errorMessage(reservations.error)} onRetry={() => void reservations.refetch()} />
          ) : (reservations.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="No reservations" description="Reserve a title for a member." icon="calendar" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Book</th>
                    <th>Member</th>
                    <th>Reserved</th>
                    <th>Expires</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {reservations.data!.items.map((row) => (
                    <tr key={row.id}>
                      <td className="font-medium text-slate-900">{row.bookTitle}</td>
                      <td className="text-sm text-slate-600">{row.memberName}</td>
                      <td>{formatDate(row.reservedOn)}</td>
                      <td>{formatDate(row.expiresOn)}</td>
                      <td>
                        <Badge tone={row.status === 'fulfilled' ? 'success' : row.status === 'cancelled' || row.status === 'expired' ? 'neutral' : 'warning'}>
                          {row.status}
                        </Badge>
                      </td>
                      <td>
                        {canCirculate && row.status !== 'fulfilled' && row.status !== 'cancelled' && (
                          <div className="flex flex-wrap justify-end gap-2">
                            <Select
                              aria-label={`Reservation status for ${row.bookTitle}`}
                              value={row.status}
                              onChange={(event) =>
                                setReservationStatus.mutate({ id: row.id, status: event.target.value })
                              }
                              className="w-36"
                            >
                              {RESERVATION_STATUSES.map((value) => (
                                <option key={value} value={value}>
                                  {value}
                                </option>
                              ))}
                            </Select>
                          </div>
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

      {tab === 'settings' && canConfigure && (
        <SettingsPanel
          key={settings.dataUpdatedAt}
          settings={settings.data}
          loading={settings.isPending}
          error={settings.isError ? errorMessage(settings.error) : ''}
          saving={saveSettings.isPending}
          onRetry={() => void settings.refetch()}
          onSave={(input) => saveSettings.mutate(input)}
        />
      )}

      {dialog?.kind === 'book' && (
        <BookDialog
          key={dialog.book?.id ?? 'new-book'}
          book={dialog.book}
          categories={categoryOptions}
          error={formError}
          saving={saveBook.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveBook.mutate({ id: dialog.book?.id, body })}
        />
      )}

      {dialog?.kind === 'copies' && (
        <CopiesDialog
          book={dialog.book}
          copies={copies.data?.items ?? []}
          loading={copies.isPending}
          error={copies.isError ? errorMessage(copies.error) : formError}
          saving={saveCopy.isPending}
          canManage={canManage}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onAdd={(input) => saveCopy.mutate({ ...input, bookId: dialog.book.id })}
        />
      )}

      {dialog?.kind === 'member' && (
        <MemberDialog
          key={dialog.member?.id ?? 'new-member'}
          member={dialog.member}
          students={(students.data?.items ?? []).map((student) => ({
            id: student.id,
            name: `${student.firstName} ${student.lastName ?? ''}`.trim(),
            admissionNumber: student.admissionNumber,
          }))}
          staff={(staff.data?.items ?? []).map((row) => ({ id: row.id, name: row.fullName }))}
          error={formError}
          saving={saveMember.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveMember.mutate({ id: dialog.member?.id, body })}
        />
      )}

      {dialog?.kind === 'loan' && (
        <LoanDialog
          schoolId={schoolId}
          books={bookOptions}
          members={memberOptions}
          error={formError}
          saving={issue.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => issue.mutate(body)}
        />
      )}

      {dialog?.kind === 'return' && (
        <ReturnDialog
          loan={dialog.loan}
          error={formError}
          saving={doReturn.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => doReturn.mutate({ id: dialog.loan.id, body })}
        />
      )}

      {dialog?.kind === 'fine' && (
        <FineDialog
          loans={loans.data?.items ?? []}
          error={formError}
          saving={saveFine.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveFine.mutate(body)}
        />
      )}

      {dialog?.kind === 'reservation' && (
        <ReservationDialog
          books={bookOptions}
          members={memberOptions}
          error={formError}
          saving={saveReservation.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveReservation.mutate(body)}
        />
      )}
    </div>
  );
}

function CategoryForm({
  onSubmit,
  saving,
}: {
  onSubmit: (input: { code: string; name: string }) => void;
  saving: boolean;
}): ReactNode {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ code, name });
        setCode('');
        setName('');
      }}
    >
      <Field label="Code" htmlFor="lib-cat-code" required>
        <Input
          id="lib-cat-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          pattern="[a-z0-9_-]+"
          required
          className="w-32"
        />
      </Field>
      <Field label="Name" htmlFor="lib-cat-name" required>
        <Input id="lib-cat-name" value={name} onChange={(event) => setName(event.target.value)} required className="w-52" />
      </Field>
      <Button type="submit" size="sm" loading={saving}>
        Add category
      </Button>
    </form>
  );
}

function BookDialog({
  book,
  categories,
  error,
  saving,
  onClose,
  onSave,
}: {
  book?: LibraryBook;
  categories: LibraryCategory[];
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => void;
}): ReactNode {
  const [title, setTitle] = useState(book?.title ?? '');
  const [author, setAuthor] = useState(book?.author ?? '');
  const [publisher, setPublisher] = useState(book?.publisher ?? '');
  const [isbn, setIsbn] = useState(book?.isbn ?? '');
  const [language, setLanguage] = useState(book?.language ?? '');
  const [categoryId, setCategoryId] = useState(book?.categoryId ?? '');
  const [copies, setCopies] = useState('1');
  const [status, setStatus] = useState<(typeof BOOK_STATUSES)[number]>(book?.status ?? 'active');
  const [description, setDescription] = useState(book?.description ?? '');

  return (
    <Dialog
      open
      onClose={onClose}
      title={book ? 'Edit book' : 'New book'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="book-form" loading={saving}>
            Save book
          </Button>
        </>
      }
    >
      <form
        id="book-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            title,
            author: author || undefined,
            publisher: publisher || undefined,
            isbn: isbn || undefined,
            language: language || undefined,
            categoryId: categoryId || null,
            status,
            description: description || undefined,
            ...(book ? {} : { copies: Number(copies) }),
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" htmlFor="bk-title" required>
            <Input id="bk-title" value={title} onChange={(event) => setTitle(event.target.value)} required />
          </Field>
          <Field label="Author" htmlFor="bk-author">
            <Input id="bk-author" value={author} onChange={(event) => setAuthor(event.target.value)} />
          </Field>
          <Field label="Publisher" htmlFor="bk-publisher">
            <Input id="bk-publisher" value={publisher} onChange={(event) => setPublisher(event.target.value)} />
          </Field>
          <Field label="ISBN" htmlFor="bk-isbn">
            <Input id="bk-isbn" value={isbn} onChange={(event) => setIsbn(event.target.value)} />
          </Field>
          <Field label="Language" htmlFor="bk-language">
            <Input id="bk-language" value={language} onChange={(event) => setLanguage(event.target.value)} />
          </Field>
          <Field label="Category" htmlFor="bk-category">
            <Select id="bk-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">No category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>
          {!book && (
            <Field label="Copies" htmlFor="bk-copies" hint="Accession numbers are generated automatically.">
              <Input
                id="bk-copies"
                type="number"
                min={0}
                max={500}
                value={copies}
                onChange={(event) => setCopies(event.target.value)}
              />
            </Field>
          )}
          <Field label="Status" htmlFor="bk-status">
            <Select id="bk-status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
              {BOOK_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Description" htmlFor="bk-description">
          <Textarea id="bk-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4000} />
        </Field>
      </form>
    </Dialog>
  );
}

function CopiesDialog({
  book,
  copies,
  loading,
  error,
  saving,
  canManage,
  onClose,
  onAdd,
}: {
  book: LibraryBook;
  copies: LibraryCopy[];
  loading: boolean;
  error: string;
  saving: boolean;
  canManage: boolean;
  onClose: () => void;
  onAdd: (input: { accessionNumber: string; acquiredOn?: string }) => void;
}): ReactNode {
  const [accessionNumber, setAccessionNumber] = useState('');
  const [acquiredOn, setAcquiredOn] = useState(todayIso());

  return (
    <Dialog open onClose={onClose} title={`Copies · ${book.title}`} size="lg">
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {loading ? (
          <TableSkeleton rows={4} columns={4} />
        ) : copies.length === 0 ? (
          <p className="text-sm text-slate-500">No copies recorded for this title.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Accession</th>
                  <th>Status</th>
                  <th>Acquired</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {copies.map((copy) => (
                  <tr key={copy.id}>
                    <td className="font-mono text-xs">{copy.accessionNumber}</td>
                    <td>
                      <Badge
                        tone={
                          copy.status === 'available'
                            ? 'success'
                            : copy.status === 'issued'
                              ? 'warning'
                              : copy.status === 'lost'
                                ? 'danger'
                                : 'neutral'
                        }
                      >
                        {copy.status}
                      </Badge>
                    </td>
                    <td>{formatDate(copy.acquiredOn)}</td>
                    <td className="text-sm text-slate-600">{copy.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canManage && (
          <form
            className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              onAdd({ accessionNumber, acquiredOn: acquiredOn || undefined });
              setAccessionNumber('');
            }}
          >
            <Field label="Accession number" htmlFor="cp-accession" required>
              <Input
                id="cp-accession"
                value={accessionNumber}
                onChange={(event) => setAccessionNumber(event.target.value)}
                required
                className="w-44"
              />
            </Field>
            <Field label="Acquired on" htmlFor="cp-acquired">
              <Input id="cp-acquired" type="date" value={acquiredOn} onChange={(event) => setAcquiredOn(event.target.value)} />
            </Field>
            <Button type="submit" size="sm" loading={saving}>
              Add copy
            </Button>
          </form>
        )}
      </div>
    </Dialog>
  );
}

function MemberDialog({
  member,
  students,
  staff,
  error,
  saving,
  onClose,
  onSave,
}: {
  member?: LibraryMember;
  students: Array<{ id: string; name: string; admissionNumber: string }>;
  staff: Array<{ id: string; name: string }>;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => void;
}): ReactNode {
  const [linkType, setLinkType] = useState<'student' | 'staff'>(member?.staffId ? 'staff' : 'student');
  const [studentId, setStudentId] = useState(member?.studentId ?? '');
  const [staffId, setStaffId] = useState(member?.staffId ?? '');
  const [memberCode, setMemberCode] = useState(member?.memberCode ?? '');
  const [borrowingLimit, setBorrowingLimit] = useState(String(member?.borrowingLimit ?? ''));
  const [status, setStatus] = useState<(typeof MEMBER_STATUSES)[number]>(member?.status ?? 'active');

  return (
    <Dialog
      open
      onClose={onClose}
      title={member ? 'Edit member' : 'New member'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="member-form" loading={saving}>
            Save member
          </Button>
        </>
      }
    >
      <form
        id="member-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            memberCode: memberCode || undefined,
            studentId: linkType === 'student' ? studentId || null : null,
            staffId: linkType === 'staff' ? staffId || null : null,
            borrowingLimit: borrowingLimit ? Number(borrowingLimit) : undefined,
            status,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        {!member && (
          <Field label="Link to" htmlFor="mem-type">
            <Select id="mem-type" value={linkType} onChange={(event) => setLinkType(event.target.value as typeof linkType)}>
              <option value="student">Student</option>
              <option value="staff">Staff member</option>
            </Select>
          </Field>
        )}
        {linkType === 'student' ? (
          <Field label="Student" htmlFor="mem-student" required>
            <Select id="mem-student" value={studentId} onChange={(event) => setStudentId(event.target.value)} required>
              <option value="">Select student</option>
              {students.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.name} · {student.admissionNumber}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Staff member" htmlFor="mem-staff" required>
            <Select id="mem-staff" value={staffId} onChange={(event) => setStaffId(event.target.value)} required>
              <option value="">Select staff member</option>
              {staff.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Member code" htmlFor="mem-code" hint="Generated automatically when blank.">
            <Input id="mem-code" value={memberCode} onChange={(event) => setMemberCode(event.target.value)} />
          </Field>
          <Field label="Borrowing limit" htmlFor="mem-limit" hint="Blank uses the library default.">
            <Input
              id="mem-limit"
              type="number"
              min={1}
              max={50}
              value={borrowingLimit}
              onChange={(event) => setBorrowingLimit(event.target.value)}
            />
          </Field>
          <Field label="Status" htmlFor="mem-status">
            <Select id="mem-status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
              {MEMBER_STATUSES.map((value) => (
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

function LoanDialog({
  schoolId,
  books,
  members,
  error,
  saving,
  onClose,
  onSave,
}: {
  schoolId: string;
  books: LibraryBook[];
  members: LibraryMember[];
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: { copyId: string; memberId: string; dueOn?: string }) => void;
}): ReactNode {
  const [bookId, setBookId] = useState('');
  const [copyId, setCopyId] = useState('');
  const [memberId, setMemberId] = useState('');
  const [dueOn, setDueOn] = useState('');
  const bookCopies = useQuery({
    queryKey: ['library-copies', schoolId, bookId],
    queryFn: () => listLibraryCopies(schoolId, bookId),
    enabled: Boolean(bookId),
  });
  const copies = bookCopies.data?.items ?? [];
  const availableCopies = copies.filter((copy) => copy.status === 'available');

  return (
    <Dialog
      open
      onClose={onClose}
      title="Issue a copy"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="loan-form" loading={saving}>
            Issue copy
          </Button>
        </>
      }
    >
      <form
        id="loan-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ copyId, memberId, dueOn: dueOn || undefined });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Book" htmlFor="loan-book" required>
          <Select
            id="loan-book"
            value={bookId}
            onChange={(event) => {
              setBookId(event.target.value);
              setCopyId('');
            }}
            required
          >
            <option value="">Select book</option>
            {books.map((book) => (
              <option key={book.id} value={book.id}>
                {book.title} · {book.availableCopies} available
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Copy"
          htmlFor="loan-copy"
          required
          hint={bookId ? 'Only available copies can be issued.' : 'Choose a book first.'}
        >
          <Select
            id="loan-copy"
            value={copyId}
            onChange={(event) => setCopyId(event.target.value)}
            required
            disabled={!bookId}
          >
            <option value="">{bookId ? 'Select copy' : 'Select book first'}</option>
            {availableCopies.map((copy) => (
              <option key={copy.id} value={copy.id}>
                {copy.accessionNumber}
              </option>
            ))}
          </Select>
        </Field>
        {bookId && availableCopies.length === 0 && (
          <Alert tone="warning">No available copies for this title. Collect a return or add a copy first.</Alert>
        )}
        <Field label="Member" htmlFor="loan-member" required>
          <Select id="loan-member" value={memberId} onChange={(event) => setMemberId(event.target.value)} required>
            <option value="">Select member</option>
            {members.map((row) => (
              <option key={row.id} value={row.id}>
                {row.memberName} · {row.memberCode} ({row.openLoans}/{row.borrowingLimit})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Due on" htmlFor="loan-due" hint="Blank uses the configured loan period.">
          <Input id="loan-due" type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

function ReturnDialog({
  loan,
  error,
  saving,
  onClose,
  onSave,
}: {
  loan: LibraryLoan;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: { returnedOn?: string; condition?: string; notes?: string }) => void;
}): ReactNode {
  const [returnedOn, setReturnedOn] = useState(todayIso());
  const [condition, setCondition] = useState<(typeof RETURN_CONDITIONS)[number]>('ok');
  const [notes, setNotes] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Return · ${loan.bookTitle}`}
      description={`${loan.memberName} · ${loan.accessionNumber}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="return-form" loading={saving}>
            Record return
          </Button>
        </>
      }
    >
      <form
        id="return-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ returnedOn, condition, notes: notes || undefined });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Returned on" htmlFor="ret-date">
            <Input id="ret-date" type="date" value={returnedOn} onChange={(event) => setReturnedOn(event.target.value)} />
          </Field>
          <Field label="Condition" htmlFor="ret-condition">
            <Select id="ret-condition" value={condition} onChange={(event) => setCondition(event.target.value as typeof condition)}>
              {RETURN_CONDITIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Notes" htmlFor="ret-notes">
          <Textarea id="ret-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={500} />
        </Field>
      </form>
    </Dialog>
  );
}

function FineDialog({
  loans,
  error,
  saving,
  onClose,
  onSave,
}: {
  loans: LibraryLoan[];
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: { loanId: string; amount: number; reason: 'overdue' | 'lost' | 'damaged'; notes?: string }) => void;
}): ReactNode {
  const [loanId, setLoanId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<(typeof FINE_REASONS)[number]>('overdue');
  const [notes, setNotes] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title="Record fine"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="fine-form" loading={saving}>
            Record fine
          </Button>
        </>
      }
    >
      <form
        id="fine-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ loanId, amount: Number(amount), reason, notes: notes || undefined });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Loan" htmlFor="fine-loan" required>
          <Select id="fine-loan" value={loanId} onChange={(event) => setLoanId(event.target.value)} required>
            <option value="">Select loan</option>
            {loans.map((loan) => (
              <option key={loan.id} value={loan.id}>
                {loan.memberName} · {loan.bookTitle} · {loan.accessionNumber}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount" htmlFor="fine-amount" required>
            <Input
              id="fine-amount"
              type="number"
              min={0.01}
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </Field>
          <Field label="Reason" htmlFor="fine-reason">
            <Select id="fine-reason" value={reason} onChange={(event) => setReason(event.target.value as typeof reason)}>
              {FINE_REASONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Notes" htmlFor="fine-notes">
          <Textarea id="fine-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={500} />
        </Field>
      </form>
    </Dialog>
  );
}

function ReservationDialog({
  books,
  members,
  error,
  saving,
  onClose,
  onSave,
}: {
  books: LibraryBook[];
  members: LibraryMember[];
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: { bookId: string; memberId: string; expiresOn?: string | null }) => void;
}): ReactNode {
  const [bookId, setBookId] = useState('');
  const [memberId, setMemberId] = useState('');
  const [expiresOn, setExpiresOn] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title="New reservation"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="reservation-form" loading={saving}>
            Reserve
          </Button>
        </>
      }
    >
      <form
        id="reservation-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ bookId, memberId, expiresOn: expiresOn || null });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Book" htmlFor="res-book" required>
          <Select id="res-book" value={bookId} onChange={(event) => setBookId(event.target.value)} required>
            <option value="">Select book</option>
            {books.map((book) => (
              <option key={book.id} value={book.id}>
                {book.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Member" htmlFor="res-member" required>
          <Select id="res-member" value={memberId} onChange={(event) => setMemberId(event.target.value)} required>
            <option value="">Select member</option>
            {members.map((row) => (
              <option key={row.id} value={row.id}>
                {row.memberName} · {row.memberCode}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Expires on" htmlFor="res-expires">
          <Input id="res-expires" type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

function SettingsPanel({
  settings,
  loading,
  error,
  saving,
  onRetry,
  onSave,
}: {
  settings: LibrarySettings | undefined;
  loading: boolean;
  error: string;
  saving: boolean;
  onRetry: () => void;
  onSave: (input: LibrarySettings) => void;
}): ReactNode {
  const [loanDays, setLoanDays] = useState(String(settings?.loanDays ?? 14));
  const [finePerDay, setFinePerDay] = useState(String(settings?.finePerDay ?? 1));
  const [maxRenewals, setMaxRenewals] = useState(String(settings?.maxRenewals ?? 1));
  const [defaultBorrowingLimit, setDefaultBorrowingLimit] = useState(
    String(settings?.defaultBorrowingLimit ?? 3),
  );

  return (
    <Card>
      <CardHeader
        title="Library settings"
        description="These values are explicit school configuration. Loan periods and fine rates are provisional until the client confirms them."
      />
      {loading ? (
        <TableSkeleton rows={4} columns={2} />
      ) : error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : (
        <div className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <StatCard label="Loan period" value={`${loanDays} days`} />
            <StatCard label="Fine per day" value={formatMoney(Number(finePerDay) || 0)} />
            <StatCard label="Renewals" value={maxRenewals} />
            <StatCard label="Borrowing limit" value={defaultBorrowingLimit} />
          </div>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSave({
                loanDays: Number(loanDays),
                finePerDay: Number(finePerDay),
                maxRenewals: Number(maxRenewals),
                defaultBorrowingLimit: Number(defaultBorrowingLimit),
              });
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Loan days" htmlFor="set-loan-days" required>
                <Input
                  id="set-loan-days"
                  type="number"
                  min={1}
                  max={365}
                  value={loanDays}
                  onChange={(event) => setLoanDays(event.target.value)}
                  required
                />
              </Field>
              <Field label="Fine per day" htmlFor="set-fine" required>
                <Input
                  id="set-fine"
                  type="number"
                  min={0}
                  step="0.01"
                  value={finePerDay}
                  onChange={(event) => setFinePerDay(event.target.value)}
                  required
                />
              </Field>
              <Field label="Max renewals" htmlFor="set-renewals" required>
                <Input
                  id="set-renewals"
                  type="number"
                  min={0}
                  max={10}
                  value={maxRenewals}
                  onChange={(event) => setMaxRenewals(event.target.value)}
                  required
                />
              </Field>
              <Field label="Default borrowing limit" htmlFor="set-limit" required>
                <Input
                  id="set-limit"
                  type="number"
                  min={1}
                  max={50}
                  value={defaultBorrowingLimit}
                  onChange={(event) => setDefaultBorrowingLimit(event.target.value)}
                  required
                />
              </Field>
            </div>
            <div className="flex justify-end">
              <Button type="submit" loading={saving}>
                Save settings
              </Button>
            </div>
          </form>
        </div>
      )}
    </Card>
  );
}
