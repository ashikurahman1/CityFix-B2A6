import { ComplaintStatus, Priority, RequestType } from "@prisma/client";
import { z } from "zod";
import { booleanQuery, paginationQuery, sortOrderQuery } from "../../utils/pagination";

export const idParam = z.object({ id: z.uuid("Invalid complaint id") });
export const trackingParam = z.object({
  trackingCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^CF-\d{6}-[A-Z0-9]{6}$/, "Invalid tracking code"),
});

const content = {
  title: z.string().trim().min(5, "Title must be at least 5 characters").max(150),
  description: z.string().trim().min(10, "Description must be at least 10 characters").max(2000),
  address: z.string().trim().min(5, "Address must be at least 5 characters").max(255),
  ward: z.string().trim().min(1).max(50),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
};

const coordinatesTogether = (v: { latitude?: number; longitude?: number }) =>
  (v.latitude === undefined) === (v.longitude === undefined);
const coordinatesError = { path: ["latitude"], message: "latitude and longitude must be provided together" };

export const createComplaintSchema = z
  .object({
    title: content.title,
    description: content.description,
    categoryId: z.uuid("Invalid categoryId"),
    priority: z.enum(Priority).default("MEDIUM"),
    address: content.address,
    ward: content.ward.optional(),
    latitude: content.latitude.optional(),
    longitude: content.longitude.optional(),
  })
  .refine(coordinatesTogether, coordinatesError);

export const updateComplaintSchema = z
  .object({ ...content, priority: z.enum(Priority) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update" })
  .refine(coordinatesTogether, coordinatesError);

export const listComplaintQuery = z.object({
  ...paginationQuery,
  q: z.string().trim().min(2, "Search term must be at least 2 characters").max(100).optional(),
  status: z.enum(ComplaintStatus).optional(),
  priority: z.enum(Priority).optional(),
  type: z.enum(RequestType).optional(),
  categoryId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  assignedToId: z.uuid().optional(),
  ward: z.string().trim().max(50).optional(),
  assignedToMe: booleanQuery,
  unassigned: booleanQuery,
  overdue: booleanQuery,
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sortBy: z.enum(["createdAt", "updatedAt", "priority", "slaDueAt", "status"]).default("createdAt"),
  sortOrder: sortOrderQuery,
});

export const assignSchema = z.object({
  staffId: z.uuid("Invalid staffId"),
  note: z.string().trim().max(500).optional(),
});

export const statusSchema = z
  .object({
    status: z.enum(["IN_PROGRESS", "RESOLVED", "REJECTED", "CLOSED"]),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((v) => !["RESOLVED", "REJECTED"].includes(v.status) || (v.note?.length ?? 0) >= 5, {
    path: ["note"],
    message: "A note of at least 5 characters is required when resolving or rejecting",
  });

export const reasonSchema = z.object({
  reason: z.string().trim().min(5, "Reason must be at least 5 characters").max(500),
});

export const optionalReasonSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const feedbackSchema = z.object({
  rating: z.coerce.number().int().min(1, "Rating must be between 1 and 5").max(5, "Rating must be between 1 and 5"),
  comment: z.string().trim().max(1000).optional(),
});

export const commentSchema = z.object({
  body: z.string().trim().min(1, "Comment cannot be empty").max(1000),
  isInternal: z.boolean().default(false),
});

export type CreateComplaintInput = z.infer<typeof createComplaintSchema>;
export type UpdateComplaintInput = z.infer<typeof updateComplaintSchema>;
export type ListComplaintQuery = z.infer<typeof listComplaintQuery>;
export type AssignInput = z.infer<typeof assignSchema>;
export type StatusInput = z.infer<typeof statusSchema>;
export type FeedbackInput = z.infer<typeof feedbackSchema>;
export type CommentInput = z.infer<typeof commentSchema>;
