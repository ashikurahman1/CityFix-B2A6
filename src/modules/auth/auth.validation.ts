import { z } from "zod";

const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password must be at most 72 characters")
  .regex(/[A-Za-z]/, "Password must contain a letter")
  .regex(/[0-9]/, "Password must contain a number");

const email = z.string().trim().toLowerCase().pipe(z.email("Invalid email address"));

export const registerSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80),
  email,
  password,
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{7,15}$/, "Invalid phone number")
    .optional(),
  address: z.string().trim().max(255).optional(),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required"),
});

export const googleLoginSchema = z.object({
  idToken: z.string().min(10, "Google idToken is required"),
});

export const googleCallbackQuery = z.object({
  code: z.string().min(1, "Missing authorization code"),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10, "refreshToken is required"),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().optional(),
    newPassword: password,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ["newPassword"],
    message: "New password must be different from the current password",
  });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
