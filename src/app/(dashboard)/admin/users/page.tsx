import { requireRole } from "@/lib/session";
import { ADMIN_MANAGE_ROLES } from "@/lib/permissions";
import { db } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { UserCreateForm } from "@/components/admin/user-create-form";
import { UserRowActions } from "@/components/admin/user-row-actions";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

/**
 * Admin user management (/admin/users). Onboarding and offboarding for MSP
 * staff: create, change role, reset password, deactivate, reactivate.
 *
 * GATING. `requireRole(ADMIN_MANAGE_ROLES)` -- the codebase's authoritative
 * server-side role boundary, which redirects to /unauthorized for anyone else
 * and to /change-password for a caller still holding a temporary password.
 * Hiding the sidebar link is NOT authorization: a non-admin typing this URL
 * is refused here, before anything renders. (The older /admin/quickbooks page
 * open-codes getCurrentUser() + can() + manual redirects; that predates this
 * convention and is deliberately not copied.)
 *
 * WRITES. There are none in this file. Every mutation goes through 07-03's
 * Server Actions in src/lib/actions/users.ts, which re-authorize themselves
 * and own the self-target and last-active-admin guard rails. The Prisma read
 * below is exactly that -- a read.
 *
 * DEACTIVATED USERS ARE NOT FILTERED OUT. An offboarded account you cannot
 * see is one you cannot reactivate, so inactive rows stay listed, visibly
 * marked, and carry a Reactivate control. Sorted active-first. No pagination
 * and no delete control: this system is sized for well under 25 staff, and
 * offboarding is `isActive: false` because tickets, comments and time entries
 * carry billing history off these rows.
 */
export default async function AdminUsersPage() {
  const actor = await requireRole(ADMIN_MANAGE_ROLES);

  const users = await db.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      createdAt: true,
    },
    orderBy: [{ isActive: "desc" }, { email: "asc" }],
  });

  const activeCount = users.filter((user) => user.isActive).length;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Users</h1>

      <Card>
        <CardHeader>
          {/* h2: this page already has an h1, so the card titles are the
              level below it. CardTitle renders a <div> unless told otherwise,
              which is how these surfaces ended up looking like headings while
              being invisible to heading navigation. */}
          <CardTitle asChild>
            <h2>Add a user</h2>
          </CardTitle>
          <CardDescription>
            Creates the account and generates a temporary password, shown to
            you once. The new user must choose their own password before they
            can use the app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UserCreateForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle asChild>
            <h2>Staff accounts</h2>
          </CardTitle>
          <CardDescription>
            {users.length} account{users.length === 1 ? "" : "s"}, {activeCount}{" "}
            active. Deactivated accounts are kept, not deleted -- their
            tickets, comments and time entries stay intact, and access can be
            restored at any time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    No users yet.
                  </TableCell>
                </TableRow>
              ) : (
                users.map((user) => (
                  <TableRow
                    key={user.id}
                    data-testid={`user-row-${user.email}`}
                    data-active={user.isActive}
                  >
                    {/* th, not td: without a row header the per-row controls
                        are announced with no indication of WHICH account they
                        act on. `scope="row"` is what makes a screen reader
                        read this cell as the row's context. (The controls also
                        carry explicit aria-labels -- table-reading mode is not
                        the only way a user reaches them.)

                        The deactivated-row opacity-60 that used to sit on this
                        <TableRow> is gone: layered over text-muted-foreground
                        it fell below 4.5:1, and the Deactivated badge in the
                        Status cell already carries the state. data-active is
                        untouched. */}
                    <TableHead scope="row" className="font-medium">
                      {user.name ?? <span className="text-muted-foreground">--</span>}
                      {user.id === actor.id && (
                        <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                      )}
                    </TableHead>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{user.role}</Badge>
                    </TableCell>
                    <TableCell>
                      {user.isActive ? (
                        <Badge variant="outline">Active</Badge>
                      ) : (
                        <Badge variant="destructive">Deactivated</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {dateFormatter.format(user.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <UserRowActions
                        userId={user.id}
                        userEmail={user.email}
                        role={user.role}
                        isActive={user.isActive}
                        isSelf={user.id === actor.id}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
