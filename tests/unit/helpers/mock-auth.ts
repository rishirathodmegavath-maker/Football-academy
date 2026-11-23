// Test double for "@/server/auth" used by the API harness. Better Auth is not
// started; the caller is resolved from an `x-test-user` header so route handlers
// still run their real membership, role, module and record-scope checks.
export class WorkspaceError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers: Record<string, string> = {},
    public code?: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}
export interface TestUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  image: null;
  twoFactorEnabled: boolean;
}
const users = new Map<string, TestUser>();
export function registerTestUser(id: string, name: string): TestUser {
  const user: TestUser = {
    id,
    name,
    email: `${id}@example.test`,
    emailVerified: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    image: null,
    twoFactorEnabled: false,
  };
  users.set(id, user);
  return user;
}
export async function authenticatedUser(headers: Headers) {
  const user = users.get(headers.get("x-test-user") ?? "");
  if (!user)
    throw new WorkspaceError(401, "Sign in to access academy workspaces.");
  return user;
}
export async function authentication(): Promise<never> {
  throw new Error("Better Auth is not started in API harness tests.");
}
