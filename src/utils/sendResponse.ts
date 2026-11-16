import type { Response } from "express";

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface SuccessPayload<T> {
  statusCode?: number;
  message: string;
  data?: T;
  meta?: PaginationMeta;
}

/** Every successful response goes through here: { success, message, data, meta? } */
export function sendResponse<T>(res: Response, payload: SuccessPayload<T>): void {
  res.status(payload.statusCode ?? 200).json({
    success: true,
    message: payload.message,
    ...(payload.meta ? { meta: payload.meta } : {}),
    data: payload.data ?? null,
  });
}
