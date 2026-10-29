import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button, EmptyState } from '../components/ui';

export function NotFoundPage(): ReactNode {
  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <EmptyState
        title="Page not found"
        description="The address does not match a page in this workspace. It may have moved, or the link may be out of date."
        icon="search"
        action={
          <Link to="/">
            <Button size="sm">Back to overview</Button>
          </Link>
        }
      />
    </div>
  );
}
