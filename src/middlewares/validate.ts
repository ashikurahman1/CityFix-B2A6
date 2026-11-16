import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Validates and normalises request input with Zod.
 * - body   -> replaces req.body with the parsed (stripped + coerced) value
 * - params -> replaces req.params
 * - query  -> stored on res.locals.query (req.query is read-only in Express 5)
 * A ZodError is thrown on failure and formatted by the global error handler.
 */
export function validate(schemas: Schemas) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (schemas.params) req.params = schemas.params.parse(req.params) as Request["params"];
    if (schemas.query) res.locals.query = schemas.query.parse(req.query);
    if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
    next();
  };
}
