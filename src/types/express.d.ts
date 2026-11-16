import type { Role } from "@prisma/client";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  departmentId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      /** Set by the `authenticate` middleware. */
      user?: AuthUser;
    }
  }
}
